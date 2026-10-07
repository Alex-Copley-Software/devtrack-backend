const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, ctxFor, seedBasics } = require('./helpers');
const service = require('../../src/assets/service');
const q = require('../../src/assets/queries');
const audit = require('../../src/assets/audit');
const perms = require('../../src/assets/permissions');

const admin = perms.accessFor({ role: 'admin' });
const viewer = perms.accessFor({ role: 'qa' });
// Activity rows are ordered by timestamp, so give each step its own.
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

async function setup() {
  const prisma = await createTestDb();
  const seed = await seedBasics(prisma);
  const tasks = await q.listTasksDetailed(prisma, { contentItemId: seed.aizen.id });
  const byDiscipline = Object.fromEntries(tasks.map(t => [t.discipline, t]));
  const task = async id => (await prisma.$queryRawUnsafe(
    `SELECT status, "assigneeDevId", notes, to_char("dueDate", 'YYYY-MM-DD') AS "dueDate" FROM "AssetTask" WHERE id = $1`, id))[0];
  return { prisma, ...seed, byDiscipline, task };
}

test('the log records who did what, with context, and can be filtered and searched', async () => {
  const { prisma, byDiscipline, ani } = await setup();
  const vfx = byDiscipline.VFX;
  await service.updateTask(ctxFor(prisma, { actor: { userId: 'u-1', name: 'Alex' } }), vfx.id, { status: 'In Progress', assigneeDevId: ani.id });
  await tick();
  await service.updateTask(ctxFor(prisma, { actor: { userId: 'u-2', name: 'Sam' } }), vfx.id, { status: 'Done' });

  const byAlex = await audit.listAudit(prisma, { actor: 'Alex' });
  assert.equal(byAlex.total, 2);
  const status = byAlex.rows.find(r => r.field === 'status');
  assert.deepEqual([status.before, status.after, status.actorName, status.revertible], ['Not Started', 'In Progress', 'Alex', true]);
  assert.deepEqual([status.taskDeliverable, status.itemName, status.updateNumber], ['Ability VFX', 'Aizen', 4]);
  assert.ok(status.createdAt instanceof Date);

  assert.equal((await audit.listAudit(prisma, { q: 'ability vfx', field: 'status' })).total, 2);
  assert.equal((await audit.listAudit(prisma, { entityType: 'task', action: 'updated', limit: 1 })).rows.length, 1);
  assert.equal((await audit.listAudit(prisma, { from: '2999-01-01' })).total, 0);
  const created = (await audit.listAudit(prisma, { action: 'created' })).rows;
  assert.ok(created.length && created.every(r => !r.revertible), 'creations have no undo');
  assert.ok((await audit.facets(prisma)).actors.some(a => a.name === 'Sam'));
});

test('reverting one entry puts the field back and records who reverted it', async () => {
  const { prisma, byDiscipline, task } = await setup();
  const vfx = byDiscipline.VFX;
  await service.updateTask(ctxFor(prisma), vfx.id, { status: 'Done' });
  const [entry] = (await audit.listAudit(prisma, { taskId: vfx.id, field: 'status' })).rows;

  const preview = await audit.revertEntries(ctxFor(prisma), admin, [entry.id], { dryRun: true });
  assert.deepEqual(preview.changes.map(c => [c.field, c.current, c.target, c.changedSince]), [['status', 'Done', 'Not Started', false]]);
  assert.equal((await task(vfx.id)).status, 'Done', 'a dry run changes nothing');

  const ctx = ctxFor(prisma, { actor: { userId: 'u-9', name: 'Morgan' } });
  const result = await audit.revertEntries(ctx, admin, [entry.id]);
  assert.equal(result.applied, 1);
  assert.equal((await task(vfx.id)).status, 'Not Started');

  const [latest] = (await audit.listAudit(prisma, { taskId: vfx.id, field: 'status' })).rows;
  assert.deepEqual([latest.actorName, latest.revertOf, latest.before, latest.after], ['Morgan', entry.id, 'Done', 'Not Started']);
  assert.equal((await audit.listAudit(prisma, { reverts: 'true' })).total, 1);

  // Nothing left to do the second time.
  assert.equal((await audit.revertEntries(ctx, admin, [entry.id])).applied, 0);
});

