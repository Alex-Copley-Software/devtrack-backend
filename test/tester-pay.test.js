const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const pay = require('../src/tester-pay');

// The two Prisma-managed tables the feature reads, as plain text columns.
async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  const parsers = { 1114: value => new Date(`${value.replace(' ', 'T')}Z`) };
  const prisma = {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).affectedRows ?? 0,
  };
  await pg.exec(`
    CREATE TABLE "Report" ("id" TEXT PRIMARY KEY, "title" TEXT, "type" TEXT, "bugLevel" TEXT, "status" TEXT, "queued" BOOLEAN,
      "discordUserId" TEXT, "discordUser" TEXT, "discordThreadId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL);
    CREATE TABLE "ReportHistory" ("id" SERIAL PRIMARY KEY, "reportId" TEXT, "action" TEXT, "createdAt" TIMESTAMP(3) NOT NULL);`);
  await pay.ensureTables(prisma);
  let n = 0;
  const report = async (fields = {}) => {
    const r = {
      id: `r${++n}`, title: `Bug ${n}`, type: 'bug', bugLevel: 'minor', status: 'open', queued: false,
      discordUserId: 'u-ana', discordUser: 'Ana', discordThreadId: `t${n}`, createdAt: '2026-09-01', acceptedAt: '2026-10-02', ...fields,
    };
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Report" ("id","title","type","bugLevel","status","queued","discordUserId","discordUser","discordThreadId","createdAt","creditedDiscordUserId","creditedDiscordUser")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamp,$11,$12)`,
      r.id, r.title, r.type, r.bugLevel, r.status, r.queued, r.discordUserId, r.discordUser, r.discordThreadId, r.createdAt, r.credited || null, r.creditedName || null);
    if (r.acceptedAt) await prisma.$executeRawUnsafe(`INSERT INTO "ReportHistory" ("reportId","action","createdAt") VALUES ($1,'Report accepted',$2::timestamp)`, r.id, r.acceptedAt);
    return r;
  };
  return { prisma, report };
}

const RATES = { insignificant: 0.5, minor: 2, moderate: 5, major: 12.5, verifiedFix: 1.5 };

test('a period pays accepted bugs by level, in the period they were accepted', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: RATES });
  await report({ bugLevel: 'minor' });
  await report({ bugLevel: 'major' });
  await report({ bugLevel: 'insignificant' });
  await report({ bugLevel: 'moderate', discordUserId: 'u-ben', discordUser: 'Ben' });
  await report({ bugLevel: 'major', acceptedAt: '2026-09-20' });                     // accepted before the period
  await report({ bugLevel: 'major', acceptedAt: '2026-10-08 00:00:01' });            // accepted after it
  await report({ bugLevel: 'major', createdAt: '2026-10-03', acceptedAt: null, queued: true }); // never accepted
  await report({ bugLevel: 'major', status: 'declined' });                            // accepted, then declined
  await report({ bugLevel: 'major', type: 'suggestion' });                            // not a bug
  await report({ bugLevel: null });                                                   // accepted with no level: counted, worth nothing
  await report({ bugLevel: 'minor', acceptedAt: '2026-10-07 23:59:59' });             // last second of the period

  const s = await pay.summarize(prisma, { from: '2026-10-01', to: '2026-10-07' });
  const ana = s.testers.find(t => t.name === 'Ana');
  assert.deepEqual(ana.levels, { insignificant: 1, minor: 2, moderate: 0, major: 1 });
  assert.deepEqual([ana.reports, ana.noLevel, ana.reportsAmount, ana.total], [5, 1, 17, 17]);   // 0.5 + 2 + 2 + 12.5
  assert.deepEqual(s.testers.map(t => [t.name, t.total]), [['Ana', 17], ['Ben', 5]]);
  assert.deepEqual([s.totals.reports, s.totals.total, s.totals.testers], [6, 22, 2]);
  await assert.rejects(pay.summarize(prisma, { from: '2026-10-07', to: '2026-10-01' }), /before the start/);
});

