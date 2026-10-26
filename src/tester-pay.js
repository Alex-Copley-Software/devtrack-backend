// tester-pay.js
// Two linked features for the bug-report side of DevTrack:
//
//   Tester QA   when a report goes to QA Review, the tester who filed it is
//               asked in their own thread to confirm the fix (with a video)
//               and click Fixed or Not fixed. Every check is kept. One left
//               unanswered is opened up in QA Requests, where anyone can
//               take it and answer it in that thread instead.
//   Teams       the reporter can add the people who helped find a bug (a
//               multiplayer bug needs more than one player); the report's
//               pay is split between them instead of paid to each.
//   Payouts     pay periods and a price per accepted report (by bug level),
//               per fix a tester confirmed, and per report QA staff approved
//               on the dashboard, so what everyone is owed for a period is one query.
//
// Tables are created on first use, like the rest of the codebase. Every
// function takes the Prisma client so tests can run against PGlite.

const crypto = require('crypto');

const BUG_LEVELS = ['insignificant', 'minor', 'moderate', 'major'];
const CHECK_STATUSES = ['pending', 'fixed', 'not_fixed', 'staff_approved', 'cancelled'];

const DEFAULTS = {
  // Price per accepted report, by bug level, and per confirmed fix. A report
  // QA staff approve (resolve) on the dashboard is paid the same as a fix.
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
  // Minutes a check waits on the reporter before it opens up in QA Requests. 0: never.
  qaEscalateMinutes: 30,
};

const MAX_ESCALATE_MINUTES = 24 * 60;

// Dashboard roles paid for QA approvals (the same roles that must attach proof).
const QA_STAFF_ROLES = ['qa', 'reviewer'];

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
  // Opened up in QA Requests, who took it there, and who answered (the reporter or whoever took it).
  for (const column of ['"escalatedAt" TIMESTAMP(3)', '"escalationChannelId" TEXT', '"escalationMessageId" TEXT',
    '"takenByDiscordUserId" TEXT', '"takenBy" TEXT', '"takenAt" TIMESTAMP(3)', '"answeredByDiscordUserId" TEXT', '"answeredBy" TEXT']) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "ReportQaCheck" ADD COLUMN IF NOT EXISTS ${column}`);
  }
  // Teammates the reporter added with /team; the report's pay is split between them and the reporter.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ReportTeammate" (
      "reportId" TEXT NOT NULL,
      "discordUserId" TEXT NOT NULL,
      "discordUser" TEXT,
      "addedBy" TEXT,
      "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("reportId", "discordUserId")
    )`);
  // The summary looks reports up in the history by action (accepted, resolved); the table had no index.
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ReportHistory_action_report_idx" ON "ReportHistory"("action", "reportId", "createdAt")`);
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
    qaEscalateMinutes: escalateMinutes(raw.qaEscalateMinutes),
  };
}

