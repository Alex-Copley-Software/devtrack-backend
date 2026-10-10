// tester-pay.js
// Two linked features for the bug-report side of DevTrack:
//
//   Tester QA   when a report goes to QA Review, the tester who filed it is
//               asked in their own thread to confirm the fix (with a video)
//               and click Fixed or Not fixed. Every check is kept.
//   Payouts     pay periods and a price per accepted report (by bug level)
//               and per fix a tester confirmed, so what each tester is owed
//               for a period is one query.
//
// Tables are created on first use, like the rest of the codebase. Every
// function takes the Prisma client so tests can run against PGlite.

const crypto = require('crypto');

const BUG_LEVELS = ['insignificant', 'minor', 'moderate', 'major'];
const CHECK_STATUSES = ['pending', 'fixed', 'not_fixed', 'staff_approved', 'cancelled'];

const DEFAULTS = {
  // Price per accepted report, by bug level, and per fix a tester confirmed.
  rates: { insignificant: 0, minor: 0, moderate: 0, major: 0, verifiedFix: 0 },
  currency: '$',
  // Ask the original reporter to confirm fixes in their thread.
  testerQaEnabled: true,
  // "Fixed" needs a video (or other attachment / link) posted in the thread first.
  requireVideo: true,
  // A tester's "Fixed" resolves the report straight away. Off: it waits in
  // Tester Approved for staff to resolve.
  autoResolve: false,
  // A credited co-finder is paid for the report as well as the reporter.
  payCredited: true,
};

const ready = new WeakSet();
async function ensureTables(prisma) {
  if (ready.has(prisma)) return;
  // Set while a report sits in In Progress because it came back from QA Review (see tester-qa.js).
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "qaFailedAt" TIMESTAMP(3)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "qaFailedBy" TEXT`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TesterPaySetting" (
      "key" TEXT NOT NULL PRIMARY KEY,
      "value" JSONB NOT NULL,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "TesterPayPeriod" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL,
      "startsOn" DATE NOT NULL,
      "endsOn" DATE NOT NULL,
      "notes" TEXT,
      "paidAt" TIMESTAMP(3),
      "paidByName" TEXT,
      "snapshot" JSONB,
      "createdByName" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ReportQaCheck" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "reportId" TEXT NOT NULL,
      "discordUserId" TEXT NOT NULL,
      "discordUser" TEXT,
      "threadId" TEXT NOT NULL,
      "messageId" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "note" TEXT,
      "videoUrl" TEXT,
      "resolvedByName" TEXT,
      "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "respondedAt" TIMESTAMP(3)
    )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReportQaCheck_reportId_idx" ON "ReportQaCheck"("reportId", "requestedAt")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReportQaCheck_status_idx" ON "ReportQaCheck"("status", "respondedAt")`);
  // The summary reads these; they are added elsewhere only when credit is first used.
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "creditedDiscordUserId" TEXT`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "creditedDiscordUser" TEXT`);
  ready.add(prisma);
}

// ── settings ─────────────────────────────────────────────────────────────────

const money = n => Math.round((Number(n) || 0) * 100) / 100;
function normalize(raw = {}) {
  const rates = {};
  for (const key of Object.keys(DEFAULTS.rates)) {
    const n = Number(raw.rates?.[key]);
    rates[key] = Number.isFinite(n) && n >= 0 ? money(Math.min(n, 1000000)) : DEFAULTS.rates[key];
  }
  const flag = key => (typeof raw[key] === 'boolean' ? raw[key] : DEFAULTS[key]);
  return {
    rates,
    currency: String(raw.currency ?? DEFAULTS.currency).trim().slice(0, 8) || DEFAULTS.currency,
    testerQaEnabled: flag('testerQaEnabled'),
    requireVideo: flag('requireVideo'),
    autoResolve: flag('autoResolve'),
    payCredited: flag('payCredited'),
  };
}

