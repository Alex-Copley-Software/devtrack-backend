// Developers: the list of devs and where each one's dot goes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const devs = require('../src/devs');

async function createDb(withOldRoster) {
  const pg = new PGlite();
  const prisma = {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).affectedRows ?? 0,
  };
  if (withOldRoster) {
    await pg.exec(`CREATE TABLE "AssetDev" (id TEXT, name TEXT, "discordUserId" TEXT, "discordThreadId" TEXT, status TEXT)`);
    await pg.exec(`INSERT INTO "AssetDev" VALUES ('1', 'Ruku', '111111111111111111', '222222222222222222', 'Active'),
      ('2', 'Zaico', '333333333333333333', NULL, 'Active'), ('3', 'Gone', NULL, NULL, 'Inactive')`);
  }
  return prisma;
}

test('the list starts from the old asset roster, once', async () => {
  const prisma = await createDb(true);
  const first = await devs.list(prisma);
  assert.deepEqual(first.map(d => [d.name, d.discordUserId, d.channelId]), [
    ['Ruku', '111111111111111111', '222222222222222222'],
    ['Zaico', '333333333333333333', null],
  ]);
  await devs.remove(first[1].id, prisma);
  assert.equal((await devs.list(prisma)).length, 1, 'a removed dev is not brought back');
});

test('devs are added, changed and removed; links and bad input are handled', async () => {
  const prisma = await createDb(false);
  assert.deepEqual(await devs.list(prisma), []);
  const ruku = await devs.create({ name: '  Ruku ', discordUserId: '111111111111111111', channelId: 'https://discord.com/channels/9999999999999999/222222222222222222' }, prisma);
  assert.equal(ruku.name, 'Ruku');
  assert.equal(ruku.channelId, '222222222222222222', 'a pasted channel link keeps the channel ID');
  await assert.rejects(devs.create({ name: 'ruku' }, prisma), /already a dev called/);
  await assert.rejects(devs.create({ name: 'Ruku Two', discordUserId: '111111111111111111' }, prisma), /already Ruku's/);
  await assert.rejects(devs.create({ name: 'X', channelId: 'general' }, prisma), /not a Discord ID/);
  await assert.rejects(devs.create({ name: '' }, prisma), /name is required/);

  const moved = await devs.update(ruku.id, { channelId: '444444444444444444' }, prisma);
  assert.equal(moved.channelId, '444444444444444444');
  assert.equal(moved.discordUserId, '111111111111111111', 'fields not sent are left alone');
  const cleared = await devs.update(ruku.id, { channelId: '' }, prisma);
  assert.equal(cleared.channelId, null);

  await devs.setChannels([{ id: '444444444444444444', name: 'ruku', type: 'forum', parentId: '1', parentName: 'Modelers' }], prisma);
  await devs.setStatus({ [ruku.id]: { dot: 'busy', tasks: [{ identifier: 'ASS-73', title: 'Texture - Ruku' }] } }, prisma);
  const all = await devs.overview(prisma);
  assert.equal(all.channels[0].parentName, 'Modelers');
  assert.equal(all.status[ruku.id].tasks[0].identifier, 'ASS-73');
  assert.ok(all.syncedAt);

  await devs.remove(ruku.id, prisma);
  assert.equal((await devs.list(prisma)).length, 0);
});