// Whole minutes from 0 to a day; anything else keeps the default.
function escalateMinutes(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_ESCALATE_MINUTES ? n : DEFAULTS.qaEscalateMinutes;
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

// ── teams ────────────────────────────────────────────────────────────────────

// Up to this many people besides the reporter; a report split further than
// that is worth little to anyone.
const MAX_TEAMMATES = 5;

async function listTeam(prisma, reportId) {
  await ensureTables(prisma);
  return prisma.$queryRawUnsafe(
    `SELECT "discordUserId", "discordUser", "addedBy", "addedAt" FROM "ReportTeammate" WHERE "reportId" = $1 ORDER BY "addedAt"`, reportId);
}

async function addTeammate(prisma, reportId, { discordUserId, discordUser, addedBy }) {
  await ensureTables(prisma);
  const rows = await prisma.$queryRawUnsafe(`SELECT id, type::text AS type, "discordUserId" FROM "Report" WHERE id = $1`, reportId);
  if (!rows.length) throw new PayError(404, 'No DevTrack report found for this post.');
  if (!['bug', 'crash'].includes(rows[0].type)) throw new PayError(400, 'Only bug reports have teams.');
  const who = String(discordUserId || '');
  if (!who) throw new PayError(400, 'Say who to add.');
  if (who === rows[0].discordUserId) throw new PayError(400, 'That is the reporter, who is on the team already.');
  const team = await listTeam(prisma, reportId);
  if (team.some(m => m.discordUserId === who)) throw new PayError(409, 'They are on this report\'s team already.');
  if (team.length >= MAX_TEAMMATES) throw new PayError(400, `A report can have up to ${MAX_TEAMMATES} teammates besides the reporter.`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "ReportTeammate" ("reportId", "discordUserId", "discordUser", "addedBy") VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING`, reportId, who, String(discordUser || '').slice(0, 100) || null, String(addedBy || '').slice(0, 100) || null);
  return listTeam(prisma, reportId);
}

async function removeTeammate(prisma, reportId, discordUserId) {
  await ensureTables(prisma);
  const removed = await prisma.$executeRawUnsafe(
    `DELETE FROM "ReportTeammate" WHERE "reportId" = $1 AND "discordUserId" = $2`, reportId, String(discordUserId || ''));
  if (!removed) throw new PayError(404, 'They are not on this report\'s team.');
  return listTeam(prisma, reportId);
}

// An amount split n ways to the cent; the first shares take any odd cents,
// so the shares always add up to the amount.
function splitAmount(amount, n) {
  const cents = Math.round((Number(amount) || 0) * 100);
  const base = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => (base + (i < cents - base * n ? 1 : 0)) / 100);
}

// ── what is owed ─────────────────────────────────────────────────────────────

// from / to are calendar dates (UTC), both included.
//
// A report counts in the period it was accepted in, not the one it was filed
// in, and only while it is still accepted: a report declined later drops
// out. Bugs and crashes only. A confirmed fix counts in the period the
// tester confirmed it, once per report, and is paid to whoever did the
// check: the reporter, or the person who took it in QA Requests. A report
// with a team is split evenly between the reporter and the teammates.
async function summarize(prisma, { from, to }) {
  if (!isDate(from) || !isDate(to)) throw new PayError(400, 'Give a start and an end date');
  if (to < from) throw new PayError(400, 'The end date is before the start date');
  const settings = await getSettings(prisma);
  const { rates } = settings;

  // The accepted dates in one pass over the history, not one lookup per report.
  const reports = await prisma.$queryRawUnsafe(`
    WITH accepted AS (
      SELECT h."reportId", MIN(h."createdAt") AS at FROM "ReportHistory" h WHERE h.action = 'Report accepted' GROUP BY h."reportId"
    )
    SELECT * FROM (
      SELECT r.id, r.title, r.type::text AS type, r."bugLevel"::text AS "bugLevel", r.status::text AS status,
        r."discordUserId", r."discordUser", r."creditedDiscordUserId", r."creditedDiscordUser",
        COALESCE(a.at, r."createdAt") AS "acceptedAt"
      FROM "Report" r LEFT JOIN accepted a ON a."reportId" = r.id
      WHERE r.type::text IN ('bug', 'crash') AND r.queued = false AND r.status::text <> 'declined'
    ) x
    WHERE x."acceptedAt" >= $1::date AND x."acceptedAt" < ($2::date + 1)
    ORDER BY x."acceptedAt"`, from, to);

  const teams = new Map();
  if (reports.length) {
    const members = await prisma.$queryRawUnsafe(
      `SELECT "reportId", "discordUserId", "discordUser" FROM "ReportTeammate" WHERE "reportId" = ANY($1::text[]) ORDER BY "addedAt"`,
      reports.map(r => r.id));
    for (const m of members) {
      if (!teams.has(m.reportId)) teams.set(m.reportId, []);
      teams.get(m.reportId).push({ discordUserId: m.discordUserId, discordUser: m.discordUser });
    }
  }

  const fixes = await prisma.$queryRawUnsafe(`
    SELECT * FROM (
      SELECT DISTINCT ON (c."reportId") c.id, c."reportId", COALESCE(c."answeredByDiscordUserId", c."discordUserId") AS "discordUserId",
        COALESCE(c."answeredBy", c."discordUser") AS "discordUser", c."videoUrl", c."respondedAt", r.title,
        r."bugLevel"::text AS "bugLevel"
      FROM "ReportQaCheck" c JOIN "Report" r ON r.id = c."reportId"
      WHERE c.status = 'fixed'
      ORDER BY c."reportId", c."respondedAt"
    ) x
    WHERE x."respondedAt" >= $1::date AND x."respondedAt" < ($2::date + 1)
    ORDER BY x."respondedAt"`, from, to);

  // QA staff approvals: the first time a QA or reviewer account resolved each
  // report on the dashboard. Read from the report history, so approvals made
  // before this was added count too.
  const qaApprovals = await prisma.$queryRawUnsafe(`
    SELECT * FROM (
      SELECT DISTINCT ON (h."reportId") h."reportId", h."actorId" AS "userId", COALESCE(u.name, h."actorName") AS name,
        u.role AS role, h."createdAt" AS "approvedAt", r.title, r."bugLevel"::text AS "bugLevel"
      FROM "ReportHistory" h
      JOIN "User" u ON u.id = h."actorId"
      JOIN "Report" r ON r.id = h."reportId"
      WHERE h.action = 'Marked as Resolved' AND u.role = ANY($3::text[]) AND r.status::text <> 'declined'
      ORDER BY h."reportId", h."createdAt"
    ) x
    WHERE x."approvedAt" >= $1::date AND x."approvedAt" < ($2::date + 1)
    ORDER BY x."approvedAt"`, from, to, QA_STAFF_ROLES);

  const staff = new Map();
  for (const a of qaApprovals) {
    if (!staff.has(a.userId)) staff.set(a.userId, { key: `user:${a.userId}`, userId: a.userId, name: a.name, role: a.role, approvals: 0, amount: 0 });
    const m = staff.get(a.userId);
    m.approvals++;
    m.amount = money(m.amount + rates.verifiedFix);
  }
  const qaStaff = [...staff.values()].sort((a, b) => b.amount - a.amount || b.approvals - a.approvals || a.name.localeCompare(b.name));
  const qaAmount = money(qaStaff.reduce((n, m) => n + m.amount, 0));

  const testers = new Map();
  const tester = (id, name) => {
    const key = id || `name:${String(name || 'Unknown').toLowerCase()}`;
    if (!testers.has(key)) {
      testers.set(key, {
        key, discordUserId: id || null, name: name || 'Unknown',
        levels: Object.fromEntries(BUG_LEVELS.map(l => [l, 0])), noLevel: 0, credited: 0, shared: 0, reports: 0,
        verifiedFixes: 0, reportsAmount: 0, fixesAmount: 0, total: 0,
      });
    }
    const t = testers.get(key);
    if (name && t.name === 'Unknown') t.name = name;
    return t;
  };
  const levelOf = report => (BUG_LEVELS.includes(report.bugLevel) ? report.bugLevel : null);
  const count = (t, report, { asCredit = false, shared = false, amount }) => {
    const level = levelOf(report);
    if (level) t.levels[level]++; else t.noLevel++;
    t.reports++;
    if (asCredit) t.credited++;
    if (shared) t.shared++;
    t.reportsAmount = money(t.reportsAmount + amount);
  };

  for (const r of reports) {
    const price = levelOf(r) ? rates[levelOf(r)] : 0;
    const team = teams.get(r.id) || [];
    const shares = splitAmount(price, team.length + 1);
    r.team = team.map((m, i) => ({ ...m, share: shares[i + 1] }));
    r.share = shares[0];
    count(tester(r.discordUserId, r.discordUser), r, { shared: team.length > 0, amount: shares[0] });
    team.forEach((m, i) => count(tester(m.discordUserId, m.discordUser), r, { shared: true, amount: shares[i + 1] }));
    // A credited co-finder is paid in full on top, unless they are on the team and already have a share.
    const hasCredit = r.creditedDiscordUserId || r.creditedDiscordUser;
    const alreadyPaid = r.creditedDiscordUserId && (r.creditedDiscordUserId === r.discordUserId || team.some(m => m.discordUserId === r.creditedDiscordUserId));
    if (settings.payCredited && hasCredit && !alreadyPaid) count(tester(r.creditedDiscordUserId, r.creditedDiscordUser), r, { asCredit: true, amount: price });
  }
  for (const f of fixes) {
    const t = tester(f.discordUserId, f.discordUser);
    t.verifiedFixes++;
    t.fixesAmount = money(t.fixesAmount + rates.verifiedFix);
  }

  const rows = [...testers.values()].map(t => ({ ...t, total: money(t.reportsAmount + t.fixesAmount) }))
    .sort((a, b) => b.total - a.total || b.reports - a.reports || a.name.localeCompare(b.name));
  const testersTotal = money(rows.reduce((n, t) => n + t.total, 0));
  return {
    from, to, settings,
    testers: rows,
    qaStaff,
    totals: {
      testers: rows.length,
      reports: reports.length,
      verifiedFixes: fixes.length,
      reportsAmount: money(rows.reduce((n, t) => n + t.reportsAmount, 0)),
      fixesAmount: money(rows.reduce((n, t) => n + t.fixesAmount, 0)),
      qaStaff: qaStaff.length,
      qaApprovals: qaApprovals.length,
      qaAmount,
      total: money(testersTotal + qaAmount),
    },
    reports,
    fixes,
    qaApprovals,
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

// One tester's own numbers, for /leaderboard in Discord (only they see it),
// for the pay period set up on the payouts page that covers today: what they
// filed in it and how that went, what was accepted, what it earns (what was
// paid, if the period is marked paid) and where they rank among the testers
// in it. With no period covering today, it is everything since the last paid
// period ended, or all time if there are no periods. Paid so far is all time.
async function testerStats(prisma, discordUserId, { today = new Date().toISOString().slice(0, 10) } = {}) {
  await ensureTables(prisma);
  const who = String(discordUserId || '');
  const periods = await prisma.$queryRawUnsafe(`SELECT ${PERIOD_FIELDS}, snapshot FROM "TesterPayPeriod" ORDER BY "startsOn", "createdAt"`);

  // The open period wins when a paid one overlaps today too; then the latest start.
  const current = periods.filter(p => p.startsOn <= today && today <= p.endsOn)
    .sort((a, b) => Number(!a.paidAt) - Number(!b.paidAt) || a.startsOn.localeCompare(b.startsOn)).pop() || null;
  const lastPaidEnd = periods.filter(p => p.paidAt && p.endsOn < today).map(p => p.endsOn).sort().pop() || null;
  const dayAfter = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const range = current ? { from: current.startsOn, to: current.endsOn }
    : lastPaidEnd ? { from: dayAfter(lastPaidEnd), to: today }
      : { from: '2000-01-01', to: today };

  const summary = current?.paidAt && current.snapshot ? current.snapshot : await summarize(prisma, range);
  const me = summary.testers.find(t => t.discordUserId === who) || null;
  const rank = me && me.reports ? 1 + summary.testers.filter(t => t.reports > me.reports).length : null;

  const [filed] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE queued)::int AS queued,
      COUNT(*) FILTER (WHERE NOT queued AND status::text NOT IN ('declined', 'resolved'))::int AS active,
      COUNT(*) FILTER (WHERE NOT queued AND status::text = 'resolved')::int AS resolved,
      COUNT(*) FILTER (WHERE status::text = 'declined')::int AS declined
    FROM "Report" WHERE "discordUserId" = $1 AND type::text IN ('bug', 'crash')
      AND "createdAt" >= $2::date AND "createdAt" < ($3::date + 1)`, who, range.from, range.to);

  let paid = 0;
  let paidPeriods = 0;
  for (const p of periods) {
    const row = p.paidAt && (p.snapshot?.testers || []).find(t => t.discordUserId === who);
    if (row?.total) { paid = money(paid + row.total); paidPeriods++; }
  }

  return {
    currency: (summary.settings || await getSettings(prisma)).currency,
    period: current ? { name: current.name, startsOn: current.startsOn, endsOn: current.endsOn, paid: !!current.paidAt } : null,
    from: range.from === '2000-01-01' ? null : range.from, to: range.to,
    filed,
    accepted: me ? me.reports : 0,
    levels: me ? me.levels : Object.fromEntries(BUG_LEVELS.map(l => [l, 0])),
    noLevel: me ? me.noLevel : 0,
    shared: me ? me.shared || 0 : 0,
    credited: me ? me.credited || 0 : 0,
    verifiedFixes: me ? me.verifiedFixes : 0,
    earned: me ? me.total : 0,
    paid, paidPeriods,
    rank, testers: summary.testers.filter(t => t.reports > 0).length,
  };
}

// ── tester QA checks ─────────────────────────────────────────────────────────

const CHECK_FIELDS = `c.id, c."reportId", c."discordUserId", c."discordUser", c."threadId", c."messageId", c.status, c.note,
  c."videoUrl", c."resolvedByName", c."requestedAt", c."respondedAt", c."escalatedAt", c."escalationChannelId", c."escalationMessageId",
  c."takenByDiscordUserId", c."takenBy", c."takenAt", c."answeredByDiscordUserId", c."answeredBy"`;

// How long a check taken in QA Requests stays with the person who took it.
const TAKE_MINUTES = 30;

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
    return { kind: 'ask', check: await getCheck(prisma, id), requireVideo: settings.requireVideo, escalateMinutes: settings.qaEscalateMinutes };
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

// ── QA Requests: checks the reporter left unanswered ─────────────────────────

// Checks still waiting on the reporter qaEscalateMinutes after they were
// asked, not yet opened up. Tickets are left out: they are private, so
// nobody else could post proof in them. Changing the setting applies to
// checks already waiting too.
async function dueForEscalation(prisma) {
  const minutes = (await getSettings(prisma)).qaEscalateMinutes;
  if (!minutes) return { minutes, checks: [] };
  await require('./report-tickets').ensureTables(prisma);
  const checks = await prisma.$queryRawUnsafe(`
    SELECT ${CHECK_FIELDS}, r.title, r."bugLevel"::text AS "bugLevel"
    FROM "ReportQaCheck" c JOIN "Report" r ON r.id = c."reportId"
    WHERE c.status = 'pending' AND c."messageId" IS NOT NULL AND c."escalatedAt" IS NULL
      AND c."requestedAt" < NOW() - ($1 * INTERVAL '1 minute')
      AND NOT EXISTS (SELECT 1 FROM "ReportTicket" t WHERE t."reportId" = c."reportId")
    ORDER BY c."requestedAt"
    LIMIT 20`, minutes);
  return { minutes, checks };
}

// The bot posted it in QA Requests.
async function markEscalated(prisma, checkId, { channelId, messageId }) {
  await ensureTables(prisma);
  await prisma.$executeRawUnsafe(`
    UPDATE "ReportQaCheck" SET "escalatedAt" = CURRENT_TIMESTAMP, "escalationChannelId" = $2, "escalationMessageId" = $3
    WHERE id = $1 AND "escalatedAt" IS NULL`, checkId, String(channelId || ''), String(messageId || ''));
  return getCheck(prisma, checkId);
}

// Someone pressed Take this check in QA Requests. It is theirs for
// TAKE_MINUTES, and nobody else can take it until that runs out, not even the
// reporter. After it, anyone can take it, the reporter and the last holder
// included, so a check nobody finishes does not stay stuck.
// One QA Request at a time: nobody can take another while they hold one,
// until they answer it or their time on it runs out. Checks on their own
// reports, before those are opened up, do not count.
async function take(prisma, checkId, { discordUserId, discordUserName }) {
  const check = await getCheck(prisma, checkId);
  if (!check) throw new PayError(404, 'That QA check no longer exists.');
  if (check.status !== 'pending') throw new PayError(409, 'This check has already been answered.');
  if (!check.escalatedAt) throw new PayError(409, 'This check is still waiting on the tester who filed the report.');
  const who = String(discordUserId);
  if (heldBy(check) === who) throw new PayError(409, `This check is already yours until ${clock(holdEnds(check))} UTC. Answer it in the report's post.`);
  const refuseSecond = held => new PayError(409, `You already have a QA Request: **${held.title || 'a report'}** <#${held.threadId}>, until ${clock(holdEnds(held))} UTC. `
    + 'Answer that one first (or wait for your time on it to run out), then you can take another.');
  const held = await heldCheck(prisma, who, checkId);
  if (held) throw refuseSecond(held);
  const taken = await prisma.$executeRawUnsafe(`
    UPDATE "ReportQaCheck" SET "takenByDiscordUserId" = $2, "takenBy" = $3, "takenAt" = CURRENT_TIMESTAMP
    WHERE id = $1 AND status = 'pending' AND ("takenByDiscordUserId" IS NULL OR "takenAt" < NOW() - ($4 * INTERVAL '1 minute'))
      AND NOT EXISTS (SELECT 1 FROM "ReportQaCheck" o WHERE o.id <> $1 AND o.status = 'pending' AND o."escalatedAt" IS NOT NULL
        AND o."takenByDiscordUserId" = $2 AND o."takenAt" >= NOW() - ($4 * INTERVAL '1 minute'))`,
    checkId, who, String(discordUserName || '').slice(0, 100) || null, TAKE_MINUTES);
  if (!taken) {
    const now = await getCheck(prisma, checkId);
    if (now?.status !== 'pending') throw new PayError(409, 'This check has already been answered.');
    const other = await heldCheck(prisma, who, checkId);
    if (other) throw refuseSecond(other);
    throw new PayError(409, `${now.takenBy || 'Someone'} is checking this until ${clock(holdEnds(now))} UTC. If they have not answered by then, you can take it.`);
  }
  return getCheck(prisma, checkId);
}

// The QA Request this person holds right now, other than exceptId, or null.
async function heldCheck(prisma, discordUserId, exceptId = '') {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT ${CHECK_FIELDS}, r.title FROM "ReportQaCheck" c JOIN "Report" r ON r.id = c."reportId"
    WHERE c.id <> $2 AND c.status = 'pending' AND c."escalatedAt" IS NOT NULL
      AND c."takenByDiscordUserId" = $1 AND c."takenAt" >= NOW() - ($3 * INTERVAL '1 minute')
    ORDER BY c."takenAt" DESC LIMIT 1`, String(discordUserId), String(exceptId), TAKE_MINUTES);
  return rows[0] || null;
}

// Hands every QA Request back: nobody holds one, and anyone can take them
// again. With once, only the first call with that key does anything, so a
// release run when the bot starts happens one time only. Returns the checks
// released, each with whether its hold was still running.
async function releaseClaims(prisma, { once } = {}) {
  await ensureTables(prisma);
  if (once) {
    const first = await prisma.$executeRawUnsafe(`
      INSERT INTO "TesterPaySetting" ("key", "value") VALUES ($1, $2::jsonb) ON CONFLICT ("key") DO NOTHING`,
    `release-claims:${once}`, JSON.stringify({ at: new Date().toISOString() }));
    if (!first) return { released: [], skipped: true };
  }
  const released = await prisma.$queryRawUnsafe(`
    UPDATE "ReportQaCheck" c SET "takenByDiscordUserId" = NULL, "takenBy" = NULL, "takenAt" = NULL
    FROM (SELECT id, "takenByDiscordUserId" AS holder, "takenAt" >= NOW() - ($1 * INTERVAL '1 minute') AS active
          FROM "ReportQaCheck" WHERE status = 'pending' AND "takenByDiscordUserId" IS NOT NULL) old
    WHERE c.id = old.id
    RETURNING c.id, c."reportId", c."threadId", c."escalationChannelId", c."escalationMessageId", old.holder, old.active`, TAKE_MINUTES);
  return { released, skipped: false };
}

// Who holds a check taken in QA Requests right now: the last person to take
// it, until TAKE_MINUTES after they took it. Null once that runs out.
const holdEnds = check => new Date(new Date(check.takenAt).getTime() + TAKE_MINUTES * 60000);
const heldBy = (check, now = new Date()) =>
  (check.takenByDiscordUserId && check.takenAt && holdEnds(check) > now ? check.takenByDiscordUserId : null);
const clock = date => date.toISOString().slice(11, 16);

// Why this person cannot answer the check, or null if they can. Before the
// check is opened up only the reporter can. Once it is open in QA Requests
// only whoever holds it can; the reporter too has to press Take this check.
function answerRefusal(check, discordUserId, now = new Date()) {
  if (!check) return 'That QA check no longer exists.';
  const who = String(discordUserId);
  if (!check.escalatedAt) return who === check.discordUserId ? null : 'Only the tester who filed this report can confirm the fix.';
  const holder = heldBy(check, now);
  if (holder === who) return null;
  if (holder) return `${check.takenBy || 'Someone else'} has taken this check in QA Requests and has it until ${clock(holdEnds(check))} UTC.`;
  if (who === check.takenByDiscordUserId) return 'Your time on this check ran out. Press Take this check in QA Requests again to get it back.';
  return 'This check is open in QA Requests: press Take this check there first, then answer it here.';
}

// The answer, once. Before the check is opened up, from the person who filed
// the report; after, from whoever holds it in QA Requests.
async function respond(prisma, checkId, { discordUserId, discordUserName, verdict, note, videoUrl }) {
  const check = await getCheck(prisma, checkId);
  if (!check) throw new PayError(404, 'That QA check no longer exists.');
  const who = String(discordUserId);
  if (check.status === 'pending') {
    const refusal = answerRefusal(check, who);
    if (refusal) throw new PayError(403, refusal);
  }
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
    UPDATE "ReportQaCheck" SET status = $2, note = $3, "videoUrl" = $4, "respondedAt" = CURRENT_TIMESTAMP,
      "answeredByDiscordUserId" = $5, "answeredBy" = $6
    WHERE id = $1 AND status = 'pending' AND (("escalatedAt" IS NULL AND $5 = "discordUserId")
      OR ("escalatedAt" IS NOT NULL AND $5 = "takenByDiscordUserId" AND "takenAt" >= NOW() - ($7 * INTERVAL '1 minute')))`,
    checkId, verdict, text, video, who, String(discordUserName || '').slice(0, 100) || (who === check.discordUserId ? check.discordUser : check.takenBy), TAKE_MINUTES);
  if (!claimed) {
    const now = await getCheck(prisma, checkId);
    if (now?.status === 'pending') throw new PayError(409, answerRefusal(now, who) || 'Someone else has taken this check over in QA Requests.');
    const said = { fixed: 'already confirmed as fixed', not_fixed: 'already reported as not fixed', staff_approved: 'already approved by staff', cancelled: 'no longer waiting on a check' };
    throw new PayError(409, `This fix was ${said[now?.status] || 'already answered'}.`);
  }
  return { check: await getCheck(prisma, checkId), settings };
}

// The check's message could not be posted because the report's post is gone
// (deleted in Discord). Nobody can answer it there, so it is withdrawn.
async function cancelUnreachable(prisma, checkId) {
  await ensureTables(prisma);
  await prisma.$executeRawUnsafe(`
    UPDATE "ReportQaCheck" SET status = 'cancelled', "resolvedByName" = 'Discord post deleted', "respondedAt" = CURRENT_TIMESTAMP
    WHERE id = $1 AND status = 'pending'`, checkId);
  return getCheck(prisma, checkId);
}

module.exports = {
  BUG_LEVELS, DEFAULTS, PayError, ensureTables,
  MAX_TEAMMATES, listTeam, addTeammate, removeTeammate, splitAmount,
  getSettings, saveSettings,
  listPeriods, getPeriod, createPeriod, updatePeriod, deletePeriod, markPaid, reopenPeriod,
  summarize, periodSummary, testerStats,
  getCheck, pendingCheck, listChecks, onStatusChange, respond, answerRefusal, cancelUnreachable,
  TAKE_MINUTES, MAX_ESCALATE_MINUTES, dueForEscalation, markEscalated, take, heldCheck, releaseClaims,
};
