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
      "discordUserId" TEXT, "discordUser" TEXT, "discordThreadId" TEXT, "publishStatus" TEXT DEFAULT 'unpublished', "createdAt" TIMESTAMP(3) NOT NULL);
    CREATE TABLE "ReportHistory" ("id" SERIAL PRIMARY KEY, "reportId" TEXT, "action" TEXT, "actorName" TEXT, "actorId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL);
    CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "name" TEXT, "role" TEXT);`);
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
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'fixed' }), /Post a video or photo showing the fix/);
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'not_fixed' }), /still happening/);

  // Not fixed: back to the dev, then asked again on the next pass.
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'not_fixed', note: 'still clips through the floor' }),
    /Post a video or photo showing it still happening/, 'Not fixed needs proof too');
  const no = await pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'not_fixed', note: 'still clips through the floor', videoUrl: 'https://x/shot.png' });
  assert.deepEqual([no.check.status, no.check.note, no.check.videoUrl], ['not_fixed', 'still clips through the floor', 'https://x/shot.png']);
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'fixed', videoUrl: 'https://x/v.mp4' }), /already reported as not fixed/);
  assert.equal(await pay.onStatusChange(prisma, { ...r, status: 'in_progress' }, 'reviewing', 'Ana'), null, 'nothing pending to close');

  const again = await pay.onStatusChange(prisma, reviewing, 'in_progress', 'Dev');
  const yes = await pay.respond(prisma, again.check.id, { discordUserId: 'u-ana', verdict: 'fixed', videoUrl: 'https://x/v.mp4' });
  assert.deepEqual([yes.check.status, yes.check.videoUrl], ['fixed', 'https://x/v.mp4']);

  const s = await pay.summarize(prisma, { from: '2026-01-01', to: '2099-01-01' });
  assert.deepEqual([s.testers[0].verifiedFixes, s.testers[0].fixesAmount, s.testers[0].total], [1, 1.5, 3.5]);
  assert.deepEqual((await pay.listChecks(prisma, {})).map(c => c.status).sort(), ['fixed', 'not_fixed']);
});

test('QA Requests: a check left 30 minutes opens up; one person takes it, answers it and is paid for it', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: RATES });
  const r = await report({ status: 'in_progress' });
  const ticketed = await report({ status: 'in_progress' });
  const ask = await pay.onStatusChange(prisma, { ...r, status: 'reviewing' }, 'in_progress', 'Dev');
  const askTicket = await pay.onStatusChange(prisma, { ...ticketed, status: 'reviewing' }, 'in_progress', 'Dev');
  await require('../src/report-tickets').ensureTables(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO "ReportTicket" ("reportId", "channelId", "kind", "number", "name") VALUES ($1, 'c1', 'test', 1, 'test-game-0001')`, ticketed.id);
  const ago = minutes => prisma.$executeRawUnsafe(`UPDATE "ReportQaCheck" SET "messageId" = 'm', "requestedAt" = NOW() - ($1 * INTERVAL '1 minute')`, minutes);

  const due = async () => (await pay.dueForEscalation(prisma)).checks.map(c => [c.id, c.title]);
  await ago(10);
  assert.deepEqual(await due(), [], 'not yet');
  await assert.rejects(pay.take(prisma, ask.check.id, { discordUserId: 'u-ben' }), /still waiting on the tester/);
  // The wait is a setting, and a change applies to checks already waiting.
  await pay.saveSettings(prisma, { qaEscalateMinutes: 5 });
  assert.deepEqual(await due(), [[ask.check.id, r.title]], 'a ticket report is not opened up');
  await pay.saveSettings(prisma, { qaEscalateMinutes: 0 });
  assert.deepEqual(await pay.dueForEscalation(prisma), { minutes: 0, checks: [] }, '0 turns it off');
  await pay.saveSettings(prisma, { qaEscalateMinutes: 30 });
  await ago(31);
  assert.deepEqual(await due(), [[ask.check.id, r.title]]);
  assert.ok(askTicket.check.id);

  const escalated = await pay.markEscalated(prisma, ask.check.id, { channelId: 'qa', messageId: 'qm' });
  assert.deepEqual([escalated.escalationChannelId, escalated.escalationMessageId], ['qa', 'qm']);
  assert.deepEqual(await due(), [], 'posted once');

  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ben', verdict: 'fixed', videoUrl: 'https://x/v.mp4' }), /press Take this check there first/);
  const taken = await pay.take(prisma, ask.check.id, { discordUserId: 'u-ben', discordUserName: 'Ben' });
  assert.deepEqual([taken.takenByDiscordUserId, taken.takenBy], ['u-ben', 'Ben']);
  await assert.rejects(pay.take(prisma, ask.check.id, { discordUserId: 'u-cy', discordUserName: 'Cy' }), /Ben is checking this until/);
  await assert.rejects(pay.take(prisma, ask.check.id, { discordUserId: 'u-ana', discordUserName: 'Ana' }), /Ben is checking this until/, 'not even the reporter can take it from him');
  await assert.rejects(pay.take(prisma, ask.check.id, { discordUserId: 'u-ben', discordUserName: 'Ben' }), /already yours/, 'taking it again does not stretch the time');
  // Ben goes quiet: after 30 minutes Cy can take it over, and Ben can no longer answer.
  await prisma.$executeRawUnsafe(`UPDATE "ReportQaCheck" SET "takenAt" = NOW() - INTERVAL '31 minutes' WHERE id = $1`, ask.check.id);
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ben', verdict: 'fixed', videoUrl: 'https://x/v.mp4' }), /time on this check ran out/);
  await pay.take(prisma, ask.check.id, { discordUserId: 'u-cy', discordUserName: 'Cy' });
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ben', verdict: 'fixed', videoUrl: 'https://x/v.mp4' }), /Cy has taken this check/);

  const yes = await pay.respond(prisma, ask.check.id, { discordUserId: 'u-cy', discordUserName: 'Cy', verdict: 'fixed', videoUrl: 'https://x/v.mp4' });
  assert.deepEqual([yes.check.status, yes.check.answeredByDiscordUserId, yes.check.answeredBy], ['fixed', 'u-cy', 'Cy']);
  const s = await pay.summarize(prisma, { from: '2026-01-01', to: '2099-01-01' });
  const of = name => s.testers.find(t => t.name === name);
  assert.deepEqual([of('Cy').verifiedFixes, of('Cy').fixesAmount], [1, 1.5], 'the fix is paid to whoever checked it');
  assert.equal(of('Ana').verifiedFixes, 0, 'the reporter still gets the report, not the check');
  assert.equal(of('Ana').reports, 2);
});

