const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedBasics } = require('./helpers');
const service = require('../../src/assets/service');
const q = require('../../src/assets/queries');
const { progressOf, workloadOf } = require('../../src/assets/rollups');

test('progress is Done over tasks that are not N/A', () => {
  assert.equal(progressOf({ done: 0, countable: 0 }), 0);
  assert.equal(progressOf({ done: 1, countable: 3 }), 0.333);
  assert.equal(progressOf({ done: 4, countable: 4 }), 1);
});

test('workload bar caps at the ceiling', () => {
  assert.deepEqual(workloadOf(0), { ratio: 0, level: 'light' });
  assert.equal(workloadOf(6).level, 'steady');
  assert.deepEqual(workloadOf(40), { ratio: 1, level: 'heavy' });
});

test('item, update and discipline rollups come from task state', async () => {
  const prisma = await createTestDb();
  const { ctx, update, aizen, ani } = await seedBasics(prisma);
  const [design, animation, vfx] = await q.listTasks(prisma, { contentItemId: aizen.id });
  await service.updateTask(ctx, design.id, { status: 'Done' });
  await service.updateTask(ctx, animation.id, { status: 'Blocked', assigneeDevId: ani.id });
  await service.updateTask(ctx, vfx.id, { status: 'N/A' });

  const item = await q.getItem(prisma, aizen.id);
  assert.equal(item.taskCount, 3);
  assert.equal(item.countable, 2, 'N/A is excluded from the denominator');
  assert.equal(item.done, 1);
  assert.equal(item.blocked, 1);
  assert.equal(item.progress, 0.5);
  assert.deepEqual(
    item.disciplines.map(d => [d.discipline, d.done, d.countable]).sort(),
    [['Animation', 0, 1], ['Design', 1, 1], ['VFX', 0, 0]]);

  const up = await q.getUpdate(prisma, update.id);
  assert.equal(up.itemCount, 1);
  assert.equal(up.progress, 0.5);
  assert.equal(up.leadName, 'MrBee');

  const overview = await q.getUpdateOverview(prisma, update.id);
  assert.deepEqual(overview.attention.blocked, [animation.id]);
  assert.deepEqual(overview.attention.noOwner, [aizen.id]);
  // Animation is assigned and VFX is N/A, so nothing required is left unassigned.
  assert.deepEqual(overview.attention.unassignedRequired, []);
  assert.equal(overview.disciplines.find(d => d.discipline === 'Design').progress, 1);
});

test('overdue only counts open tasks with a past due date', async () => {
  const prisma = await createTestDb();
  const { ctx, update, aizen } = await seedBasics(prisma);
  const [a, b, c] = await q.listTasks(prisma, { contentItemId: aizen.id });
  await service.updateTask(ctx, a.id, { dueDate: '2020-01-01' });
  await service.updateTask(ctx, b.id, { dueDate: '2020-01-01', status: 'Done' });
  await service.updateTask(ctx, c.id, { dueDate: '2999-01-01' });
  const overview = await q.getUpdateOverview(prisma, update.id);
  assert.deepEqual(overview.attention.overdue, [a.id]);
});

test('dev workload counts open tasks, and ignores released updates and archived items', async () => {
  const prisma = await createTestDb();
  const { ctx, update, aizen, ani } = await seedBasics(prisma);
  const [a, b, c] = await q.listTasks(prisma, { contentItemId: aizen.id });
  await service.updateTasks(ctx, [a.id, b.id, c.id], { assigneeDevId: ani.id });
  await service.updateTask(ctx, c.id, { status: 'Done' });

  let dev = (await q.listDevs(prisma)).find(d => d.id === ani.id);
  assert.equal(dev.openTasks, 2);
  assert.equal(dev.doneTasks, 1);

  await service.updateUpdate(ctx, update.id, { status: 'Released' });
  dev = (await q.listDevs(prisma)).find(d => d.id === ani.id);
  assert.equal(dev.openTasks, 0, 'released update no longer counts as load');
  assert.equal(dev.doneTasks, 1);

  await service.updateUpdate(ctx, update.id, { status: 'In Development' });
  await service.updateContentItem(ctx, aizen.id, { archived: true });
  dev = (await q.listDevs(prisma)).find(d => d.id === ani.id);
  assert.equal(dev.openTasks, 0, 'archived item no longer counts as load');
  assert.equal((await q.getUpdate(prisma, update.id)).itemCount, 0);
});

test('bulk edits apply to every task in one pass and log each change', async () => {
  const prisma = await createTestDb();
  const { ctx, aizen, ani } = await seedBasics(prisma);
  const tasks = await q.listTasks(prisma, { contentItemId: aizen.id });
  const changed = await service.updateTasks(ctx, tasks.map(t => t.id), { status: 'In Progress', assigneeDevId: ani.id });
  assert.equal(changed.length, 3);
  assert.ok(changed.every(t => t.status === 'In Progress' && t.assigneeDevId === ani.id));
  assert.equal((await q.listActivity(prisma, { contentItemId: aizen.id })).filter(a => a.entityType === 'task').length, 6);
});