async function getSettings(prisma) {
  await ensureTables(prisma);
  const rows = await prisma.$queryRawUnsafe(`SELECT "value" FROM "TesterPaySetting" WHERE "key" = 'settings'`);
  return normalize(rows[0]?.value || {});
}

async function saveSettings(prisma, patch = {}) {
  const current = await getSettings(prisma);
  const next = normalize({ ...current, ...patch, rates: { ...current.rates, ...(patch.rates || {}) } });
  await prisma.$executeRawUnsafe(`
    INSERT INTO "TesterPaySetting" ("key", "value") VALUES ('settings', $1::jsonb)
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
  `, JSON.stringify(next));
  return next;
}

// ── pay periods ──────────────────────────────────────────────────────────────

class PayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const PERIOD_FIELDS = `id, name, to_char("startsOn", 'YYYY-MM-DD') AS "startsOn", to_char("endsOn", 'YYYY-MM-DD') AS "endsOn",
  notes, "paidAt", "paidByName", "createdByName", "createdAt"`;

function periodInput(data, { partial = false } = {}) {
  const out = {};
  if (!partial || data.name !== undefined) {
    out.name = String(data.name || '').trim().slice(0, 120);
    if (!out.name) throw new PayError(400, 'Give the period a name');
  }
  for (const key of ['startsOn', 'endsOn']) {
    if (!partial || data[key] !== undefined) {
      if (!isDate(data[key])) throw new PayError(400, 'Start and end must be dates');
      out[key] = data[key];
    }
  }
  if (data.notes !== undefined) out.notes = String(data.notes || '').trim().slice(0, 1000) || null;
  return out;
}

async function listPeriods(prisma) {
  await ensureTables(prisma);
  return prisma.$queryRawUnsafe(`SELECT ${PERIOD_FIELDS} FROM "TesterPayPeriod" ORDER BY "startsOn" DESC, "createdAt" DESC`);
}

async function getPeriod(prisma, id, { withSnapshot = false } = {}) {
  await ensureTables(prisma);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${PERIOD_FIELDS}${withSnapshot ? ', snapshot' : ''} FROM "TesterPayPeriod" WHERE id = $1`, id);
  if (!rows.length) throw new PayError(404, 'Pay period not found');
  return rows[0];
}

async function createPeriod(prisma, data, actorName) {
  await ensureTables(prisma);
  const f = periodInput(data);
  if (f.endsOn < f.startsOn) throw new PayError(400, 'The end date is before the start date');
  const id = crypto.randomUUID();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "TesterPayPeriod" ("id", "name", "startsOn", "endsOn", "notes", "createdByName")
    VALUES ($1, $2, $3::date, $4::date, $5, $6)`, id, f.name, f.startsOn, f.endsOn, f.notes || null, actorName || null);
  return getPeriod(prisma, id);
}

async function updatePeriod(prisma, id, data) {
  const existing = await getPeriod(prisma, id);
  if (existing.paidAt) throw new PayError(409, 'This period is marked paid. Reopen it before changing it.');
  const f = { ...existing, ...periodInput(data, { partial: true }) };
  if (f.endsOn < f.startsOn) throw new PayError(400, 'The end date is before the start date');
  await prisma.$executeRawUnsafe(`
    UPDATE "TesterPayPeriod" SET name = $2, "startsOn" = $3::date, "endsOn" = $4::date, notes = $5 WHERE id = $1`,
  id, f.name, f.startsOn, f.endsOn, f.notes || null);
  return getPeriod(prisma, id);
}

async function deletePeriod(prisma, id) {
  const existing = await getPeriod(prisma, id);
  if (existing.paidAt) throw new PayError(409, 'This period is marked paid. Reopen it before deleting it.');
  await prisma.$executeRawUnsafe(`DELETE FROM "TesterPayPeriod" WHERE id = $1`, id);
}

