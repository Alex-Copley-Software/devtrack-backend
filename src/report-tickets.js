// report-tickets.js
// Bug reports that come in as Ticket Tool tickets (text channels named
// test-game-0001 / live-game-0001) rather than forum threads. The report
// itself is an ordinary Report whose discordThreadId is the ticket channel;
// this table holds what is specific to the ticket: its number, whether it is
// a test or live game ticket, and how and when it was closed, with the
// transcript link for the audit trail.

// Loaded on first use so tests can swap it out without a database client.
let log = entry => require('./history-logger').log(entry);
const setLogger = fn => { log = fn; };

const MAX_CLOSE_ATTEMPTS = 3;
const CLOSE_STATUSES = ['resolved', 'declined'];

class TicketError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ready = new WeakSet();
async function ensureTables(prisma) {
  if (ready.has(prisma)) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ReportTicket" (
      "reportId" TEXT NOT NULL PRIMARY KEY,
      "channelId" TEXT NOT NULL UNIQUE,
      "kind" TEXT NOT NULL,
      "number" INTEGER,
      "name" TEXT NOT NULL,
      "openerId" TEXT,
      "state" TEXT NOT NULL DEFAULT 'open',
      "closeMethod" TEXT,
      "closeAttempts" INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT,
      "transcriptUrl" TEXT,
      "transcriptFileUrl" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "closedAt" TIMESTAMP(3)
    )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReportTicket_kind_number_idx" ON "ReportTicket" ("kind", "number")`);
  ready.add(prisma);
}

// The ticket on a report, as a column for the report queries.
const TICKET_COLUMN = `(
  SELECT jsonb_build_object('name', t.name, 'kind', t.kind, 'number', t.number, 'state', t.state,
    'closeMethod', t."closeMethod", 'closedAt', t."closedAt", 'transcriptUrl', t."transcriptUrl", 'lastError', t."lastError")
  FROM "ReportTicket" t WHERE t."reportId" = r.id
) AS "ticket"`;

const FIELDS = `t."reportId", t."channelId", t.kind, t.number, t.name, t."openerId", t.state, t."closeMethod",
  t."closeAttempts", t."lastError", t."transcriptUrl", t."transcriptFileUrl", t."createdAt", t."closedAt"`;

const kindOf = v => (String(v || '').toLowerCase() === 'live' ? 'live' : 'test');
const numberOf = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

async function byChannel(prisma, channelId) {
  await ensureTables(prisma);
  const rows = await prisma.$queryRawUnsafe(`SELECT ${FIELDS} FROM "ReportTicket" t WHERE t."channelId" = $1`, String(channelId));
  return rows[0] || null;
}

