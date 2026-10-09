const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const tickets = require('../src/report-tickets');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  const parsers = { 1114: value => new Date(`${value.replace(' ', 'T')}Z`) };
  const prisma = {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).affectedRows ?? 0,
  };
  await pg.exec(`CREATE TABLE "Report" ("id" TEXT PRIMARY KEY, "title" TEXT, "status" TEXT, "discordUserId" TEXT, "discordUser" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  const history = [];
  tickets.setLogger(async entry => { history.push(entry); });
  let n = 0;
  const report = async (status = 'open', minutesAgo = 0) => {
    const id = `r${++n}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Report" ("id","title","status","discordUserId","discordUser","updatedAt") VALUES ($1,$2,$3,'u-ana','Ana', NOW() - ($4::int * INTERVAL '1 minute'))`,
      id, `Bug ${n}`, status, minutesAgo);
    return id;
  };
  const ticket = (reportId, number, kind = 'test') => tickets.register(prisma, {
    reportId, channelId: `c-${reportId}`, kind, number: String(number).padStart(4, '0'), name: `${kind}-game-${String(number).padStart(4, '0')}`, openerId: 'u-ana',
  });
  return { prisma, report, ticket, history };
}

test('a ticket is registered once and shows on its report', async () => {
  const { prisma, report, ticket, history } = await createDb();
  const id = await report();
  const first = await ticket(id, 42);
  assert.deepEqual([first.kind, first.number, first.name, first.state, first.openerId], ['test', 42, 'test-game-0042', 'open', 'u-ana']);
  await ticket(id, 42);
  assert.deepEqual(history.map(h => [h.action, h.detail]), [['ticket_opened', 'test-game-0042']], 'registering again logs nothing new');

  const rows = await prisma.$queryRawUnsafe(`SELECT r.id, ${tickets.TICKET_COLUMN} FROM "Report" r`);
  assert.deepEqual([rows[0].ticket.name, rows[0].ticket.state, rows[0].ticket.transcriptUrl], ['test-game-0042', 'open', null]);

  await assert.rejects(tickets.register(prisma, { reportId: 'nope', channelId: 'c', name: 'test-game-0001' }), /Report not found/);
  await assert.rejects(tickets.register(prisma, { reportId: id }), /required/);
});

test('only finished reports are offered for closing, after the delay', async () => {
  const { prisma, report, ticket } = await createDb();
  const open = await report('in_progress', 60);
  const justResolved = await report('resolved', 1);
  const resolved = await report('resolved', 10);
  const declined = await report('declined', 20);
  for (const [i, id] of [open, justResolved, resolved, declined].entries()) await ticket(id, i + 1);

  const ids = async opts => (await tickets.pendingClose(prisma, opts)).map(t => t.reportId);
  assert.deepEqual(await ids({ delayMs: 5 * 60000 }), [declined, resolved], 'oldest first; the one resolved a minute ago waits');
  assert.deepEqual(await ids({ delayMs: 0 }), [declined, resolved, justResolved]);
  assert.deepEqual(await ids({ delayMs: 0, statuses: 'resolved' }), [resolved, justResolved]);
  assert.deepEqual(await ids({ delayMs: 0, statuses: 'in_progress,nonsense' }), [], 'only resolved and declined can close a ticket');

  // Reopened before the bot got to it: no longer offered.
  await prisma.$executeRawUnsafe(`UPDATE "Report" SET status = 'in_progress' WHERE id = $1`, resolved);
  assert.deepEqual(await ids({ delayMs: 0 }), [declined, justResolved]);
});

test('closing records how, with the transcript, and stops offering it', async () => {
  const { prisma, report, ticket, history } = await createDb();
  const id = await report('resolved', 10);
  await ticket(id, 7, 'live');

  // Ticket Tool's transcript carries the ticket number; a test game ticket with the same number is not confused with it.
  const other = await report('resolved', 10);
  await ticket(other, 7, 'test');
  const withTranscript = await tickets.attachTranscript(prisma, { kind: 'live', number: '0007', url: 'https://discord.com/channels/1/2/3', fileUrl: 'https://cdn/t.html' });
  assert.deepEqual([withTranscript.reportId, withTranscript.transcriptUrl], [id, 'https://discord.com/channels/1/2/3']);
  await assert.rejects(tickets.attachTranscript(prisma, { kind: 'live', number: 999, url: 'x' }), /No ticket matches/);

  const closed = await tickets.markClosed(prisma, `c-${id}`, { method: 'ticket_tool' });
  assert.deepEqual([closed.state, closed.closeMethod, closed.closedAt instanceof Date], ['closed', 'ticket_tool', true]);
  assert.deepEqual((await tickets.pendingClose(prisma, { delayMs: 0 })).map(t => t.reportId), [other]);
  const last = history.at(-1);
  assert.equal(last.action, 'ticket_closed');
  assert.match(last.detail, /live-game-0007: deleted by Ticket Tool\. Transcript: https:\/\/discord\.com\/channels\/1\/2\/3/);

  // Closing twice changes nothing and logs nothing.
  const count = history.length;
  await tickets.markClosed(prisma, `c-${id}`, { method: 'manual' });
  assert.equal(history.length, count);
  assert.equal((await tickets.byChannel(prisma, `c-${id}`)).closeMethod, 'ticket_tool');
});

test('after three failed attempts the bot stops trying and says so in the history', async () => {
  const { prisma, report, ticket, history } = await createDb();
  const id = await report('resolved', 10);
  await ticket(id, 3);
  assert.equal((await tickets.closeFailed(prisma, `c-${id}`, 'Missing Permissions')).gaveUp, false);
  await tickets.closeFailed(prisma, `c-${id}`, 'Missing Permissions');
  assert.equal((await tickets.pendingClose(prisma, { delayMs: 0 })).length, 1, 'still retried after two');
  assert.equal((await tickets.closeFailed(prisma, `c-${id}`, 'Missing Permissions')).gaveUp, true);
  assert.equal((await tickets.pendingClose(prisma, { delayMs: 0 })).length, 0);
  assert.deepEqual(history.filter(h => h.action === 'ticket_close_failed').map(h => h.detail), ['test-game-0003: Missing Permissions']);

  // Staff then delete it by hand: recorded as closed.
  const closed = await tickets.markClosed(prisma, `c-${id}`, { method: 'manual' });
  assert.deepEqual([closed.state, closed.closeMethod, closed.lastError], ['closed', 'manual', null]);
});
