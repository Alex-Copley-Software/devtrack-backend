// Write side of the asset tracker. Every change, whether it comes from the
// page, the Discord agent or the sheet import, goes through here so it is
// validated the same way, written to AssetActivity and broadcast over SSE.
//
// ctx = { prisma, source: 'human' | 'agent' | 'import', actor: { userId, name },
//         suggestionId?, evidence? }
// Permission checks happen in the routes; the service trusts its caller.

const { newId } = require('./db');
const q = require('./queries');
const { TASK_STATUSES, PRIORITIES, UPDATE_STATUSES, DEV_STATUSES } = require('./constants');

class AssetError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = message => new AssetError(400, message);
const missing = what => new AssetError(404, `${what} not found`);

function notify(ctx, payload) {
  if (ctx.silent) return;
  try {
    require('../events').broadcast('assets.changed', {
      ...payload,
      source: ctx.source || 'human',
      actorUserId: ctx.actor?.userId || null,
      actorName: ctx.actor?.name || null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Assets] broadcast failed:', err.message);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const clean = v => (v === undefined || v === null ? null : String(v).trim() || null);

function parseDate(value, label = 'date') {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw bad(`Invalid ${label}`);
  return s;
}

function parseDiscordUserId(value) {
  const match = String(value || '').match(/(\d{17,20})/);
  return match ? match[1] : null;
}

// Notes cells in the sheet are often just a Notion link. Split it out so the
// page can render it as a chip.
function splitNotionUrl(text) {
  const raw = clean(text);
  if (!raw) return { notes: null, notionUrl: null };
  const match = raw.match(/https?:\/\/(?:[\w-]+\.)?notion\.(?:so|site|com)\/\S+/i);
  if (!match) return { notes: raw, notionUrl: null };
  return { notes: clean(raw.replace(match[0], '')), notionUrl: match[0] };
}

// Bulk insert through one JSON parameter, so a 6,000-task import is a
// handful of statements instead of thousands.
async function logActivity(ctx, rows) {
  if (!rows.length) return;
  const payload = rows.map(r => ({
    id: newId(),
    entityType: r.entityType,
    entityId: r.entityId,
    updateId: r.updateId || null,
    contentItemId: r.contentItemId || null,
    taskId: r.taskId || null,
    action: r.action,
    field: r.field || null,
    before: r.before === undefined ? null : r.before,
    after: r.after === undefined ? null : r.after,
    label: r.label || null,
    source: ctx.source || 'human',
    actorUserId: ctx.actor?.userId || null,
    actorName: ctx.actor?.name || 'System',
    suggestionId: ctx.suggestionId || null,
    evidence: ctx.evidence || null,
    revertOf: ctx.revertOf || null,
  }));
  for (let i = 0; i < payload.length; i += 500) {
    await ctx.prisma.$executeRawUnsafe(`
      INSERT INTO "AssetActivity" ("id", "entityType", "entityId", "updateId", "contentItemId", "taskId", "action",
        "field", "before", "after", "label", "source", "actorUserId", "actorName", "suggestionId", "evidence", "revertOf")
      SELECT v.id, v."entityType", v."entityId", v."updateId", v."contentItemId", v."taskId", v.action,
        v.field, v.before, v.after, v.label, v.source, v."actorUserId", v."actorName", v."suggestionId", v.evidence, v."revertOf"
      FROM jsonb_to_recordset($1::jsonb) AS v(
        id text, "entityType" text, "entityId" text, "updateId" text, "contentItemId" text, "taskId" text, action text,
        field text, before jsonb, after jsonb, label text, source text, "actorUserId" text, "actorName" text,
        "suggestionId" text, evidence jsonb, "revertOf" text)
    `, JSON.stringify(payload.slice(i, i + 500)));
  }
}

// Field-by-field diff of a patch against a row, as activity rows.
function diffFields(before, patch, base) {
  const rows = [];
  for (const [field, after] of Object.entries(patch)) {
    const prev = before[field] === undefined ? null : before[field];
    if (JSON.stringify(prev) === JSON.stringify(after)) continue;
    rows.push({ ...base, action: 'updated', field, before: prev, after });
  }
  return rows;
}

async function setColumns(prisma, table, id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  const sets = fields.map((f, i) => `"${f}" = $${i + 1}${f === 'targetRelease' || f === 'dueDate' ? '::date' : ''}`);
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET ${sets.join(', ')}, "updatedAt" = CURRENT_TIMESTAMP WHERE id = $${fields.length + 1}`,
    ...fields.map(f => patch[f]), id);
}

async function devExists(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT id, name FROM "AssetDev" WHERE id = $1`, id);
  return rows[0] || null;
}

// ── updates ──────────────────────────────────────────────────────────────────

async function normalizeUpdate(prisma, data, { partial }) {
  const out = {};
  if (!partial || data.number !== undefined) {
    const number = Number(data.number);
    if (data.number === '' || data.number === null || !Number.isFinite(number) || number < 0) throw bad('Update # must be a number, for example 4 or 3.5');
    out.number = number;
  }
  if (!partial || data.name !== undefined) {
    out.name = clean(data.name);
    if (!out.name) throw bad('Update name is required');
  }
  if (data.status !== undefined) {
    if (!UPDATE_STATUSES.includes(data.status)) throw bad('Invalid update status');
    out.status = data.status;
  }
  if (data.targetRelease !== undefined) out.targetRelease = parseDate(data.targetRelease, 'target release');
  if (data.leadDevId !== undefined) {
    out.leadDevId = clean(data.leadDevId);
    if (out.leadDevId && !(await devExists(prisma, out.leadDevId))) throw bad('Lead is not on the roster');
    if (out.leadDevId) out.leadName = null;
  }
  if (data.leadName !== undefined && !out.leadDevId) out.leadName = clean(data.leadName);
  if (data.notes !== undefined) out.notes = clean(data.notes);
  if (data.notionUrl !== undefined) out.notionUrl = clean(data.notionUrl);
  return out;
}

async function createUpdate(ctx, data) {
  const { prisma } = ctx;
  const fields = await normalizeUpdate(prisma, data, { partial: false });
  const clash = await prisma.$queryRawUnsafe(`SELECT id FROM "AssetUpdate" WHERE "number" = $1`, fields.number);
  if (clash.length) throw new AssetError(409, `Update #${fields.number} already exists`);
  const id = newId();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "AssetUpdate" ("id", "number", "name", "status", "targetRelease", "leadDevId", "leadName", "notes", "notionUrl")
    VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
  `, id, fields.number, fields.name, fields.status || 'Planning', fields.targetRelease || null,
  fields.leadDevId || null, fields.leadName || null, fields.notes || null, fields.notionUrl || null);
  await logActivity(ctx, [{ entityType: 'update', entityId: id, updateId: id, action: 'created', label: `Update #${fields.number} ${fields.name} created` }]);
  notify(ctx, { kind: 'update', updateId: id });
  return q.getUpdate(prisma, id);
}

async function updateUpdate(ctx, id, data) {
  const { prisma } = ctx;
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, "number", name, status, to_char("targetRelease", 'YYYY-MM-DD') AS "targetRelease",
      "leadDevId", "leadName", notes, "notionUrl" FROM "AssetUpdate" WHERE id = $1`, id);
  if (!rows.length) throw missing('Update');
  const patch = await normalizeUpdate(prisma, data, { partial: true });
  if (patch.number !== undefined && patch.number !== rows[0].number) {
    const clash = await prisma.$queryRawUnsafe(`SELECT id FROM "AssetUpdate" WHERE "number" = $1 AND id <> $2`, patch.number, id);
    if (clash.length) throw new AssetError(409, `Update #${patch.number} already exists`);
  }
  const changes = diffFields(rows[0], patch, { entityType: 'update', entityId: id, updateId: id });
  if (changes.length) {
    await setColumns(prisma, 'AssetUpdate', id, Object.fromEntries(changes.map(c => [c.field, c.after])));
    await logActivity(ctx, changes);
    notify(ctx, { kind: 'update', updateId: id });
  }
  return q.getUpdate(prisma, id);
}

async function deleteUpdate(ctx, id) {
  const { prisma } = ctx;
  const rows = await prisma.$queryRawUnsafe(`SELECT "number", name FROM "AssetUpdate" WHERE id = $1`, id);
  if (!rows.length) throw missing('Update');
  const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetContentItem" WHERE "updateId" = $1`, id);
  if (n) throw new AssetError(409, 'This update still has content. Cancel it instead, or archive its items first.');
  await prisma.$executeRawUnsafe(`DELETE FROM "AssetUpdate" WHERE id = $1`, id);
  await logActivity(ctx, [{ entityType: 'update', entityId: id, action: 'deleted', label: `Update #${rows[0].number} ${rows[0].name} deleted` }]);
  notify(ctx, { kind: 'update', updateId: id, deleted: true });
}

// ── task generation ──────────────────────────────────────────────────────────

// One task per active template of the item's content type. Idempotent:
// existing tasks (and their status, assignee, due date, notes) are untouched.
async function generateTasksForItem(prisma, itemId) {
  return prisma.$executeRawUnsafe(`
    INSERT INTO "AssetTask" ("id", "contentItemId", "templateId")
    SELECT gen_random_uuid()::text, ci.id, tt.id
    FROM "AssetContentItem" ci
    JOIN "AssetTaskTemplate" tt ON tt."contentTypeId" = ci."contentTypeId" AND tt.active
    WHERE ci.id = $1
    ORDER BY tt."taskNumber", tt."taskCode"
    ON CONFLICT ("contentItemId", "templateId") DO NOTHING
  `, itemId);
}

// Adds a template's task to every existing item of its content type.
async function generateTasksForTemplate(prisma, templateId) {
  return prisma.$executeRawUnsafe(`
    INSERT INTO "AssetTask" ("id", "contentItemId", "templateId")
    SELECT gen_random_uuid()::text, ci.id, tt.id
    FROM "AssetTaskTemplate" tt
    JOIN "AssetContentItem" ci ON ci."contentTypeId" = tt."contentTypeId"
    WHERE tt.id = $1 AND tt.active
    ORDER BY ci."itemNumber"
    ON CONFLICT ("contentItemId", "templateId") DO NOTHING
  `, templateId);
}

// ── content items ────────────────────────────────────────────────────────────

async function normalizeItem(prisma, data, { partial }) {
  const out = {};
  if (data.displayName !== undefined) out.displayName = clean(data.displayName);
  if (!partial || data.internalName !== undefined) {
    out.internalName = clean(data.internalName) || (partial ? null : clean(data.displayName));
    if (!out.internalName) throw bad('Internal name is required');
  }
  if (data.priority !== undefined) {
    if (!PRIORITIES.includes(data.priority)) throw bad('Invalid priority');
    out.priority = data.priority;
  }
  if (data.ownerDevId !== undefined) {
    out.ownerDevId = clean(data.ownerDevId);
    if (out.ownerDevId && !(await devExists(prisma, out.ownerDevId))) throw bad('Owner is not on the roster');
    if (out.ownerDevId) out.ownerName = null;
  }
  if (data.ownerName !== undefined && !out.ownerDevId) out.ownerName = clean(data.ownerName);
  if (data.notes !== undefined) out.notes = clean(data.notes);
  if (data.notionUrl !== undefined) out.notionUrl = clean(data.notionUrl);
  if (data.archived !== undefined) out.archived = !!data.archived;
  return out;
}

async function createContentItem(ctx, data) {
  const { prisma } = ctx;
  const update = (await prisma.$queryRawUnsafe(`SELECT id, "number" FROM "AssetUpdate" WHERE id = $1`, data.updateId))[0];
  if (!update) throw bad('Unknown update');
  const type = (await prisma.$queryRawUnsafe(`SELECT id, name FROM "AssetContentType" WHERE id = $1`, data.contentTypeId))[0];
  if (!type) throw bad('Unknown content type');
  const fields = await normalizeItem(prisma, data, { partial: false });

  const clash = await prisma.$queryRawUnsafe(
    `SELECT id FROM "AssetContentItem" WHERE "updateId" = $1 AND lower("internalName") = lower($2)`, update.id, fields.internalName);
  if (clash.length) throw new AssetError(409, `"${fields.internalName}" already exists in update #${update.number}`);

  let itemNumber = Number.isInteger(data.itemNumber) ? data.itemNumber : null;
  if (itemNumber === null) {
    const [{ next }] = await prisma.$queryRawUnsafe(`SELECT COALESCE(MAX("itemNumber"), 0) + 1 AS next FROM "AssetContentItem"`);
    itemNumber = Number(next);
  }

  const id = newId();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "AssetContentItem" ("id", "itemNumber", "updateId", "contentTypeId", "displayName", "internalName",
      "ownerDevId", "ownerName", "priority", "notes", "notionUrl")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, id, itemNumber, update.id, type.id, fields.displayName || null, fields.internalName,
  fields.ownerDevId || null, fields.ownerName || null, fields.priority || 'Medium', fields.notes || null, fields.notionUrl || null);
  const tasks = await generateTasksForItem(prisma, id);

  await logActivity(ctx, [{
    entityType: 'item', entityId: id, updateId: update.id, contentItemId: id, action: 'created',
    label: `${type.name} "${fields.displayName || fields.internalName}" added with ${tasks} task${tasks === 1 ? '' : 's'}`,
  }]);
  notify(ctx, { kind: 'item', updateId: update.id, itemId: id });
  return q.getItem(prisma, id);
}