test('the QA Requests wait: whole minutes from 0 to a day, 30 by default', async () => {
  const { prisma } = await createDb();
  assert.equal((await pay.getSettings(prisma)).qaEscalateMinutes, 30);
  for (const bad of [-1, 2.5, 'soon', 24 * 60 + 1]) assert.equal((await pay.saveSettings(prisma, { qaEscalateMinutes: bad })).qaEscalateMinutes, 30, String(bad));
  assert.equal((await pay.saveSettings(prisma, { qaEscalateMinutes: 90 })).qaEscalateMinutes, 90);
  assert.equal((await pay.saveSettings(prisma, { requireVideo: false })).qaEscalateMinutes, 90, 'other settings leave it alone');
  const ask = await pay.onStatusChange(prisma, { id: 'x', type: 'bug', status: 'reviewing', discordThreadId: 't', discordUserId: 'u' }, 'in_progress');
  assert.equal(ask.escalateMinutes, 90, 'the bot is told the wait when it posts a check');
});

test('once a check is opened up, the reporter has to take it like anyone else', async () => {
  const { prisma, report } = await createDb();
  const r = await report({ status: 'in_progress' });
  const ask = await pay.onStatusChange(prisma, { ...r, status: 'reviewing' }, 'in_progress', 'Dev');
  await pay.markEscalated(prisma, ask.check.id, { channelId: 'qa', messageId: 'qm' });
  const video = { verdict: 'fixed', videoUrl: 'https://x/v.mp4' };
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', ...video }), /press Take this check there first/);
  await pay.take(prisma, ask.check.id, { discordUserId: 'u-ben', discordUserName: 'Ben' });
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', ...video }), /Ben has taken this check/);
  // Ben's time runs out; the reporter takes it back and answers.
  await prisma.$executeRawUnsafe(`UPDATE "ReportQaCheck" SET "takenAt" = NOW() - INTERVAL '31 minutes' WHERE id = $1`, ask.check.id);
  await pay.take(prisma, ask.check.id, { discordUserId: 'u-ana', discordUserName: 'Ana' });
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ben', ...video }), /Ana has taken this check/);
  const yes = await pay.respond(prisma, ask.check.id, { discordUserId: 'u-ana', ...video });
  assert.deepEqual([yes.check.answeredByDiscordUserId, yes.check.answeredBy], ['u-ana', 'Ana']);
  await assert.rejects(pay.respond(prisma, ask.check.id, { discordUserId: 'u-ben', ...video }), /already confirmed as fixed/);
  await assert.rejects(pay.take(prisma, ask.check.id, { discordUserId: 'u-cy' }), /already been answered/);
});

