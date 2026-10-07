// Applies a parsed sheet (see parse.js) to the database. Idempotent: every
// entity is matched on its stable key and only differences are written, so
// running it twice changes nothing the second time. All writes go through
// the service with source = 'import'.

const q = require('../queries');
const service = require('../service');
const { norm } = require('./parse');

// The tabs the importer reads, matched case-insensitively against the sheet.
const TAB_TITLES = {
  updates: ['Updates'],
  items: ['Update Content', 'Content'],
  templates: ['Templates'],
  tasks: ['Task Tracker', 'Tasks'],
  devs: ['Devs'],
  lists: ['Lists'],
  devLists: ['Dev Lists'],
};

function resolveTabs(available) {
  const byNorm = new Map(available.map(t => [norm(t), t]));
  const found = {};
  const missing = [];
  for (const [key, names] of Object.entries(TAB_TITLES)) {
    const hit = names.map(n => byNorm.get(norm(n))).find(Boolean);
    if (hit) found[key] = hit;
    else missing.push(names[0]);
  }
  return { found, missing };
}

// Reads every tab the importer uses. With a service account it goes through
// the Sheets API; without one it reads a link-shared sheet anonymously.
async function readSheetTabs(sheetId, log = () => {}) {
  const client = require('./client');
  const wanted = Object.fromEntries(Object.entries(TAB_TITLES).map(([key, names]) => [key, names[0]]));
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const { token, email } = await client.getAccessToken({ readOnly: true });
    log(`Reading sheet as ${email}`);
    const titles = (await client.listTabs(token, sheetId)).map(t => t.title);
    const { found, missing } = resolveTabs(titles);
    if (missing.length) log(`Tabs not found (skipped): ${missing.join(', ')}\nTabs in the sheet: ${titles.join(', ')}`);
    const keys = Object.keys(found);
    const values = await client.readTabs(token, sheetId, keys.map(k => found[k]));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  }
  log('No service account set: reading the sheet through its public link');
  const listed = await client.listPublicTabs(sheetId);
  const { found } = resolveTabs(listed.map(t => t.title));
  const keys = Object.keys(wanted);
  const values = await client.readPublicTabs(sheetId, keys.map(k => found[k] || wanted[k]), listed);
  return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