async function updateContentItem(ctx, id, data) {
  const { prisma } = ctx;
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, "updateId", "displayName", "internalName", "ownerDevId", "ownerName", priority, notes, "notionUrl", archived
    FROM "AssetContentItem" WHERE id = $1`, id);
  if (!rows.length) throw missing('Content item');
  if (data.contentTypeId !== undefined || data.updateId !== undefined) {
    throw bad('Content type and update cannot be changed after an item is created');
  }
  const patch = await normalizeItem(prisma, data, { partial: true });
  if (patch.internalName && patch.internalName.toLowerCase() !== rows[0].internalName.toLowerCase()) {
    const clash = await prisma.$queryRawUnsafe(
      `SELECT id FROM "AssetContentItem" WHERE "updateId" = $1 AND lower("internalName") = lower($2) AND id <> $3`,
      rows[0].updateId, patch.internalName, id);
    if (clash.length) throw new AssetError(409, `"${patch.internalName}" already exists in this update`);
  }
  const changes = diffFields(rows[0], patch, { entityType: 'item', entityId: id, updateId: rows[0].updateId, contentItemId: id });
  if (changes.length) {
    await setColumns(prisma, 'AssetContentItem', id, Object.fromEntries(changes.map(c => [c.field, c.after])));
    await logActivity(ctx, changes);
    notify(ctx, { kind: 'item', updateId: rows[0].updateId, itemId: id });
  }
  return q.getItem(prisma, id);
}

// ── tasks ────────────────────────────────────────────────────────────────────

const TASK_FIELDS = ['status', 'assigneeDevId', 'dueDate', 'notes', 'blockedReason'];

function normalizeTaskPatch(patch, devIds) {
  const out = {};
  if (patch.status !== undefined) {
    if (!TASK_STATUSES.includes(patch.status)) throw bad(`Invalid status "${patch.status}"`);
    out.status = patch.status;
  }
  if (patch.assigneeDevId !== undefined) {
    out.assigneeDevId = clean(patch.assigneeDevId);
    if (out.assigneeDevId && !devIds.has(out.assigneeDevId)) throw bad('Assignee is not on the roster');
  }
  if (patch.dueDate !== undefined) out.dueDate = parseDate(patch.dueDate, 'due date');
  if (patch.notes !== undefined) out.notes = clean(patch.notes);
  if (patch.blockedReason !== undefined) out.blockedReason = clean(patch.blockedReason)?.slice(0, 500) || null;
  return out;
}

// patches: [{ id, patch }]. Set-based so bulk edits and the import are fast.
// Returns the updated compact task rows (only tasks that actually changed).
async function applyTaskPatches(ctx, patches) {
  const { prisma } = ctx;
  if (!patches.length) return [];
  const ids = [...new Set(patches.map(p => p.id))];
  const current = await prisma.$queryRawUnsafe(`
    SELECT t.id, t.status, t."assigneeDevId", to_char(t."dueDate", 'YYYY-MM-DD') AS "dueDate", t.notes, t."blockedReason",
      t."contentItemId", ci."updateId"
    FROM "AssetTask" t JOIN "AssetContentItem" ci ON ci.id = t."contentItemId"
    WHERE t.id = ANY($1::text[])
  `, ids);
  const byId = new Map(current.map(r => [r.id, r]));
  const devs = await prisma.$queryRawUnsafe(`SELECT id, name FROM "AssetDev"`);
  const devIds = new Set(devs.map(d => d.id));
  const devName = new Map(devs.map(d => [d.id, d.name]));

  const next = new Map();
  const activity = [];
  for (const { id, patch } of patches) {
    const row = byId.get(id);
    if (!row) throw missing('Task');
    const base = next.get(id) || row;
    const change = normalizeTaskPatch(patch, devIds);
    const merged = { ...base, ...change };
    // A blocked task says why. The reason goes away with the block. Imports
    // and reverts restore what was recorded, so they are not held to this.
    if (merged.status !== 'Blocked') merged.blockedReason = null;
    else if (!merged.blockedReason && (row.status !== 'Blocked' || change.blockedReason !== undefined)
      && !ctx.revertOf && ctx.source !== 'import') {
      throw bad('Say what is blocking this task');
    }
    next.set(id, merged);
  }
  const changed = [];
  for (const [id, merged] of next) {
    const row = byId.get(id);
    const fields = TASK_FIELDS.filter(f => (row[f] ?? null) !== (merged[f] ?? null));
    if (!fields.length) continue;
    changed.push(merged);
    for (const field of fields) {
      const isDev = field === 'assigneeDevId';
      activity.push({
        entityType: 'task', entityId: id, taskId: id, contentItemId: row.contentItemId, updateId: row.updateId,
        action: 'updated', field,
        before: isDev && row[field] ? { id: row[field], name: devName.get(row[field]) || null } : row[field] ?? null,
        after: isDev && merged[field] ? { id: merged[field], name: devName.get(merged[field]) || null } : merged[field] ?? null,
      });
    }
  }
  if (!changed.length) return [];

  for (let i = 0; i < changed.length; i += 500) {
    await prisma.$executeRawUnsafe(`
      UPDATE "AssetTask" t
      SET status = v.status, "assigneeDevId" = v."assigneeDevId", "dueDate" = v."dueDate"::date, notes = v.notes,
        "blockedReason" = v."blockedReason", "updatedAt" = CURRENT_TIMESTAMP
      FROM jsonb_to_recordset($1::jsonb) AS v(id text, status text, "assigneeDevId" text, "dueDate" text, notes text, "blockedReason" text)
      WHERE t.id = v.id
    `, JSON.stringify(changed.slice(i, i + 500).map(r => ({
      id: r.id, status: r.status, assigneeDevId: r.assigneeDevId || null, dueDate: r.dueDate || null, notes: r.notes || null,
      blockedReason: r.blockedReason || null,
    }))));
  }
  await logActivity(ctx, activity);

  const changedIds = changed.map(r => r.id);
  notify(ctx, { kind: 'tasks', updateIds: [...new Set(changed.map(r => r.updateId))], taskIds: changedIds.slice(0, 200), count: changedIds.length });
  return q.listTasks(prisma, { ids: changedIds });
}

async function updateTask(ctx, id, patch) {
  const rows = await applyTaskPatches(ctx, [{ id, patch }]);
  return rows[0] || (await q.listTasks(ctx.prisma, { ids: [id] }))[0] || null;
}

async function updateTasks(ctx, ids, patch) {
  return applyTaskPatches(ctx, ids.map(id => ({ id, patch })));
}

async function appendTaskNote(ctx, id, text) {
  const note = clean(text);
  if (!note) throw bad('Note is empty');
  const rows = await ctx.prisma.$queryRawUnsafe(`SELECT notes FROM "AssetTask" WHERE id = $1`, id);
  if (!rows.length) throw missing('Task');
  const existing = rows[0].notes || '';
  if (existing.includes(note)) return (await q.listTasks(ctx.prisma, { ids: [id] }))[0];
  return updateTask(ctx, id, { notes: existing ? `${existing}\n${note}` : note });
}

// ── content types and templates ──────────────────────────────────────────────

async function createContentType(ctx, data) {
  const { prisma } = ctx;
  const name = clean(data.name);
  if (!name) throw bad('Content type name is required');
  const clash = await prisma.$queryRawUnsafe(`SELECT id FROM "AssetContentType" WHERE lower(name) = lower($1)`, name);
  if (clash.length) throw new AssetError(409, `Content type "${name}" already exists`);
  const [{ next }] = await prisma.$queryRawUnsafe(`SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS next FROM "AssetContentType"`);
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "AssetContentType" ("id", "name", "sortOrder") VALUES ($1, $2, $3)`, id, name, Number(next));
  await logActivity(ctx, [{ entityType: 'contentType', entityId: id, action: 'created', label: `Content type "${name}" created` }]);
  notify(ctx, { kind: 'templates' });
  return (await q.listContentTypes(prisma)).find(t => t.id === id);
}

