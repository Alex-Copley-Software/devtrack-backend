// /bugs search: testers find active reports by their words, and learn nothing about who filed them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const bugSearch = require('../src/bug-search');
const tickets = require('../src/report-tickets');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  const parsers = { 1114: value => new Date(`${value.replace(' ', 'T')}Z`) };
  const prisma = {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).affectedRows ?? 0,
  };
  await pg.exec(`CREATE TABLE "Report" ("id" TEXT PRIMARY KEY, "type" TEXT, "title" TEXT, "description" TEXT, "status" TEXT, "bugLevel" TEXT,
    "tags" TEXT[] DEFAULT '{}', "archived" BOOLEAN DEFAULT false, "discordUser" TEXT, "discordUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  tickets.setLogger(async () => {});
  let n = 0;
  const report = async (fields) => {
    const r = { id: `r${++n}`, type: 'bug', status: 'open', bugLevel: 'minor', tags: [], archived: false, discordUser: 'ana', discordUserId: '222222222222222222', ...fields };
    await prisma.$executeRawUnsafe(`INSERT INTO "Report" (id, type, title, description, status, "bugLevel", tags, archived, "discordUser", "discordUserId", "createdAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() - ($11::int * INTERVAL '1 hour'))`,
      r.id, r.type, r.title, r.description, r.status, r.bugLevel, r.tags, r.archived, r.discordUser, r.discordUserId, n);
    if (r.credited) await prisma.$executeRawUnsafe(`UPDATE "Report" SET "creditedDiscordUser" = $2 WHERE id = $1`, r.id, r.credited);
    return r;
  };
  return { prisma, report };
}

test('active reports are found by their words; finished, declined, archived and suggestions are not', async () => {
  const { prisma, report } = await createDb();
  await report({ title: 'Boss door stays locked after wave 3', description: 'Clear wave 3 and the door never opens', status: 'queued' });
  await report({ title: 'Door sound plays twice', description: 'The boss door opening sound doubles', status: 'in_progress', bugLevel: 'insignificant' });
  await report({ title: 'Boss door locked', description: 'fixed already', status: 'resolved' });
  await report({ title: 'Boss door locked', description: 'not a bug', status: 'declined' });
  await report({ title: 'Boss door locked', description: 'old', status: 'open', archived: true });
  await report({ title: 'Make the boss door bigger', description: 'idea', status: 'open', type: 'suggestion' });
  await report({ title: 'Shop crashes when opened', description: 'crash', status: 'reviewing', type: 'crash', bugLevel: 'major' });

  const found = await bugSearch.search(prisma, { query: "the boss door won't open" });
  assert.deepEqual(found.terms, ['boss', 'door', 'wont', 'open']);
  assert.deepEqual(found.results.map(r => [r.title, r.status]), [
    ['Boss door stays locked after wave 3', 'Waiting for review'],
    ['Door sound plays twice', 'In progress'],
  ]);
  assert.deepEqual((await bugSearch.search(prisma, { query: 'shop crash' })).results.map(r => [r.title, r.status, r.severity]), [['Shop crashes when opened', 'In QA', 'major']]);
  assert.deepEqual((await bugSearch.search(prisma, { query: 'the a' })).results, [], 'nothing worth searching on');
});

test('results say nothing about who reported it and carry no clips, images or links', async () => {
  const { prisma, report } = await createDb();
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN "creditedDiscordUser" TEXT`);
  await report({
    title: 'Aizen ult freezes <@333333333333333333>',
    credited: 'Bob#0001',
    description: 'Clip: https://medal.tv/clips/abc123 and https://cdn.discordapp.com/attachments/1/2/vid.mp4 my roblox id is 2693039158, ask @ana or ana@mail.com **asap**, ana found it with Bob',
  });
  const [r] = (await bugSearch.search(prisma, { query: 'aizen freezes' })).results;
  assert.deepEqual(Object.keys(r).sort(), ['reportedAt', 'severity', 'status', 'summary', 'title', 'where']);
  const text = JSON.stringify(r);
  for (const leak of ['@ana', 'ana@', ' ana ', 'Bob', 'medal', 'cdn.discordapp', '2693039158', '333333333333333333', 'http', '**']) assert.ok(!text.includes(leak), leak);
  assert.equal(r.title, 'Aizen ult freezes');
  assert.equal(r.summary, 'Clip: and my roblox id is , ask or asap, found it with');
});

test('test game and live game reports can be told apart', async () => {
  const { prisma, report } = await createDb();
  const t = await report({ title: 'Portal stuck', description: 'x', tags: ['test-game'] });
  await report({ title: 'Portal stuck in lobby', description: 'x', tags: ['live-game'] });
  await report({ title: 'Portal stuck forever', description: 'from the old forum' });
  await tickets.register(prisma, { reportId: t.id, channelId: '1', kind: 'test', number: 4, name: 'test-game-0004' }).catch(() => {});
  const where = async w => (await bugSearch.search(prisma, { query: 'portal stuck', where: w })).results.map(r => [r.title, r.where]);
  assert.deepEqual(await where('live'), [['Portal stuck in lobby', 'live'], ['Portal stuck forever', null]], 'forum reports (unknown) show in both');
  assert.deepEqual(await where('test'), [['Portal stuck', 'test'], ['Portal stuck forever', null]]);
  assert.equal((await where()).length, 3);
});
