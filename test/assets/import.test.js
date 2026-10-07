const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb } = require('./helpers');
const fixture = require('./fixtures/sheet');
const { buildImportPlan, formatReport, parseSheetDate, findHeader } = require('../../src/assets/sheets/parse');
const { applyImportPlan, resolveTabs } = require('../../src/assets/sheets/importer');
const { buildExportRows } = require('../../src/assets/sheets/exporter');
const q = require('../../src/assets/queries');

test('sheet dates: serial numbers, ISO and US strings', () => {
  assert.equal(parseSheetDate(46327), '2026-11-01');
  assert.equal(parseSheetDate('2026-11-01'), '2026-11-01');
  assert.equal(parseSheetDate('11/20/2026'), '2026-11-20');
  assert.equal(parseSheetDate(''), null);
  assert.equal(parseSheetDate('soon'), undefined);
});

test('the header row is found below the title, description and blank rows', () => {
  assert.equal(findHeader(fixture.updates, 'updates').headerIndex, 3);
  assert.equal(findHeader(fixture.tasks, 'tasks').headerIndex, 3);
});

test('tab names are matched case-insensitively and missing tabs are reported', () => {
  const { found, missing } = resolveTabs(['updates', 'Update Content', 'TEMPLATES', 'Task Tracker', 'Devs', 'Dashboard', 'How To Use']);
  assert.equal(found.updates, 'updates');
  assert.equal(found.templates, 'TEMPLATES');
  assert.deepEqual(missing, ['Lists', 'Dev Lists']);
});

test('dry-run plan: counts, ignored computed columns and every unmapped row', () => {
  const plan = buildImportPlan(fixture);
  assert.equal(plan.counts.devs, 3);
  assert.equal(plan.counts.templates, 5);
  assert.equal(plan.counts.updates, 3);
  assert.equal(plan.counts.items, 3);
  assert.equal(plan.counts.taskRows, 6);
  assert.deepEqual(plan.contentTypes, ['Unit', 'Map / Stage', 'Boss', 'Skin']);
  assert.ok(plan.disciplines.includes('Lighting'), 'disciplines come from the Lists tab');

  const bleach = plan.updates.find(u => u.number === 4);
  assert.equal(bleach.targetRelease, '2026-11-01');
  assert.equal(bleach.leadDev, 'MrBee');
  assert.equal(plan.updates.find(u => u.number === 5).status, 'Planning', 'case-insensitive enum match');
  assert.deepEqual(plan.devs.find(d => d.name === 'Vex').disciplines, ['VFX', 'Lighting']);

  const issues = plan.problems.map(p => p.issue).join('\n');
  for (const expected of [
    'Unknown dev status "Retired"', 'Unknown secondary discipline "Juggling"', 'No Discord user id',
    '"Stranger" is listed under Lighting', 'Unknown discipline "Cooking"', 'Lead "Somebody Else"',
    'Unknown update status "On Fire"', 'Owner "Ghost"', 'Unknown content type "Vehicle"', 'Update #9 is not on the Updates tab',
    'Unknown dev "Nobody"', 'Status "Almost" is outside the list', 'Task ID T0999 is not on the Templates tab',
    'No matching content item for T0001 / item 77',
  ]) assert.ok(issues.includes(expected), `expected a problem mentioning: ${expected}`);
  assert.equal(plan.problems.length, 14);
  assert.match(formatReport(plan), /Could not map 14 row\(s\)/);
});