async function updateContentType(ctx, id, data) {
  const { prisma } = ctx;
  const rows = await prisma.$queryRawUnsafe(`SELECT id, name, active FROM "AssetContentType" WHERE id = $1`, id);
  if (!rows.length) throw missing('Content type');
  const patch = {};
  if (data.name !== undefined) {
    patch.name = clean(data.name);
    if (!patch.name) throw bad('Content type name is required');
  }
  if (data.active !== undefined) patch.active = !!data.active;
  const changes = diffFields(rows[0], patch, { entityType: 'contentType', entityId: id });
  for (const c of changes) {
    await prisma.$executeRawUnsafe(`UPDATE "AssetContentType" SET "${c.field}" = $1 WHERE id = $2`, c.after, id);
  }
  await logActivity(ctx, changes);
  if (changes.length) notify(ctx, { kind: 'templates' });
  return (await q.listContentTypes(prisma)).find(t => t.id === id);
}

async function nextTaskCode(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT "taskCode" FROM "AssetTaskTemplate" WHERE "taskCode" ~ '^T[0-9]+$'`);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.taskCode.slice(1))), 0);
  return `T${String(max + 1).padStart(4, '0')}`;
}

async function assertDiscipline(prisma, name) {
  const rows = await prisma.$queryRawUnsafe(`SELECT "name" FROM "AssetDiscipline" WHERE "name" = $1`, name);
  if (!rows.length) throw bad(`Unknown discipline "${name}"`);
}

async function createTemplate(ctx, data) {
  const { prisma } = ctx;
  const type = (await prisma.$queryRawUnsafe(`SELECT id, name FROM "AssetContentType" WHERE id = $1`, data.contentTypeId))[0];
  if (!type) throw bad('Unknown content type');
  const discipline = clean(data.discipline);
  const deliverable = clean(data.deliverable);
  if (!discipline) throw bad('Discipline is required');
  if (!deliverable) throw bad('Deliverable is required');
  await assertDiscipline(prisma, discipline);

  const taskCode = clean(data.taskCode) || await nextTaskCode(prisma);
  const clash = await prisma.$queryRawUnsafe(`SELECT id FROM "AssetTaskTemplate" WHERE "taskCode" = $1`, taskCode);
  if (clash.length) throw new AssetError(409, `Task ID ${taskCode} already exists`);
  let taskNumber = Number.isInteger(data.taskNumber) ? data.taskNumber : null;
  if (taskNumber === null) {
    const [{ next }] = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(MAX("taskNumber"), 0) + 1 AS next FROM "AssetTaskTemplate" WHERE "contentTypeId" = $1`, type.id);
    taskNumber = Number(next);
  }

  const id = newId();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "AssetTaskTemplate" ("id", "taskCode", "contentTypeId", "taskNumber", "discipline", "deliverable", "definitionOfDone", "required")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, id, taskCode, type.id, taskNumber, discipline, deliverable, clean(data.definitionOfDone), data.required !== false);
  const tasksAdded = await generateTasksForTemplate(prisma, id);

  await logActivity(ctx, [{
    entityType: 'template', entityId: id, action: 'created',
    label: `${type.name} template "${deliverable}" (${taskCode}) added; ${tasksAdded} task${tasksAdded === 1 ? '' : 's'} generated on existing items`,
  }]);
  notify(ctx, { kind: 'templates', tasksAdded });
  const template = (await q.listTemplates(prisma)).find(t => t.id === id);
  return { template, tasksAdded };
}

