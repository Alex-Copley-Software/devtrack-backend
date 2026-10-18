const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const devTags = require('../src/dev-tags');

async function createDb() {
  const pg = new PGlite();
  const prisma = {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).affectedRows ?? 0,
  };
  await pg.exec(`CREATE TABLE "Report" ("id" TEXT PRIMARY KEY, "discordThreadId" TEXT);
    INSERT INTO "Report" VALUES ('r1','t1'), ('r2','t2'), ('r3', NULL);`);
  return prisma;
}

test('dev tags are saved per forum post, and only changes are reported', async () => {
  const prisma = await createDb();
  assert.deepEqual(await devTags.setForThreads(prisma, [{ threadId: 't1', devTags: ['Ricky', 'Bryan', 'Ricky', ' '] }, { threadId: 't9', devTags: ['Yose'] }]), ['r1']);
  const tagsOf = async id => (await prisma.$queryRawUnsafe(`SELECT "devTags" FROM "Report" WHERE id = $1`, id))[0].devTags;
  assert.deepEqual(await tagsOf('r1'), ['Bryan', 'Ricky']);
  assert.deepEqual(await tagsOf('r2'), []);
  // Same tags again: nothing changes. Removing them all clears the list.
  assert.deepEqual(await devTags.setForThreads(prisma, [{ threadId: 't1', devTags: ['Ricky', 'Bryan'] }]), []);
  assert.deepEqual(await devTags.setForThreads(prisma, [{ threadId: 't1', devTags: [] }, { threadId: '', devTags: ['Vaayu'] }]), ['r1']);
  assert.deepEqual(await tagsOf('r1'), []);
});