// Called by the bot once a ticket has a report. Safe to repeat.
async function register(prisma, { reportId, channelId, kind, number, name, openerId }) {
  await ensureTables(prisma);
  if (!reportId || !channelId || !name) throw new TicketError(400, 'reportId, channelId and name are required');
  const exists = await prisma.$queryRawUnsafe(`SELECT id FROM "Report" WHERE id = $1`, reportId);
  if (!exists.length) throw new TicketError(404, 'Report not found');
  const before = await byChannel(prisma, channelId);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "ReportTicket" ("reportId", "channelId", kind, number, name, "openerId")
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT ("reportId") DO UPDATE SET "openerId" = COALESCE("ReportTicket"."openerId", EXCLUDED."openerId")`,
    reportId, String(channelId), kindOf(kind), numberOf(number), String(name), openerId || null);
  if (!before) {
    await log({ reportId, action: 'ticket_opened', detail: String(name), actorName: 'Ticket Tool', actorId: openerId || '' });
  }
  return byChannel(prisma, channelId);
}

// Tickets whose report has been finished for at least delayMs and that are
// still open in Discord. The bot closes these.
async function pendingClose(prisma, { delayMs = 0, statuses = CLOSE_STATUSES } = {}) {
  await ensureTables(prisma);
  const wanted = (Array.isArray(statuses) ? statuses : String(statuses).split(','))
    .map(s => String(s).trim()).filter(s => CLOSE_STATUSES.includes(s));
  if (!wanted.length) return [];
  const delay = Math.max(0, Math.min(Number(delayMs) || 0, 7 * 24 * 60 * 60 * 1000));
  return prisma.$queryRawUnsafe(`
    SELECT ${FIELDS}, r.title, r.status::text AS status, r."discordUserId", r."discordUser"
    FROM "ReportTicket" t JOIN "Report" r ON r.id = t."reportId"
    WHERE t.state <> 'closed' AND t."closeAttempts" < ${MAX_CLOSE_ATTEMPTS}
      AND r.status::text = ANY($1::text[])
      AND r."updatedAt" <= NOW() - ($2::bigint * INTERVAL '1 millisecond')
    ORDER BY r."updatedAt" ASC LIMIT 20`, wanted, Math.round(delay));
}

const METHOD_TEXT = {
  ticket_tool: 'deleted by Ticket Tool',
  devtrack: 'transcribed and deleted by DevTrack (Ticket Tool did not act on $delete)',
  manual: 'deleted in Discord',
  already_deleted: 'already gone from Discord',
};

async function markClosed(prisma, channelId, { method } = {}) {
  const ticket = await byChannel(prisma, channelId);
  if (!ticket) throw new TicketError(404, 'Ticket not found');
  if (ticket.state === 'closed') return ticket;
  const how = METHOD_TEXT[method] ? method : 'manual';
  await prisma.$executeRawUnsafe(`
    UPDATE "ReportTicket" SET state = 'closed', "closeMethod" = $2, "closedAt" = CURRENT_TIMESTAMP, "lastError" = NULL
    WHERE "channelId" = $1`, String(channelId), how);
  await log({
    reportId: ticket.reportId, action: 'ticket_closed',
    detail: `${ticket.name}: ${METHOD_TEXT[how]}${ticket.transcriptUrl ? `. Transcript: ${ticket.transcriptUrl}` : ''}`,
    actorName: how === 'manual' ? 'Discord' : 'DevTrack bot', actorId: '',
  });
  return byChannel(prisma, channelId);
}

// A close attempt did not finish. After MAX_CLOSE_ATTEMPTS the bot stops trying and it is left to staff.
async function closeFailed(prisma, channelId, error) {
  const ticket = await byChannel(prisma, channelId);
  if (!ticket) throw new TicketError(404, 'Ticket not found');
  const attempts = ticket.closeAttempts + 1;
  const message = String(error || 'Unknown error').slice(0, 500);
  await prisma.$executeRawUnsafe(`UPDATE "ReportTicket" SET "closeAttempts" = $2, "lastError" = $3 WHERE "channelId" = $1`,
    String(channelId), attempts, message);
  if (attempts >= MAX_CLOSE_ATTEMPTS) {
    await log({ reportId: ticket.reportId, action: 'ticket_close_failed', detail: `${ticket.name}: ${message}`, actorName: 'DevTrack bot', actorId: '' });
  }
  return { ...ticket, closeAttempts: attempts, lastError: message, gaveUp: attempts >= MAX_CLOSE_ATTEMPTS };
}

// A transcript was posted in a transcripts channel. Matched by ticket channel
// when the bot knows it, else by the ticket number it carries.
async function attachTranscript(prisma, { channelId, kind, number, url, fileUrl }) {
  await ensureTables(prisma);
  if (!url) throw new TicketError(400, 'url is required');
  let ticket = channelId ? await byChannel(prisma, channelId) : null;
  if (!ticket && numberOf(number) !== null) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${FIELDS} FROM "ReportTicket" t WHERE t.kind = $1 AND t.number = $2 ORDER BY t."createdAt" DESC LIMIT 1`,
      kindOf(kind), numberOf(number));
    ticket = rows[0] || null;
  }
  if (!ticket) throw new TicketError(404, 'No ticket matches that transcript');
  if (ticket.transcriptUrl === url) return ticket;
  await prisma.$executeRawUnsafe(`UPDATE "ReportTicket" SET "transcriptUrl" = $2, "transcriptFileUrl" = $3 WHERE "reportId" = $1`,
    ticket.reportId, String(url), fileUrl || null);
  await log({ reportId: ticket.reportId, action: 'ticket_transcript', detail: `${ticket.name}: ${url}`, actorName: 'DevTrack bot', actorId: '' });
  return byChannel(prisma, ticket.channelId);
}

module.exports = {
  TicketError, TICKET_COLUMN, setLogger, MAX_CLOSE_ATTEMPTS, CLOSE_STATUSES,
  ensureTables, byChannel, register, pendingClose, markClosed, closeFailed, attachTranscript,
};