async function updateTemplate(ctx, id, data) {
  const { prisma } = ctx;
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, "taskCode", "taskNumber", discipline, deliverable, "definitionOfDone", required, active
    FROM "AssetTaskTemplate" WHERE id = $1`, id);
  if (!rows.length) throw missing('Template task');
  const patch = {};
  if (data.discipline !== undefined) {
    patch.discipline = clean(data.discipline);
    if (!patch.discipline) throw bad('Discipline is required');
    await assertDiscipline(prisma, patch.discipline);
  }
  if (data.deliverable !== undefined) {
    patch.deliverable = clean(data.deliverable);
    if (!patch.deliverable) throw bad('Deliverable is required');
  }
  if (data.definitionOfDone !== undefined) patch.definitionOfDone = clean(data.definitionOfDone);
  if (data.required !== undefined) patch.required = !!data.required;
  if (data.taskNumber !== undefined) patch.taskNumber = Number(data.taskNumber) || 0;
  if (data.active !== undefined) patch.active = !!data.active;

  const changes = diffFields(rows[0], patch, { entityType: 'template', entityId: id });
  if (!changes.length) return { template: (await q.listTemplates(prisma)).find(t => t.id === id), tasksAdded: 0, tasksDeactivated: 0 };
  await setColumns(prisma, 'AssetTaskTemplate', id, Object.fromEntries(changes.map(c => [c.field, c.after])));

  // Removing a template task hides its tasks but keeps them, with their
  // history. Restoring it brings them back and fills any gaps.
  let tasksAdded = 0;
  let tasksDeactivated = 0;
  if (patch.active === false && rows[0].active) {
    tasksDeactivated = await prisma.$executeRawUnsafe(
      `UPDATE "AssetTask" SET active = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "templateId" = $1 AND active`, id);
  } else if (patch.active === true && !rows[0].active) {
    await prisma.$executeRawUnsafe(`UPDATE "AssetTask" SET active = true, "updatedAt" = CURRENT_TIMESTAMP WHERE "templateId" = $1`, id);
    tasksAdded = await generateTasksForTemplate(prisma, id);
  }
  await logActivity(ctx, changes);
  notify(ctx, { kind: 'templates', tasksAdded, tasksDeactivated });
  return { template: (await q.listTemplates(prisma)).find(t => t.id === id), tasksAdded, tasksDeactivated };
}

async function reorderTemplates(ctx, contentTypeId, orderedIds) {
  const { prisma } = ctx;
  await prisma.$executeRawUnsafe(`
    UPDATE "AssetTaskTemplate" tt SET "taskNumber" = v.n::int, "updatedAt" = CURRENT_TIMESTAMP
    FROM jsonb_to_recordset($1::jsonb) AS v(id text, n int)
    WHERE tt.id = v.id AND tt."contentTypeId" = $2
  `, JSON.stringify(orderedIds.map((id, i) => ({ id, n: i + 1 }))), contentTypeId);
  await logActivity(ctx, [{ entityType: 'contentType', entityId: contentTypeId, action: 'updated', label: 'Template tasks reordered' }]);
  notify(ctx, { kind: 'templates' });
  return (await q.listTemplates(prisma)).filter(t => t.contentTypeId === contentTypeId);
}

// How many tasks a template change would create or hide, before saving.
async function previewTemplateImpact(prisma, { contentTypeId, addCount = 0, restoreIds = [], removeIds = [] }) {
  const [{ n: items }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "AssetContentItem" WHERE "contentTypeId" = $1`, contentTypeId);
  const [{ n: restoreMissing }] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS n
    FROM "AssetTaskTemplate" tt
    JOIN "AssetContentItem" ci ON ci."contentTypeId" = tt."contentTypeId"
    LEFT JOIN "AssetTask" t ON t."contentItemId" = ci.id AND t."templateId" = tt.id
    WHERE tt.id = ANY($1::text[]) AND (t.id IS NULL OR NOT t.active)
  `, restoreIds);
  const [{ n: tasksHidden }] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "AssetTask" WHERE "templateId" = ANY($1::text[]) AND active`, removeIds);
  return { items, tasksAdded: items * Math.max(0, Number(addCount) || 0) + restoreMissing, tasksHidden };
}