test('a revert warns when the field was changed again since, and needs permission', async () => {
  const { prisma, byDiscipline, task } = await setup();
  const vfx = byDiscipline.VFX;
  await service.updateTask(ctxFor(prisma), vfx.id, { status: 'In Progress' });
  const [first] = (await audit.listAudit(prisma, { taskId: vfx.id, field: 'status' })).rows;
  await tick();
  await service.updateTask(ctxFor(prisma), vfx.id, { status: 'Review' });

  const preview = await audit.revertEntries(ctxFor(prisma), admin, [first.id], { dryRun: true });
  assert.deepEqual([preview.changes[0].current, preview.changes[0].target, preview.changes[0].changedSince], ['Review', 'Not Started', true]);

  await assert.rejects(audit.revertEntries(ctxFor(prisma), viewer, [first.id]), /permission/);
  assert.equal((await task(vfx.id)).status, 'Review');
});

test('restoring to an entry undoes everything after it, within the chosen scope', async () => {
  const { prisma, byDiscipline, ani, bee, aizen, update, task } = await setup();
  const vfx = byDiscipline.VFX;
  const anim = byDiscipline.Animation;
  const ctx = ctxFor(prisma);

  await service.updateTask(ctx, vfx.id, { status: 'In Progress', assigneeDevId: ani.id });
  const anchor = (await audit.listAudit(prisma, { taskId: vfx.id, field: 'status' })).rows[0];
  await tick();
  await service.updateTask(ctx, vfx.id, { status: 'Review', notes: 'rbxassetid://1' });
  await tick();
  await service.updateTask(ctx, vfx.id, { status: 'Done', assigneeDevId: bee.id });
  await tick();
  await service.updateTask(ctx, anim.id, { status: 'Blocked' });
  await tick();
  await service.updateContentItem(ctx, aizen.id, { priority: 'Low' });
  await tick();
  await service.createContentItem(ctx, { updateId: update.id, contentTypeId: aizen.contentTypeId, internalName: 'Later' });

  // Just this task.
  const one = await audit.restoreToEntry(ctx, admin, anchor.id, { kind: 'entity' }, { dryRun: true });
  assert.deepEqual(one.changes.map(c => c.field).sort(), ['assigneeDevId', 'notes', 'status']);
  await audit.restoreToEntry(ctx, admin, anchor.id, { kind: 'entity' });
  assert.deepEqual(await task(vfx.id), { status: 'In Progress', assigneeDevId: ani.id, notes: null, dueDate: null });
  assert.equal((await task(anim.id)).status, 'Blocked', 'other tasks are left alone');

  // The whole update: the other task and the item go back too; the item created since is reported, not removed.
  const all = await audit.restoreToEntry(ctx, admin, anchor.id, { kind: 'update' }, { dryRun: true });
  assert.deepEqual(all.changes.map(c => `${c.entityType}.${c.field}`).sort(), ['item.priority', 'task.status']);
  assert.ok(all.unsupported >= 1);
  const done = await audit.restoreToEntry(ctx, admin, anchor.id, { kind: 'update' });
  assert.equal(done.applied, 2);
  assert.equal((await task(anim.id)).status, 'Not Started');
  assert.equal((await q.getItem(prisma, aizen.id)).priority, 'High');
  assert.equal((await q.listItems(prisma, { updateId: update.id })).length, 2);

  const restored = (await audit.listAudit(prisma, { action: 'restored' })).rows;
  assert.equal(restored.length, 2);
  assert.match(restored[0].label, /^Restored 2 fields to how this update stood at /);
});