// Freezes the numbers: a paid period keeps showing what was actually paid,
// even if rates change or a report is re-levelled afterwards.
async function markPaid(prisma, id, actorName) {
  const period = await getPeriod(prisma, id);
  if (period.paidAt) throw new PayError(409, 'Already marked paid');
  const snapshot = await summarize(prisma, { from: period.startsOn, to: period.endsOn });
  await prisma.$executeRawUnsafe(`
    UPDATE "TesterPayPeriod" SET "paidAt" = CURRENT_TIMESTAMP, "paidByName" = $2, snapshot = $3::jsonb WHERE id = $1`,
  id, actorName || null, JSON.stringify(snapshot));
  return getPeriod(prisma, id);
}

async function reopenPeriod(prisma, id) {
  await getPeriod(prisma, id);
  await prisma.$executeRawUnsafe(`UPDATE "TesterPayPeriod" SET "paidAt" = NULL, "paidByName" = NULL, snapshot = NULL WHERE id = $1`, id);
  return getPeriod(prisma, id);
}

// ── what is owed ─────────────────────────────────────────────────────────────

// from / to are calendar dates (UTC), both included.
//
// A report counts in the period it was accepted in, not the one it was filed
// in, and only while it is still accepted: a report declined later drops
// out. Bugs and crashes only. A confirmed fix counts in the period the
// tester confirmed it, once per report.
async function summarize(prisma, { from, to }) {
  if (!isDate(from) || !isDate(to)) throw new PayError(400, 'Give a start and an end date');
  if (to < from) throw new PayError(400, 'The end date is before the start date');
  const settings = await getSettings(prisma);
  const { rates } = settings;

  const reports = await prisma.$queryRawUnsafe(`
    SELECT * FROM (
      SELECT r.id, r.title, r.type::text AS type, r."bugLevel"::text AS "bugLevel", r.status::text AS status,
        r."discordUserId", r."discordUser", r."creditedDiscordUserId", r."creditedDiscordUser",
        COALESCE((SELECT MIN(h."createdAt") FROM "ReportHistory" h WHERE h."reportId" = r.id AND h.action = 'Report accepted'), r."createdAt") AS "acceptedAt"
      FROM "Report" r
      WHERE r.type::text IN ('bug', 'crash') AND r.queued = false AND r.status::text <> 'declined'
    ) x
    WHERE x."acceptedAt" >= $1::date AND x."acceptedAt" < ($2::date + 1)
    ORDER BY x."acceptedAt"`, from, to);

  const fixes = await prisma.$queryRawUnsafe(`
    SELECT * FROM (
      SELECT DISTINCT ON (c."reportId") c.id, c."reportId", c."discordUserId", c."discordUser", c."videoUrl", c."respondedAt", r.title,
        r."bugLevel"::text AS "bugLevel"
      FROM "ReportQaCheck" c JOIN "Report" r ON r.id = c."reportId"
      WHERE c.status = 'fixed'
      ORDER BY c."reportId", c."respondedAt"
    ) x
    WHERE x."respondedAt" >= $1::date AND x."respondedAt" < ($2::date + 1)
    ORDER BY x."respondedAt"`, from, to);

  const testers = new Map();
  const tester = (id, name) => {
    const key = id || `name:${String(name || 'Unknown').toLowerCase()}`;
    if (!testers.has(key)) {
      testers.set(key, {
        key, discordUserId: id || null, name: name || 'Unknown',
        levels: Object.fromEntries(BUG_LEVELS.map(l => [l, 0])), noLevel: 0, credited: 0, reports: 0,
        verifiedFixes: 0, reportsAmount: 0, fixesAmount: 0, total: 0,
      });
    }
    const t = testers.get(key);
    if (name && t.name === 'Unknown') t.name = name;
    return t;
  };
  const count = (t, report, asCredit) => {
    const level = BUG_LEVELS.includes(report.bugLevel) ? report.bugLevel : null;
    if (level) t.levels[level]++; else t.noLevel++;
    t.reports++;
    if (asCredit) t.credited++;
    t.reportsAmount = money(t.reportsAmount + (level ? rates[level] : 0));
  };

  for (const r of reports) {
    count(tester(r.discordUserId, r.discordUser), r, false);
    const hasCredit = r.creditedDiscordUserId || r.creditedDiscordUser;
    const sameAsReporter = r.creditedDiscordUserId && r.creditedDiscordUserId === r.discordUserId;
    if (settings.payCredited && hasCredit && !sameAsReporter) count(tester(r.creditedDiscordUserId, r.creditedDiscordUser), r, true);
  }
  for (const f of fixes) {
    const t = tester(f.discordUserId, f.discordUser);
    t.verifiedFixes++;
    t.fixesAmount = money(t.fixesAmount + rates.verifiedFix);
  }

  const rows = [...testers.values()].map(t => ({ ...t, total: money(t.reportsAmount + t.fixesAmount) }))
    .sort((a, b) => b.total - a.total || b.reports - a.reports || a.name.localeCompare(b.name));
  return {
    from, to, settings,
    testers: rows,
    totals: {
      testers: rows.length,
      reports: reports.length,
      verifiedFixes: fixes.length,
      reportsAmount: money(rows.reduce((n, t) => n + t.reportsAmount, 0)),
      fixesAmount: money(rows.reduce((n, t) => n + t.fixesAmount, 0)),
      total: money(rows.reduce((n, t) => n + t.total, 0)),
    },
    reports,
    fixes,
    generatedAt: new Date().toISOString(),
  };
}