test('import writes everything, keeps manual task fields on the right task, and is idempotent', async () => {
  const prisma = await createTestDb();
  const plan = buildImportPlan(fixture);
  const first = await applyImportPlan(prisma, plan);
  assert.equal(first.created.devs, 3);
  assert.equal(first.created.templates, 5);
  assert.equal(first.created.updates, 3);
  assert.equal(first.created.items, 3);
  assert.equal(first.unmatchedTaskRows, 0);

  const updates = await q.listUpdates(prisma);
  const bleach = updates.find(u => u.number === 4);
  assert.equal(bleach.leadName, 'MrBee');
  assert.equal(bleach.notionUrl, 'https://www.notion.so/ae/Bleach-abc123');
  assert.equal(bleach.notes, null, 'a notes cell that is only a Notion link becomes the link');
  assert.equal(bleach.itemCount, 3);
  assert.equal(bleach.taskCount, 8, '3 + 3 Unit tasks and 2 Boss tasks, generated from templates');
  assert.equal(updates.find(u => u.number === 5).leadName, 'Somebody Else', 'unknown lead kept as text');

  const items = await q.listItems(prisma, { updateId: bleach.id });
  assert.deepEqual(items.map(i => [i.itemNumber, i.internalName]), [[1, 'Ulquiorra'], [2, 'Aizen'], [3, 'Yhwach']]);
  assert.equal(items[2].ownerName, 'Ghost');

  const tasks = await q.listTasksDetailed(prisma, { updateId: bleach.id });
  const find = (name, code) => tasks.find(t => t.internalName === name && t.taskCode === code);
  assert.equal(find('Ulquiorra', 'T0001').status, 'Done');
  assert.equal(find('Ulquiorra', 'T0001').assigneeName, 'MrBee');
  const anim = find('Ulquiorra', 'T0002');
  assert.deepEqual([anim.status, anim.assigneeName, anim.dueDate, anim.notes], ['In Progress', 'Ani', '2026-11-09', 'rbxassetid://123']);
  const aizenDesign = find('Aizen', 'T0001');
  assert.deepEqual([aizenDesign.status, aizenDesign.assigneeName, aizenDesign.dueDate], ['Review', null, '2026-11-20']);
  assert.equal(find('Aizen', 'T0002').status, 'Not Started', 'status outside the enum is not imported');
  assert.equal(find('Aizen', 'T0002').assigneeName, 'Ani');
  assert.equal(find('Yhwach', 'T0010').status, 'Blocked');

  const importLog = await prisma.$queryRawUnsafe(`SELECT DISTINCT source FROM "AssetActivity"`);
  assert.deepEqual(importLog.map(r => r.source), ['import']);
  const [{ n: before }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetActivity"`);

  // Second run: nothing created, nothing changed, nothing logged.
  const second = await applyImportPlan(prisma, plan);
  assert.deepEqual(second.created, {});
  assert.deepEqual(second.updated, { tasks: 0 });
  const [{ n: after }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetActivity"`);
  assert.equal(after, before);
  assert.equal((await q.listTasksDetailed(prisma, { updateId: bleach.id })).length, 8);
});

test('re-import does not undo edits made in DevTrack to fields the sheet leaves blank', async () => {
  const prisma = await createTestDb();
  const plan = buildImportPlan(fixture);
  await applyImportPlan(prisma, plan);
  const service = require('../../src/assets/service');
  const [vfx] = (await q.listTasksDetailed(prisma)).filter(t => t.internalName === 'Ulquiorra' && t.taskCode === 'T0003');
  await service.updateTask({ prisma, source: 'human', actor: { userId: 'u', name: 'Human' }, silent: true }, vfx.id, { notes: 'added in DevTrack' });
  await applyImportPlan(prisma, plan);
  const [again] = (await q.listTasksDetailed(prisma)).filter(t => t.id === vfx.id);
  assert.equal(again.notes, 'added in DevTrack');
});

test('export rows: header plus one row per active task', async () => {
  const prisma = await createTestDb();
  await applyImportPlan(prisma, buildImportPlan(fixture));
  const rows = await buildExportRows(prisma);
  assert.equal(rows[2][0], 'Update #');
  assert.equal(rows.length, 3 + 8);
  const anim = rows.find(r => r[4] === 'Ulquiorra' && r[14] === 'T0002');
  assert.deepEqual([anim[10], anim[11], anim[12]], ['Ani', 'In Progress', '2026-11-09']);
});