// ── roster ───────────────────────────────────────────────────────────────────

async function setDevDisciplines(prisma, devId, disciplines) {
  const known = new Set(await q.listDisciplines(prisma));
  const list = [...new Set(disciplines.map(clean).filter(Boolean))];
  const unknown = list.find(d => !known.has(d));
  if (unknown) throw bad(`Unknown discipline "${unknown}"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AssetDevDiscipline" WHERE "devId" = $1`, devId);
  for (const discipline of list) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AssetDevDiscipline" ("devId", "discipline") VALUES ($1, $2) ON CONFLICT DO NOTHING`, devId, discipline);
  }
}

function normalizeDev(data, { partial }) {
  const out = {};
  if (!partial || data.name !== undefined) {
    out.name = clean(data.name);
    if (!out.name) throw bad('Dev name is required');
  }
  if (data.discipline !== undefined) out.discipline = clean(data.discipline);
  if (data.secondaryDiscipline !== undefined) out.secondaryDiscipline = clean(data.secondaryDiscipline);
  if (data.status !== undefined) {
    if (!DEV_STATUSES.includes(data.status)) throw bad('Invalid dev status');
    out.status = data.status;
  }
  if (data.discordProfileUrl !== undefined) {
    out.discordProfileUrl = clean(data.discordProfileUrl);
    out.discordUserId = parseDiscordUserId(out.discordProfileUrl);
  }
  if (data.discordUserId !== undefined && data.discordProfileUrl === undefined) out.discordUserId = parseDiscordUserId(data.discordUserId);
  if (data.notes !== undefined) out.notes = clean(data.notes);
  if (data.userId !== undefined) out.userId = clean(data.userId);
  if (data.discordThreadId !== undefined) {
    // Accepts the bare id or a link to the post.
    const raw = clean(data.discordThreadId);
    out.discordThreadId = raw ? (raw.match(/(\d{17,20})\/?$/) || [])[1] || null : null;
    if (raw && !out.discordThreadId) throw bad('Status post must be a Discord post ID or a link to the post');
  }
  return out;
}