// A period's numbers: frozen if it was marked paid, live otherwise.
async function periodSummary(prisma, id) {
  const period = await getPeriod(prisma, id, { withSnapshot: true });
  const { snapshot, ...rest } = period;
  if (period.paidAt && snapshot) return { period: rest, frozen: true, ...snapshot };
  return { period: rest, frozen: false, ...(await summarize(prisma, { from: period.startsOn, to: period.endsOn })) };
}

// ── tester QA checks ─────────────────────────────────────────────────────────

const CHECK_FIELDS = `c.id, c."reportId", c."discordUserId", c."discordUser", c."threadId", c."messageId", c.status, c.note,
  c."videoUrl", c."resolvedByName", c."requestedAt", c."respondedAt"`;

async function getCheck(prisma, id) {
  await ensureTables(prisma);
  const rows = await prisma.$queryRawUnsafe(`SELECT ${CHECK_FIELDS} FROM "ReportQaCheck" c WHERE c.id = $1`, id);
  return rows[0] || null;
}

async function pendingCheck(prisma, reportId) {
  await ensureTables(prisma);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${CHECK_FIELDS} FROM "ReportQaCheck" c WHERE c."reportId" = $1 AND c.status = 'pending' ORDER BY c."requestedAt" DESC LIMIT 1`, reportId);
  return rows[0] || null;
}

async function listChecks(prisma, { status, from, to, limit = 300 } = {}) {
  await ensureTables(prisma);
  const where = [];
  const values = [];
  if (CHECK_STATUSES.includes(status)) { values.push(status); where.push(`c.status = $${values.length}`); }
  if (isDate(from)) { values.push(from); where.push(`COALESCE(c."respondedAt", c."requestedAt") >= $${values.length}::date`); }
  if (isDate(to)) { values.push(to); where.push(`COALESCE(c."respondedAt", c."requestedAt") < ($${values.length}::date + 1)`); }
  return prisma.$queryRawUnsafe(`
    SELECT ${CHECK_FIELDS}, r.title, r."bugLevel"::text AS "bugLevel", r.status::text AS "reportStatus"
    FROM "ReportQaCheck" c JOIN "Report" r ON r.id = c."reportId"
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(c."respondedAt", c."requestedAt") DESC
    LIMIT ${Math.min(1000, Math.max(1, Number(limit) || 300))}`, ...values);
}

// Called when a report's status changes. Returns what the bot should do in
// the reporter's thread, or null:
//   { kind: 'ask', check }                    the report went to QA Review
//   { kind: 'close', check, state, actor }    it left QA Review before the tester answered
async function onStatusChange(prisma, report, previousStatus, actorName) {
  await ensureTables(prisma);
  const status = report.status;
  if (status === previousStatus) return null;

  if (status === 'reviewing') {
    const settings = await getSettings(prisma);
    if (!settings.testerQaEnabled) return null;
    if (!['bug', 'crash'].includes(report.type) || !report.discordThreadId || !report.discordUserId) return null;
    await prisma.$executeRawUnsafe(
      `UPDATE "ReportQaCheck" SET status = 'cancelled', "respondedAt" = CURRENT_TIMESTAMP WHERE "reportId" = $1 AND status = 'pending'`, report.id);
    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ReportQaCheck" ("id", "reportId", "discordUserId", "discordUser", "threadId")
      VALUES ($1, $2, $3, $4, $5)`, id, report.id, report.discordUserId, report.discordUser || null, report.discordThreadId);
    return { kind: 'ask', check: await getCheck(prisma, id), requireVideo: settings.requireVideo };
  }

  if (previousStatus === 'reviewing') {
    const check = await pendingCheck(prisma, report.id);
    if (!check) return null;
    // Staff resolving it first counts as approval; anything else withdraws the request.
    const state = status === 'resolved' ? 'staff_approved' : 'cancelled';
    await prisma.$executeRawUnsafe(
      `UPDATE "ReportQaCheck" SET status = $2, "resolvedByName" = $3, "respondedAt" = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'pending'`,
      check.id, state, actorName || null);
    return { kind: 'close', check: await getCheck(prisma, check.id), state, actor: actorName || null };
  }
  return null;
}