async function applyImportPlan(prisma, plan, { actorName = 'Sheet import' } = {}) {
  const ctx = { prisma, source: 'import', actor: { userId: null, name: actorName }, silent: true };
  const stats = { created: {}, updated: {} };
  const bump = (kind, what) => { stats[kind][what] = (stats[kind][what] || 0) + 1; };

  // disciplines and content types
  const knownDisciplines = new Set(await q.listDisciplines(prisma));
  for (const name of plan.disciplines) {
    if (!knownDisciplines.has(name)) { await service.addDiscipline(ctx, name); bump('created', 'disciplines'); }
  }
  let types = await q.listContentTypes(prisma);
  for (const name of plan.contentTypes) {
    if (!types.some(t => norm(t.name) === norm(name))) { await service.createContentType(ctx, { name }); bump('created', 'contentTypes'); }
  }
  types = await q.listContentTypes(prisma);
  const typeId = name => types.find(t => norm(t.name) === norm(name))?.id;

  // devs
  let devs = await q.listDevs(prisma);
  for (const d of plan.devs) {
    const existing = devs.find(x => norm(x.name) === norm(d.name));
    const data = {
      name: d.name, discipline: d.discipline, secondaryDiscipline: d.secondaryDiscipline, status: d.status,
      discordProfileUrl: d.discordProfileUrl, notes: d.notes, disciplines: d.disciplines,
    };
    if (!existing) { await service.createDev(ctx, data); bump('created', 'devs'); continue; }
    // Disciplines only ever grow on re-import, so a manual addition on the page survives.
    const merged = [...new Set([...existing.disciplines, ...d.disciplines])];
    const before = JSON.stringify([existing.discipline, existing.secondaryDiscipline, existing.status, existing.discordProfileUrl, existing.notes, existing.disciplines]);
    const after = await service.updateDev(ctx, existing.id, { ...data, name: undefined, disciplines: merged });
    if (before !== JSON.stringify([after.discipline, after.secondaryDiscipline, after.status, after.discordProfileUrl, after.notes, after.disciplines])) bump('updated', 'devs');
  }
  devs = await q.listDevs(prisma);
  const devId = name => (name ? devs.find(x => norm(x.name) === norm(name))?.id || null : null);

  // templates, keyed on Task ID
  let templates = await q.listTemplates(prisma);
  for (const t of plan.templates) {
    const existing = templates.find(x => x.taskCode === t.taskCode);
    const data = { discipline: t.discipline, deliverable: t.deliverable, definitionOfDone: t.definitionOfDone, required: t.required, taskNumber: t.taskNumber };
    if (!existing) {
      await service.createTemplate(ctx, { ...data, taskCode: t.taskCode, contentTypeId: typeId(t.contentType) });
      bump('created', 'templates');
    } else if (['discipline', 'deliverable', 'definitionOfDone', 'required', 'taskNumber'].some(f => (existing[f] ?? null) !== (data[f] ?? null))) {
      await service.updateTemplate(ctx, existing.id, data);
      bump('updated', 'templates');
    }
  }
  templates = await q.listTemplates(prisma);
  const templateId = code => templates.find(x => x.taskCode === code)?.id;

  // updates, keyed on Update #
  let updates = await q.listUpdates(prisma);
  for (const u of plan.updates) {
    const existing = updates.find(x => x.number === u.number);
    const { notes, notionUrl } = service.splitNotionUrl(u.notes);
    const leadDevId = devId(u.leadDev);
    const data = { name: u.name, status: u.status, targetRelease: u.targetRelease, leadDevId, leadName: leadDevId ? null : u.leadName, notes, notionUrl };
    if (!existing) { await service.createUpdate(ctx, { ...data, number: u.number }); bump('created', 'updates'); continue; }
    const before = existing.name + existing.status + existing.targetRelease + existing.leadDevId + existing.leadName + existing.notes + existing.notionUrl;
    const after = await service.updateUpdate(ctx, existing.id, data);
    if (before !== after.name + after.status + after.targetRelease + after.leadDevId + after.leadName + after.notes + after.notionUrl) bump('updated', 'updates');
  }
  updates = await q.listUpdates(prisma);
  const updateId = number => updates.find(x => x.number === number)?.id;

  // content items, keyed on Update # + Internal Name
  let items = await q.listItems(prisma, { includeArchived: true });
  const itemKey = (uId, internalName) => `${uId}:${norm(internalName)}`;
  const itemByKey = new Map(items.map(i => [itemKey(i.updateId, i.internalName), i]));
  const usedNumbers = new Set(items.map(i => i.itemNumber));
  for (const it of plan.items) {
    const uId = updateId(it.updateNumber);
    const existing = itemByKey.get(itemKey(uId, it.internalName));
    const { notes, notionUrl } = service.splitNotionUrl(it.notes);
    const ownerDevId = devId(it.ownerDev);
    const data = { displayName: it.displayName, priority: it.priority, ownerDevId, ownerName: ownerDevId ? null : it.ownerName, notes, notionUrl };
    if (!existing) {
      const itemNumber = it.itemNumber !== null && !usedNumbers.has(it.itemNumber) ? it.itemNumber : undefined;
      const created = await service.createContentItem(ctx, { ...data, updateId: uId, contentTypeId: typeId(it.contentType), internalName: it.internalName, itemNumber });
      usedNumbers.add(created.itemNumber);
      bump('created', 'items');
      continue;
    }
    const before = [existing.displayName, existing.priority, existing.ownerDevId, existing.ownerName, existing.notes, existing.notionUrl].join('|');
    const after = await service.updateContentItem(ctx, existing.id, data);
    if (before !== [after.displayName, after.priority, after.ownerDevId, after.ownerName, after.notes, after.notionUrl].join('|')) bump('updated', 'items');
  }
  items = await q.listItems(prisma, { includeArchived: true });
  const itemId = new Map(items.map(i => [itemKey(i.updateId, i.internalName), i.id]));

  // tasks: only the manual fields, attached to the task generated from the template
  const taskRows = await prisma.$queryRawUnsafe(`SELECT id, "contentItemId", "templateId" FROM "AssetTask"`);
  const taskId = new Map(taskRows.map(t => [`${t.contentItemId}:${t.templateId}`, t.id]));
  const patches = [];
  let unmatched = 0;
  for (const t of plan.tasks) {
    const id = taskId.get(`${itemId.get(itemKey(updateId(t.updateNumber), t.internalName))}:${templateId(t.taskCode)}`);
    if (!id) { unmatched++; continue; }
    const patch = {};
    if (t.status) patch.status = t.status;
    if (t.assignee) patch.assigneeDevId = devId(t.assignee);
    if (t.dueDate) patch.dueDate = t.dueDate;
    if (t.notes) patch.notes = t.notes;
    if (Object.keys(patch).length) patches.push({ id, patch });
  }
  const changed = await service.applyTaskPatches(ctx, patches);
  stats.updated.tasks = changed.length;
  stats.unmatchedTaskRows = unmatched;

  // One event for the whole import instead of one per row.
  try { require('../../events').broadcast('assets.changed', { kind: 'import', source: 'import', timestamp: new Date().toISOString() }); } catch { /* no listeners */ }
  return stats;
}

module.exports = { TAB_TITLES, resolveTabs, readSheetTabs, applyImportPlan };