test('answerRefusal says who may answer a check', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const base = { discordUserId: 'u-ana', escalatedAt: null, takenByDiscordUserId: null, takenAt: null, takenBy: null };
  assert.equal(pay.answerRefusal(base, 'u-ana', now), null);
  assert.match(pay.answerRefusal(base, 'u-ben', now), /Only the tester/);
  const open = { ...base, escalatedAt: '2026-10-26T11:00:00Z' };
  assert.match(pay.answerRefusal(open, 'u-ana', now), /Take this check there first/);
  const held = { ...open, takenByDiscordUserId: 'u-ben', takenBy: 'Ben', takenAt: new Date('2026-10-26T11:45:00Z') };
  assert.equal(pay.answerRefusal(held, 'u-ben', now), null);
  assert.match(pay.answerRefusal(held, 'u-ana', now), /Ben has taken this check .* until 12:15 UTC/);
  const lapsed = { ...held, takenAt: new Date('2026-10-26T11:20:00Z') };
  assert.match(pay.answerRefusal(lapsed, 'u-ben', now), /ran out/);
  assert.match(pay.answerRefusal(lapsed, 'u-ana', now), /Take this check there first/);
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
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN "updatedAt" TIMESTAMP(3), ADD COLUMN "devNotes" TEXT`);
  await prisma.$executeRawUnsafe(`CREATE TYPE "Status" AS ENUM ('queued','open','in_progress','reviewing','on_hold','resolved','declined')`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ALTER COLUMN status TYPE "Status" USING status::"Status"`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN email TEXT`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "_AssignedReports" ("A" TEXT, "B" TEXT)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE "Attachment" (id TEXT PRIMARY KEY, "reportId" TEXT, type TEXT, url TEXT, filename TEXT)`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "ReportHistory" ADD COLUMN detail TEXT`);
  const testerQa = require('../src/tester-qa');
  await pay.saveSettings(prisma, { rates: RATES });

  const r = await report({ status: 'reviewing' });
  assert.equal((await testerQa.fetchReport(prisma, r.id)).testerCheck, null);
  const ask = await pay.onStatusChange(prisma, { ...r, status: 'reviewing' }, 'in_progress');
  assert.equal((await testerQa.fetchReport(prisma, r.id)).testerCheck.status, 'pending');

  // Not fixed sends it back to the dev.
  await testerQa.applyAnswer(prisma, ask.check.id, { discordUserId: 'u-ana', verdict: 'not_fixed', note: 'still broken', videoUrl: 'https://x/shot.png' });
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
  const publishStatus = async () => (await prisma.$queryRawUnsafe(`SELECT "publishStatus" FROM "Report" WHERE id = $1`, r.id))[0].publishStatus;

  assert.equal(await qa.markQaFail(prisma, r.id, 'open', 'in_progress', 'Dev'), false, 'an ordinary move into In Progress is not a fail');
  assert.equal((await mark()).qaFailedAt, null);
  assert.equal(await qa.markQaFail(prisma, r.id, 'in_progress', 'reviewing', 'Dev'), false);

  await prisma.$executeRawUnsafe(`UPDATE "Report" SET "publishStatus" = 'flagged' WHERE id = $1`, r.id);
  assert.equal(await qa.markQaFail(prisma, r.id, 'reviewing', 'in_progress', 'Quinn'), true);
  assert.equal(await publishStatus(), 'unpublished', 'a failed report is no longer Ready to Publish');
  const failed = await mark();
  assert.equal(failed.qaFailedBy, 'Quinn');
  assert.ok(failed.qaFailedAt instanceof Date);

  // Sent to QA again: the mark is gone, and stays gone when it is resolved.
  assert.equal(await qa.markQaFail(prisma, r.id, 'in_progress', 'reviewing', 'Dev'), true);
  assert.deepEqual(await mark(), { qaFailedAt: null, qaFailedBy: null });
  assert.equal(await qa.markQaFail(prisma, r.id, 'reviewing', 'resolved', 'Quinn'), false);
});

test('QA staff are paid once per report they approved on the dashboard, from the report history', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: { ...RATES, verifiedFix: 3 } });   // a QA approval pays the same as a fix
  await prisma.$executeRawUnsafe(`INSERT INTO "User" VALUES ('q1','Quinn','qa'), ('v1','Val','reviewer'), ('e1','Eli','engineer')`);
  const resolved = (r, actorId, at) => prisma.$executeRawUnsafe(
    `INSERT INTO "ReportHistory" ("reportId","action","actorName","actorId","createdAt") VALUES ($1,'Marked as Resolved','x',$2,$3::timestamp)`, r.id, actorId, at);
  const a = await report({ status: 'resolved' });
  const b = await report({ status: 'resolved' });
  const c = await report({ status: 'resolved' });
  const d = await report({ status: 'declined' });
  const e = await report({ status: 'resolved' });
  await resolved(a, 'q1', '2026-10-03');
  await resolved(a, 'v1', '2026-10-04');   // resolved again later: only the first QA approval counts
  await resolved(b, 'v1', '2026-10-05');
  await resolved(c, 'e1', '2026-10-05');   // an engineer: not QA staff
  await resolved(d, 'q1', '2026-10-05');   // declined since
  await resolved(e, 'q1', '2026-09-30');   // before the period
  await prisma.$executeRawUnsafe(`INSERT INTO "ReportHistory" ("reportId","action","actorName","actorId","createdAt") VALUES ($1,'Marked as Resolved','(tester)','',$2::timestamp)`, c.id, '2026-10-02');

  const s = await pay.summarize(prisma, { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(s.qaStaff.map(m => [m.name, m.role, m.approvals, m.amount]), [['Quinn', 'qa', 1, 3], ['Val', 'reviewer', 1, 3]]);
  assert.deepEqual(s.qaApprovals.map(x => x.reportId).sort(), [a.id, b.id].sort());
  assert.deepEqual([s.totals.qaApprovals, s.totals.qaAmount, s.totals.qaStaff], [2, 6, 2]);
  // The tester side is unchanged and the grand total includes both.
  const testersTotal = s.testers.reduce((n, t) => n + t.total, 0);
  assert.equal(s.totals.total, testersTotal + 6);
});


test('a report with a team is split between the reporter and the teammates, to the cent', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: RATES });
  const r = await report({ bugLevel: 'moderate' });                       // 5 split three ways
  await report({ bugLevel: 'major', credited: 'u-cy', creditedName: 'Cy' }); // no team: Cy is paid in full on top
  await pay.addTeammate(prisma, r.id, { discordUserId: 'u-ben', discordUser: 'Ben', addedBy: 'Ana' });
  await pay.addTeammate(prisma, r.id, { discordUserId: 'u-cy', discordUser: 'Cy', addedBy: 'Ana' });
  await assert.rejects(pay.addTeammate(prisma, r.id, { discordUserId: 'u-ben' }), /on this report's team already/);
  await assert.rejects(pay.addTeammate(prisma, r.id, { discordUserId: 'u-ana' }), /That is the reporter/);

  const s = await pay.summarize(prisma, { from: '2026-10-01', to: '2026-10-07' });
  const of = name => s.testers.find(t => t.name === name);
  assert.deepEqual([of('Ana').reportsAmount, of('Ana').shared, of('Ana').reports], [14.17, 1, 2], '1.67 + 12.5');
  assert.deepEqual([of('Ben').reportsAmount, of('Ben').shared, of('Ben').levels.moderate], [1.67, 1, 1]);
  assert.deepEqual([of('Cy').reportsAmount, of('Cy').shared, of('Cy').credited], [14.16, 1, 1], '1.66 share + 12.5 credit');
  assert.equal(s.totals.reportsAmount, 30, 'the split adds up to the price: 5 + 12.5 + 12.5 credited');
  assert.deepEqual(s.reports.find(x => x.id === r.id).team.map(m => [m.discordUser, m.share]), [['Ben', 1.67], ['Cy', 1.66]]);

  await pay.removeTeammate(prisma, r.id, 'u-cy');
  await assert.rejects(pay.removeTeammate(prisma, r.id, 'u-cy'), /not on this report's team/);
  const after = await pay.summarize(prisma, { from: '2026-10-01', to: '2026-10-07' });
  assert.deepEqual(after.testers.find(t => t.name === 'Ben').reportsAmount, 2.5);
  for (let i = 0; i < 4; i++) await pay.addTeammate(prisma, r.id, { discordUserId: `u-${i}` });
  await assert.rejects(pay.addTeammate(prisma, r.id, { discordUserId: 'u-9' }), /up to 5 teammates/);
});

test('a tester\'s own stats follow the pay period that covers today', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: RATES });
  await report({ bugLevel: 'major', createdAt: '2026-09-05', acceptedAt: '2026-09-10' });
  await report({ bugLevel: 'minor', createdAt: '2026-10-01', acceptedAt: '2026-10-02' });
  await report({ bugLevel: null, queued: true, status: 'queued', createdAt: '2026-10-05', acceptedAt: null });
  await report({ status: 'declined', createdAt: '2026-10-06' });
  await report({ discordUserId: 'u-ben', discordUser: 'Ben', createdAt: '2026-10-01' });
  await report({ discordUserId: 'u-ben', discordUser: 'Ben', createdAt: '2026-10-01' });
  await report({ discordUserId: 'u-ben', discordUser: 'Ben', status: 'resolved', createdAt: '2026-09-02', acceptedAt: '2026-09-15' });
  const september = await pay.createPeriod(prisma, { name: 'September', startsOn: '2026-09-01', endsOn: '2026-09-30' });
  await pay.markPaid(prisma, september.id, 'Admin');
  await pay.createPeriod(prisma, { name: 'October', startsOn: '2026-10-01', endsOn: '2026-10-31' });

  const ana = await pay.testerStats(prisma, 'u-ana', { today: '2026-10-26' });
  assert.deepEqual(ana.period, { name: 'October', startsOn: '2026-10-01', endsOn: '2026-10-31', paid: false });
  assert.deepEqual(ana.filed, { total: 3, queued: 1, active: 1, resolved: 0, declined: 1 }, 'filed in October only');
  assert.deepEqual([ana.accepted, ana.levels.minor, ana.levels.major, ana.earned], [1, 1, 0, 2]);
  assert.deepEqual([ana.paid, ana.paidPeriods], [12.5, 1], 'paid so far is all time');
  assert.deepEqual([ana.rank, ana.testers], [2, 2], 'Ben has two accepted in October');

  // A paid period shows what was paid.
  const inSeptember = await pay.testerStats(prisma, 'u-ana', { today: '2026-09-20' });
  assert.deepEqual([inSeptember.period.name, inSeptember.period.paid, inSeptember.accepted, inSeptember.earned], ['September', true, 1, 12.5]);
  assert.deepEqual([inSeptember.rank, inSeptember.testers, inSeptember.filed.total], [1, 2, 1]);

  // No period covers today: everything since the last paid period ended.
  const later = await pay.testerStats(prisma, 'u-ana', { today: '2026-11-05' });
  assert.deepEqual([later.period, later.from, later.to, later.accepted, later.earned], [null, '2026-10-01', '2026-11-05', 1, 2]);

  const nobody = await pay.testerStats(prisma, 'u-zed', { today: '2026-10-26' });
  assert.deepEqual([nobody.filed.total, nobody.accepted, nobody.earned, nobody.rank], [0, 0, 0, null]);
});

test('with no pay periods, a tester\'s stats are all time', async () => {
  const { prisma, report } = await createDb();
  await pay.saveSettings(prisma, { rates: RATES });
  await report({ bugLevel: 'major', createdAt: '2025-01-05', acceptedAt: '2025-01-10' });
  const ana = await pay.testerStats(prisma, 'u-ana', { today: '2026-10-26' });
  assert.deepEqual([ana.period, ana.from, ana.accepted, ana.earned, ana.filed.total, ana.rank], [null, null, 1, 12.5, 1, 1]);
});