// The tester's answer. Only the person who filed the report can give it, once.
async function respond(prisma, checkId, { discordUserId, verdict, note, videoUrl }) {
  const check = await getCheck(prisma, checkId);
  if (!check) throw new PayError(404, 'That QA check no longer exists.');
  if (String(discordUserId) !== check.discordUserId) throw new PayError(403, 'Only the tester who filed this report can confirm the fix.');
  if (!['fixed', 'not_fixed'].includes(verdict)) throw new PayError(400, 'Unknown answer');
  const settings = await getSettings(prisma);
  const video = String(videoUrl || '').trim().slice(0, 1000) || null;
  const text = String(note || '').trim().slice(0, 1000) || null;
  if (verdict === 'not_fixed' && !text) throw new PayError(400, 'Say what is still happening.');
  // Either answer needs proof posted here first: a video or a photo (the setting keeps its old name).
  if (settings.requireVideo && !video) {
    throw new PayError(400, verdict === 'fixed'
      ? 'Post a video or photo showing the fix here first, then press Fixed.'
      : 'Post a video or photo showing it still happening here first, then press Not fixed.');
  }
  const claimed = await prisma.$executeRawUnsafe(`
    UPDATE "ReportQaCheck" SET status = $2, note = $3, "videoUrl" = $4, "respondedAt" = CURRENT_TIMESTAMP
    WHERE id = $1 AND status = 'pending'`, checkId, verdict, text, video);
  if (!claimed) {
    const said = { fixed: 'already confirmed as fixed', not_fixed: 'already reported as not fixed', staff_approved: 'already approved by staff', cancelled: 'no longer waiting on a check' };
    throw new PayError(409, `This fix was ${said[check.status] || 'already answered'}.`);
  }
  return { check: await getCheck(prisma, checkId), settings };
}

module.exports = {
  BUG_LEVELS, DEFAULTS, PayError, ensureTables,
  getSettings, saveSettings,
  listPeriods, getPeriod, createPeriod, updatePeriod, deletePeriod, markPaid, reopenPeriod,
  summarize, periodSummary,
  getCheck, pendingCheck, listChecks, onStatusChange, respond,
};
