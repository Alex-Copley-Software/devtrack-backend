const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedBasics } = require('./helpers');
const service = require('../../src/assets/service');
const q = require('../../src/assets/queries');

test('creating a content item spawns one task per active template', async () => {
  const prisma = await createTestDb();
  const { aizen, templates } = await seedBasics(prisma);
  const tasks = await q.listTasks(prisma, { contentItemId: aizen.id });
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map(t => t.templateId), templates.map(t => t.id));
  assert.ok(tasks.every(t => t.status === 'Not Started' && t.assigneeDevId === null));
  assert.deepEqual(templates.map(t => t.taskCode), ['T0001', 'T0002', 'T0003']);
});

test('adding a template later adds the task to existing items without touching manual fields', async () => {
  const prisma = await createTestDb();
  const { ctx, unit, aizen, ani } = await seedBasics(prisma);
  const [first] = await q.listTasks(prisma, { contentItemId: aizen.id });
  await service.updateTask(ctx, first.id, { status: 'Review', assigneeDevId: ani.id, dueDate: '2026-11-01', notes: 'asset 123' });

  const preview = await service.previewTemplateImpact(prisma, { contentTypeId: unit.id, addCount: 1 });
  assert.equal(preview.tasksAdded, 1);

  const { template, tasksAdded } = await service.createTemplate(ctx, { contentTypeId: unit.id, discipline: 'SFX', deliverable: 'Ability sounds' });
  assert.equal(tasksAdded, 1);
  assert.equal(template.taskCode, 'T0004');

  const tasks = await q.listTasks(prisma, { contentItemId: aizen.id });
  assert.equal(tasks.length, 4);
  const kept = tasks.find(t => t.id === first.id);
  assert.equal(kept.status, 'Review');
  assert.equal(kept.assigneeDevId, ani.id);
  assert.equal(kept.dueDate, '2026-11-01');
  assert.equal(kept.notes, 'asset 123');
});

test('regenerating tasks for an item is idempotent', async () => {
  const prisma = await createTestDb();
  const { aizen } = await seedBasics(prisma);
  assert.equal(await service.generateTasksForItem(prisma, aizen.id), 0);
  assert.equal((await q.listTasks(prisma, { contentItemId: aizen.id })).length, 3);
});

test('removing a template hides its tasks but keeps them and their history; restoring brings them back', async () => {
  const prisma = await createTestDb();
  const { ctx, aizen, templates } = await seedBasics(prisma);
  const vfx = templates[2];
  const before = await q.listTasks(prisma, { contentItemId: aizen.id });
  const vfxTask = before.find(t => t.templateId === vfx.id);
  await service.updateTask(ctx, vfxTask.id, { status: 'In Progress' });

  const removed = await service.updateTemplate(ctx, vfx.id, { active: false });
  assert.equal(removed.tasksDeactivated, 1);
  assert.equal((await q.listTasks(prisma, { contentItemId: aizen.id })).length, 2);
  const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetTask" WHERE id = $1`, vfxTask.id);
  assert.equal(n, 1, 'row still exists');
  assert.equal((await q.listActivity(prisma, { taskId: vfxTask.id })).length, 1, 'history kept');

  // New items do not get the removed template's task.
  const second = await service.createContentItem(ctx, { updateId: aizen.updateId, contentTypeId: aizen.contentTypeId, internalName: 'Ulquiorra' });
  assert.equal(second.taskCount, 2);

  const restored = await service.updateTemplate(ctx, vfx.id, { active: true });
  assert.equal(restored.tasksAdded, 1, 'the item created while it was removed gets the task');
  const after = await q.listTasks(prisma, { contentItemId: aizen.id });
  assert.equal(after.find(t => t.id === vfxTask.id).status, 'In Progress');
});

test('internal name is unique within an update, case-insensitively', async () => {
  const prisma = await createTestDb();
  const { ctx, aizen } = await seedBasics(prisma);
  await assert.rejects(
    service.createContentItem(ctx, { updateId: aizen.updateId, contentTypeId: aizen.contentTypeId, internalName: 'aizen' }),
    err => err.status === 409);
});

test('task edits are validated and logged with before and after', async () => {
  const prisma = await createTestDb();
  const { ctx, aizen, ani } = await seedBasics(prisma);
  const [task] = await q.listTasks(prisma, { contentItemId: aizen.id });
  await assert.rejects(service.updateTask(ctx, task.id, { status: 'Finished' }), err => err.status === 400);
  await assert.rejects(service.updateTask(ctx, task.id, { assigneeDevId: 'nobody' }), err => err.status === 400);
  await assert.rejects(service.updateTask(ctx, task.id, { dueDate: '11/01/2026' }), err => err.status === 400);

  await service.updateTask(ctx, task.id, { status: 'Done', assigneeDevId: ani.id });
  const log = await q.listActivity(prisma, { taskId: task.id });
  assert.equal(log.length, 2);
  const status = log.find(a => a.field === 'status');
  assert.equal(status.before, 'Not Started');
  assert.equal(status.after, 'Done');
  assert.equal(status.source, 'human');
  assert.equal(status.actorName, 'Tester');
  assert.deepEqual(log.find(a => a.field === 'assigneeDevId').after, { id: ani.id, name: 'Ani' });

  // A no-op edit writes nothing.
  await service.updateTask(ctx, task.id, { status: 'Done' });
  assert.equal((await q.listActivity(prisma, { taskId: task.id })).length, 2);
});

test('dev Discord id is parsed from the profile link and disciplines include primary and secondary', async () => {
  const prisma = await createTestDb();
  const { ani } = await seedBasics(prisma);
  assert.equal(ani.discordUserId, '222222222222222222');
  assert.deepEqual(ani.disciplines, ['Animation', 'VFX']);
});

test('a blocked task needs a reason, and the reason goes when the block does', async () => {
  const prisma = await createTestDb();
  const { ctx, aizen } = await seedBasics(prisma);
  const [task] = await q.listTasks(prisma, { contentItemId: aizen.id });
  await assert.rejects(service.updateTask(ctx, task.id, { status: 'Blocked' }), /what is blocking/);
  await assert.rejects(service.updateTask(ctx, task.id, { status: 'Blocked', blockedReason: '   ' }), /what is blocking/);
  assert.equal((await service.updateTask(ctx, task.id, { status: 'Blocked', blockedReason: 'waiting on concept art' })).blockedReason, 'waiting on concept art');
  // Other edits to a blocked task do not ask again, but the reason cannot be blanked.
  assert.equal((await service.updateTask(ctx, task.id, { notes: 'pinged the artist' })).blockedReason, 'waiting on concept art');
  await assert.rejects(service.updateTask(ctx, task.id, { blockedReason: '' }), /what is blocking/);
  const cleared = await service.updateTask(ctx, task.id, { status: 'In Progress' });
  assert.deepEqual([cleared.status, cleared.blockedReason], ['In Progress', null]);
});