test('a credited co-finder is paid too, unless that is switched off', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: RATES });
  await report({ bugLevel: 'major', credited: 'u-cy', creditedName: 'Cy' });
  await report({ bugLevel: 'minor', credited: 'u-ana', creditedName: 'Ana' }); // crediting yourself pays once
  let s = await pay.summarize(prisma, { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(s.testers.map(t => [t.name, t.total, t.credited]), [['Ana', 14.5, 0], ['Cy', 12.5, 1]]);
  await pay.saveSettings(prisma, { payCredited: false });
  s = await pay.summarize(prisma, { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(s.testers.map(t => t.name), ['Ana']);
});

test('tester QA: asked in review, only the reporter can answer, a video is required, each answer is kept', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: RATES });
  const r = await report({ status: 'in_progress' });
  const reviewing = { ...r, status: 'reviewing' };

  const ask = await pay.onStatusChange(prisma, reviewing, 'in_progress', 'Dev');
  assert.deepEqual([ask.kind, ask.check.status, ask.check.discordUserId, ask.requireVideo], ['ask', 'pending', 'u-ana', true]);
  assert.equal(await pay.onStatusChange(prisma, { ...r, type: 'suggestion', status: 'reviewing' }, 'open'), null);
  assert.equal(await pay.onStatusChange(prisma, { ...r, discordThreadId: null, status: 'reviewing' }, 'open'), null);

  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ben', verdict: 'fixed', videoUrl: 'https://x/v.mp4' }), /Only the tester/);
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'fixed' }), /Post a video/);
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'not_fixed' }), /still happening/);

  // Not fixed: back to the dev, then asked again on the next pass.
  const no = await pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'not_fixed', note: 'still clips through the floor' });
  assert.deepEqual([no.check.status, no.check.note], ['not_fixed', 'still clips through the floor']);
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'fixed', videoUrl: 'https://x/v.mp4' }), /already reported as not fixed/);
  assert.equal(await pay.onStatusChange(prisma, { ...r, status: 'in_progress' }, 'reviewing', 'Ana'), null, 'nothing pending to close');

  const again = await pay.onStatusChange(prisma, reviewing, 'in_progress', 'Dev');
  const yes = await pay.respond(prisma, again.check.id, { discordUserId: 'u-ana', verdict: 'fixed', videoUrl: 'https://x/v.mp4' });
  assert.deepEqual([yes.check.status, yes.check.videoUrl], ['fixed', 'https://x/v.mp4']);

  const s = await pay.summarize(prisma, { from: '2026-01-01', to: '2099-01-01' });
  assert.deepEqual([s.testers[0].verifiedFixes, s.testers[0].fixesAmount, s.testers[0].total], [1, 1.5, 3.5]);
  assert.deepEqual((await pay.listChecks(prisma, {})).map(c => c.status).sort(), ['fixed', 'not_fixed']);
});

test('staff resolving first approves the check without paying; leaving review any other way withdraws it', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: RATES, requireVideo: false });
  const a = await report();
  const b = await report();
  const askA = await pay.onStatusChange(prisma, { ...a, status: 'reviewing' }, 'in_progress');
  await pay.onStatusChange(prisma, { ...b, status: 'reviewing' }, 'in_progress');

  const closed = await pay.onStatusChange(prisma, { ...a, status: 'resolved' }, 'reviewing', 'Morgan');
  assert.deepEqual([closed.kind, closed.state, closed.check.status, closed.check.resolvedByName], ['close', 'staff_approved', 'staff_approved', 'Morgan']);
  await assert.rejects(pay.respond(prisma, askA.check.id, { discordUserId: 'u-ana', verdict: 'fixed' }), /already approved by staff/);
  assert.equal((await pay.onStatusChange(prisma, { ...b, status: 'on_hold' }, 'reviewing', 'Morgan')).state, 'cancelled');

  const s = await pay.summarize(prisma, { from: '2026-01-01', to: '2099-01-01' });
  assert.equal(s.totals.verifiedFixes, 0);

  await pay.saveSettings(prisma, { testerQaEnabled: false });
  assert.equal(await pay.onStatusChange(prisma, { ...b, status: 'reviewing' }, 'on_hold'), null);
});

test('pay periods: validation, and marking paid freezes the numbers', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: RATES });
  await report({ bugLevel: 'major' });
  await assert.rejects(pay.createPeriod(prisma, { name: '', startsOn: '2026-10-01', endsOn: '2026-10-07' }), /name/);
  await assert.rejects(pay.createPeriod(prisma, { name: 'x', startsOn: '2026-10-08', endsOn: '2026-10-07' }), /before the start/);
  const period = await pay.createPeriod(prisma, { name: 'Update 4.0 testing', startsOn: '2026-10-01', endsOn: '2026-10-07' }, 'Alex');
  assert.deepEqual([period.startsOn, period.endsOn, period.createdByName], ['2026-10-01', '2026-10-07', 'Alex']);
  assert.equal((await pay.periodSummary(prisma, period.id)).totals.total, 12.5);

  const paid = await pay.markPaid(prisma, period.id, 'Alex');
  assert.ok(paid.paidAt);
  await pay.saveSettings(prisma, { rates: { major: 100 } });
  await report({ bugLevel: 'major' });
  const frozen = await pay.periodSummary(prisma, period.id);
  assert.deepEqual([frozen.frozen, frozen.totals.total, frozen.totals.reports], [true, 12.5, 1]);
  await assert.rejects(pay.updatePeriod(prisma, period.id, { name: 'renamed' }), /marked paid/);
  await assert.rejects(pay.deletePeriod(prisma, period.id), /marked paid/);

  await pay.reopenPeriod(prisma, period.id);
  const live = await pay.periodSummary(prisma, period.id);
  assert.deepEqual([live.frozen, live.totals.total, live.totals.reports], [false, 200, 2]);
  await pay.deletePeriod(prisma, period.id);
  assert.deepEqual(await pay.listPeriods(prisma), []);
});

