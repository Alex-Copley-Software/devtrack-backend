// Test harness: an in-process Postgres (PGlite) behind the two Prisma raw
// methods the asset tracker uses, so tests run the real SQL with no server.

const { PGlite } = require('@electric-sql/pglite');
const { ensureAssetSchema } = require('../../src/assets/schema');
const service = require('../../src/assets/service');
const q = require('../../src/assets/queries');

async function createTestDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`); // match production, where timestamps are stored in UTC
  // Read TIMESTAMP columns (type 1114) as UTC, the way Prisma does. PGlite's default reads them as local time.
  const parsers = { 1114: value => new Date(`${value.replace(' ', 'T')}Z`) };
  const prisma = {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).affectedRows ?? 0,
    close: () => pg.close(),
  };
  // The only pre-existing table the asset schema references.
  await pg.exec(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "name" TEXT, "email" TEXT, "role" TEXT, "pageAccess" TEXT[])`);
  await ensureAssetSchema(prisma);
  return prisma;
}

function ctxFor(prisma, overrides = {}) {
  return { prisma, source: 'human', actor: { userId: 'user-1', name: 'Tester' }, silent: true, ...overrides };
}

// A small update with one Unit item and a three-task Unit template.
async function seedBasics(prisma) {
  const ctx = ctxFor(prisma);
  const types = await q.listContentTypes(prisma);
  const unit = types.find(t => t.name === 'Unit');
  const boss = types.find(t => t.name === 'Boss');
  const templates = [];
  for (const [discipline, deliverable] of [['Design', 'Unit design brief'], ['Animation', 'Attack animations'], ['VFX', 'Ability VFX']]) {
    templates.push((await service.createTemplate(ctx, { contentTypeId: unit.id, discipline, deliverable, definitionOfDone: `${deliverable} approved` })).template);
  }
  const bee = await service.createDev(ctx, { name: 'MrBee', discipline: 'Manager', discordProfileUrl: 'https://discord.com/users/111111111111111111' });
  const ani = await service.createDev(ctx, { name: 'Ani', discipline: 'Animation', secondaryDiscipline: 'VFX', discordProfileUrl: 'https://discord.com/users/222222222222222222' });
  const update = await service.createUpdate(ctx, { number: 4, name: 'Bleach', status: 'In Development', leadDevId: bee.id });
  const aizen = await service.createContentItem(ctx, { updateId: update.id, contentTypeId: unit.id, displayName: 'Mythic', internalName: 'Aizen', priority: 'High' });
  return { ctx, unit, boss, templates, bee, ani, update, aizen };
}

module.exports = { createTestDb, ctxFor, seedBasics };