async function createDev(ctx, data) {
  const { prisma } = ctx;
  const fields = normalizeDev(data, { partial: false });
  const clash = await prisma.$queryRawUnsafe(`SELECT id FROM "AssetDev" WHERE lower(name) = lower($1)`, fields.name);
  if (clash.length) throw new AssetError(409, `"${fields.name}" is already on the roster`);
  const id = newId();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "AssetDev" ("id", "name", "discipline", "secondaryDiscipline", "status", "discordProfileUrl", "discordUserId", "notes", "userId")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, id, fields.name, fields.discipline || null, fields.secondaryDiscipline || null, fields.status || 'Active',
  fields.discordProfileUrl || null, fields.discordUserId || null, fields.notes || null, fields.userId || null);
  if (fields.discordThreadId) await setColumns(prisma, 'AssetDev', id, { discordThreadId: fields.discordThreadId });
  await setDevDisciplines(prisma, id, [fields.discipline, fields.secondaryDiscipline, ...(data.disciplines || [])]);
  await logActivity(ctx, [{ entityType: 'dev', entityId: id, action: 'created', label: `${fields.name} added to the roster` }]);
  notify(ctx, { kind: 'devs' });
  return (await q.listDevs(prisma)).find(d => d.id === id);
}

async function updateDev(ctx, id, data) {
  const { prisma } = ctx;
  const rows = await prisma.$queryRawUnsafe(`
    SELECT id, name, discipline, "secondaryDiscipline", status, "discordProfileUrl", "discordUserId", notes, "userId", "discordThreadId"
    FROM "AssetDev" WHERE id = $1`, id);
  if (!rows.length) throw missing('Dev');
  const patch = normalizeDev(data, { partial: true });
  if (patch.name && patch.name.toLowerCase() !== rows[0].name.toLowerCase()) {
    const clash = await prisma.$queryRawUnsafe(`SELECT id FROM "AssetDev" WHERE lower(name) = lower($1) AND id <> $2`, patch.name, id);
    if (clash.length) throw new AssetError(409, `"${patch.name}" is already on the roster`);
  }
  const changes = diffFields(rows[0], patch, { entityType: 'dev', entityId: id });
  if (changes.length) await setColumns(prisma, 'AssetDev', id, Object.fromEntries(changes.map(c => [c.field, c.after])));
  // Primary and secondary are always part of the set a dev can be assigned under.
  const merged = { ...rows[0], ...patch };
  const current = (await prisma.$queryRawUnsafe(`SELECT discipline FROM "AssetDevDiscipline" WHERE "devId" = $1 ORDER BY discipline`, id)).map(r => r.discipline);
  const wanted = [...new Set([merged.discipline, merged.secondaryDiscipline, ...(data.disciplines ?? current)].map(clean).filter(Boolean))].sort();
  if (JSON.stringify(current) !== JSON.stringify(wanted)) {
    await setDevDisciplines(prisma, id, wanted);
    changes.push({ entityType: 'dev', entityId: id, action: 'updated', field: 'disciplines', before: current, after: wanted });
  }
  if (changes.length) {
    await logActivity(ctx, changes);
    notify(ctx, { kind: 'devs' });
  }
  return (await q.listDevs(prisma)).find(d => d.id === id);
}

async function addDiscipline(ctx, name) {
  const { prisma } = ctx;
  const value = clean(name);
  if (!value) throw bad('Discipline name is required');
  const [{ next }] = await prisma.$queryRawUnsafe(`SELECT COALESCE(MAX("sortOrder"), -1) + 1 AS next FROM "AssetDiscipline"`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "AssetDiscipline" ("name", "sortOrder") VALUES ($1, $2) ON CONFLICT DO NOTHING`, value, Number(next));
  notify(ctx, { kind: 'templates' });
  return q.listDisciplines(prisma);
}

module.exports = {
  AssetError,
  parseDate, parseDiscordUserId, splitNotionUrl, logActivity,
  createUpdate, updateUpdate, deleteUpdate,
  generateTasksForItem, generateTasksForTemplate,
  createContentItem, updateContentItem,
  applyTaskPatches, updateTask, updateTasks, appendTaskNote,
  createContentType, updateContentType,
  createTemplate, updateTemplate, reorderTemplates, previewTemplateImpact,
  createDev, updateDev, addDiscipline,
};