test('the report query carries the latest tester check, and an answer moves the report', async () => {
  const { prisma, report } = await createDb();
  // The rest of what the report query joins, and what the answer handler writes to.
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN "publishStatus" TEXT DEFAULT 'unpublished', ADD COLUMN "updatedAt" TIMESTAMP(3), ADD COLUMN "devNotes" TEXT`);
  await prisma.$executeRawUnsafe(`CREATE TYPE "Status" AS ENUM ('queued','open','in_progress','reviewing','on_hold','resolved','declined')`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ALTER COLUMN status TYPE "Status" USING status::"Status"`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "User" (id TEXT PRIMARY KEY, name TEXT, email TEXT)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "_AssignedReports" ("A" TEXT, "B" TEXT)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "Attachment" (id TEXT PRIMARY KEY, "reportId" TEXT, type TEXT, url TEXT, filename TEXT)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "ReportHistory" ADD COLUMN detail TEXT, ADD COLUMN "actorName" TEXT, ADD COLUMN "actorId" TEXT`);
  const testerQa = require('../src/tester-qa');
  await pay.saveSettings(prisma, { rates: RATES });

  const r = await report({ status: 'reviewing' });
  assert.equal((await testerQa.fetchReport(prisma, r.id)).testerCheck, null);
  const ask = await pay.onStatusChange(prisma, { ...r, status: 'reviewing' }, 'in_progress');
  assert.equal((await testerQa.fetchReport(prisma, r.id)).testerCheck.status, 'pending');

  // Not fixed sends it back to the dev.
  await testerQa.applyAnswer(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'not_fixed', note: 'still broken' });
  let fresh = await testerQa.fetchReport(prisma, r.id);
  assert.deepEqual([fresh.status, fresh.testerCheck.status, fresh.testerCheck.note], ['in_progress', 'not_fixed', 'still broken']);

  // Fixed leaves it in review for staff by default, and resolves it when that rule is on.
  await prisma.$executeRawUnsafe(`UPDATE "Report" SET status = 'reviewing' WHERE id = $1`, r.id);
  const second = await pay.onStatusChange(prisma, { ...r, status: 'reviewing' }, 'in_progress');
  const kept = await testerQa.applyAnswer(prisma, second.check.id, { discordUserId: 'u-ana', verdict: 'fixed', videoUrl: 'https://x/v' });
  fresh = await testerQa.fetchReport(prisma, r.id);
  assert.deepEqual([kept.autoResolved, fresh.status, fresh.testerCheck.status], [false, 'reviewing', 'fixed']);

  await pay.saveSettings(prisma, { autoResolve: true });
  const other = await report({ status: 'reviewing' });
  const third = await pay.onStatusChange(prisma, { ...other, status: 'reviewing' }, 'in_progress');
  const done = await testerQa.applyAnswer(prisma, third.check.id, { discordUserId: 'u-ana', verdict: 'fixed', videoUrl: 'https://x/v' });
  fresh = await testerQa.fetchReport(prisma, other.id);
  assert.deepEqual([done.autoResolved, fresh.status, fresh.publishStatus], [true, 'resolved', 'published']);
});

test('a report sent from QA Review back to In Progress is marked as a QA fail until it moves on', async () => {
  const { prisma, report } = await createDb();
  const qa = require('../src/tester-qa');
  const r = await report({ status: 'in_progress' });
  const mark = async () => (await prisma.$queryRawUnsafe(`SELECT "qaFailedAt", "qaFailedBy" FROM "Report" WHERE id = $1`, r.id))[0];

  assert.equal(await qa.markQaFail(prisma, r.id, 'open', 'in_progress', 'Dev'), false, 'an ordinary move into In Progress is not a fail');
  assert.equal((await mark()).qaFailedAt, null);
  assert.equal(await qa.markQaFail(prisma, r.id, 'in_progress', 'reviewing', 'Dev'), false);

  assert.equal(await qa.markQaFail(prisma, r.id, 'reviewing', 'in_progress', 'Quinn'), true);
  const failed = await mark();
  assert.equal(failed.qaFailedBy, 'Quinn');
  assert.ok(failed.qaFailedAt instanceof Date);

  // Sent to QA again: the mark is gone, and stays gone when it is resolved.
  assert.equal(await qa.markQaFail(prisma, r.id, 'in_progress', 'reviewing', 'Dev'), true);
  assert.deepEqual(await mark(), { qaFailedAt: null, qaFailedBy: null });
  assert.equal(await qa.markQaFail(prisma, r.id, 'reviewing', 'resolved', 'Quinn'), false);
});
