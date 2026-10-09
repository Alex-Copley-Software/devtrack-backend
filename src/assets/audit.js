// Audit log: a searchable view over AssetActivity (every write the service
// makes is already recorded there with who, when, source, before and after),
// plus undo. A revert is never a rewrite of history: it is a new change, made
// through the same service calls as any other edit, recorded with the
// person who reverted and a pointer (revertOf) to the entry it undoes.

const q = require('./queries');
const service = require('./service');
const perms = require('./permissions');

const { AssetError } = service;

// What can be put back, per kind of thing. Anything else (creations,
// deletions, reorders, settings) is shown in the log but has no undo.
const REVERTIBLE = {
  task: { table: 'AssetTask', fields: ['status', 'assigneeDevId', 'dueDate', 'notes', 'blockedReason'] },
  item: { table: 'AssetContentItem', fields: ['displayName', 'internalName', 'ownerDevId', 'ownerName', 'priority', 'notes', 'notionUrl', 'archived'] },
  update: { table: 'AssetUpdate', fields: ['number', 'name', 'status', 'targetRelease', 'leadDevId', 'leadName', 'notes', 'notionUrl'] },
  dev: { table: 'AssetDev', fields: ['name', 'discipline', 'secondaryDiscipline', 'status', 'discordProfileUrl', 'notes', 'userId', 'discordThreadId', 'robloxAccount', 'disciplines'] },
  template: { table: 'AssetTaskTemplate', fields: ['discipline', 'deliverable', 'definitionOfDone', 'required', 'taskNumber', 'active'] },
};
const DATE_FIELDS = ['dueDate', 'targetRelease'];

const isRevertible = row => row.action === 'updated' && !!row.field && !!REVERTIBLE[row.entityType]?.fields.includes(row.field);
// Assignee changes are logged as { id, name } so the log reads well after a dev is renamed.
const plain = (field, value) => (field === 'assigneeDevId' && value && typeof value === 'object' ? value.id : value ?? null);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const keyOf = row => `${row.entityType}:${row.entityId}:${row.field}`;

// ── reading ──────────────────────────────────────────────────────────────────

const SELECT = `
  SELECT a.id, a."entityType", a."entityId", a."updateId", a."contentItemId", a."taskId", a.action, a.field,
    a.before, a.after, a.label, a.source, a."actorUserId", a."actorName", a."suggestionId", a.evidence, a."revertOf", a."createdAt",
    t.ref AS "taskRef", tt.deliverable AS "taskDeliverable", tt.discipline AS "taskDiscipline",
    ci."internalName" AS "itemName", u."number" AS "updateNumber", u.name AS "updateName",
    d.name AS "devName", et.deliverable AS "templateDeliverable", et."taskCode" AS "templateCode"
  FROM "AssetActivity" a
  LEFT JOIN "AssetTask" t ON t.id = a."taskId"
  LEFT JOIN "AssetTaskTemplate" tt ON tt.id = t."templateId"
  LEFT JOIN "AssetContentItem" ci ON ci.id = a."contentItemId"
  LEFT JOIN "AssetUpdate" u ON u.id = a."updateId"
  LEFT JOIN "AssetDev" d ON a."entityType" = 'dev' AND d.id = a."entityId"
  LEFT JOIN "AssetTaskTemplate" et ON a."entityType" = 'template' AND et.id = a."entityId"`;

function whereFor(f = {}) {
  const where = [];
  const values = [];
  const add = (sql, value) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
  if (f.actor) add(`a."actorName" = ?`, String(f.actor));
  if (f.source) add(`a.source = ?`, String(f.source));
  if (f.entityType) add(`a."entityType" = ?`, String(f.entityType));
  if (f.action) add(`a.action = ?`, String(f.action));
  if (f.field) add(`a.field = ?`, String(f.field));
  if (f.updateId) add(`a."updateId" = ?`, String(f.updateId));
  if (f.contentItemId) add(`a."contentItemId" = ?`, String(f.contentItemId));
  if (f.taskId) add(`a."taskId" = ?`, String(f.taskId));
  if (f.entityId) add(`a."entityId" = ?`, String(f.entityId));
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from || '')) add(`a."createdAt" >= ?::date`, f.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to || '')) add(`a."createdAt" < (?::date + 1)`, f.to);
  if (f.reverts === 'true' || f.reverts === true) where.push(`a."revertOf" IS NOT NULL`);
  const search = String(f.q || '').trim();
  if (search) {
    add(`(a.label ILIKE ? OR a."actorName" ILIKE ? OR a.before::text ILIKE ? OR a.after::text ILIKE ?
      OR tt.deliverable ILIKE ? OR ci."internalName" ILIKE ? OR d.name ILIKE ? OR et.deliverable ILIKE ?)`.replace(/\?/g, '?'), `%${search}%`);
    // One parameter, used in every position.
    where[where.length - 1] = where[where.length - 1].replace(/\?/g, `$${values.length}`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

async function listAudit(prisma, filters = {}) {
  const { sql, values } = whereFor(filters);
  const limit = Math.min(5000, Math.max(1, Number(filters.limit) || 100));
  const offset = Math.max(0, Number(filters.offset) || 0);
  const [rows, [{ n }]] = await Promise.all([
    prisma.$queryRawUnsafe(`${SELECT} ${sql} ORDER BY a."createdAt" DESC, a.id LIMIT ${limit} OFFSET ${offset}`, ...values),
    prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM (${SELECT} ${sql}) x`, ...values),
  ]);
  return { total: n, rows: rows.map(r => ({ ...r, revertible: isRevertible(r) })) };
}

// Values for the filter dropdowns.
async function facets(prisma) {
  const [actors, kinds] = await Promise.all([
    prisma.$queryRawUnsafe(`SELECT "actorName" AS name, COUNT(*)::int AS n FROM "AssetActivity" GROUP BY 1 ORDER BY 2 DESC LIMIT 200`),
    prisma.$queryRawUnsafe(`SELECT "entityType" AS type, COUNT(*)::int AS n FROM "AssetActivity" GROUP BY 1 ORDER BY 2 DESC`),
  ]);
  return { actors, entityTypes: kinds };
}

// ── current values ───────────────────────────────────────────────────────────

async function currentValues(prisma, targets) {
  const out = new Map();
  const groups = new Map();
  for (const t of targets) {
    const k = `${t.entityType}:${t.field}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t.entityId);
  }
  for (const [k, ids] of groups) {
    const [entityType, field] = k.split(':');
    let rows;
    if (entityType === 'dev' && field === 'disciplines') {
      rows = await prisma.$queryRawUnsafe(`
        SELECT d.id, COALESCE((SELECT array_agg(dd.discipline ORDER BY dd.discipline) FROM "AssetDevDiscipline" dd WHERE dd."devId" = d.id), ARRAY[]::text[]) AS value
        FROM "AssetDev" d WHERE d.id = ANY($1::text[])`, ids);
    } else {
      const column = DATE_FIELDS.includes(field) ? `to_char("${field}", 'YYYY-MM-DD')` : `"${field}"`;
      rows = await prisma.$queryRawUnsafe(`SELECT id, ${column} AS value FROM "${REVERTIBLE[entityType].table}" WHERE id = ANY($1::text[])`, ids);
    }
    for (const r of rows) out.set(`${entityType}:${r.id}:${field}`, { exists: true, value: r.value ?? null });
  }
  return out;
}

// ── planning ─────────────────────────────────────────────────────────────────

// Turns a list of log rows (any order) into one target value per field: the
// value it had before the oldest of those rows. Fields already at that value
// are left out.
async function buildPlan(prisma, rows) {
  const oldest = new Map();
  const sorted = [...rows].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let unsupported = 0;
  for (const row of sorted) {
    if (!isRevertible(row)) { unsupported++; continue; }
    if (!oldest.has(keyOf(row))) oldest.set(keyOf(row), row);
  }
  const targets = [...oldest.values()];
  const current = await currentValues(prisma, targets);
  const changes = [];
  let gone = 0;
  for (const row of targets) {
    const now = current.get(keyOf(row));
    if (!now) { gone++; continue; } // the task, item or dev no longer exists
    const target = plain(row.field, row.before);
    if (same(now.value, target)) continue;
    changes.push({
      entryId: row.id, entityType: row.entityType, entityId: row.entityId, field: row.field,
      updateId: row.updateId, contentItemId: row.contentItemId, taskId: row.taskId,
      current: now.value, target,
      // Someone changed it again after the entry being undone.
      changedSince: rows.length === 1 && !same(now.value, plain(row.field, row.after)),
    });
  }
  return { changes, unsupported, gone };
}

async function entriesByIds(prisma, ids) {
  if (!ids.length) return [];
  return prisma.$queryRawUnsafe(`${SELECT} WHERE a.id = ANY($1::text[])`, ids);
}

// Everything recorded after the anchor entry, optionally narrowed to one
// update, item, task or other single thing. "After" is by timestamp, so the
// rest of a bulk edit or import that the anchor belongs to is kept with it.
async function entriesAfter(prisma, anchor, scope = {}) {
  const where = [`a."createdAt" > (SELECT "createdAt" FROM "AssetActivity" WHERE id = $1)`];
  const values = [anchor.id];
  const add = (column, value) => { values.push(value); where.push(`a."${column}" = $${values.length}`); };
  if (scope.kind === 'update') add('updateId', anchor.updateId);
  else if (scope.kind === 'item') add('contentItemId', anchor.contentItemId);
  else if (scope.kind === 'entity') { add('entityType', anchor.entityType); add('entityId', anchor.entityId); }
  else if (scope.kind !== 'all') throw new AssetError(400, 'Unknown scope');
  if ((scope.kind === 'update' && !anchor.updateId) || (scope.kind === 'item' && !anchor.contentItemId)) {
    throw new AssetError(400, 'That entry does not belong to an update or item');
  }
  return prisma.$queryRawUnsafe(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a."createdAt", a.id`, ...values);
}

// ── permissions ──────────────────────────────────────────────────────────────

function allowed(access, change) {
  if (change.entityType === 'template') return perms.canEditTemplates(access);
  if (change.entityType === 'dev') return perms.canEditRoster(access);
  return perms.canManageUpdate(access, change.updateId);
}

// ── applying ─────────────────────────────────────────────────────────────────

async function applyPlan(ctx, access, plan, revertOf) {
  const rctx = { ...ctx, revertOf };
  const denied = plan.changes.filter(c => !allowed(access, c));
  const todo = plan.changes.filter(c => allowed(access, c));
  const failed = [];
  let applied = 0;

  // Tasks in one pass (a restore after an import can touch thousands).
  const byTask = new Map();
  for (const c of todo.filter(c => c.entityType === 'task')) {
    if (!byTask.has(c.entityId)) byTask.set(c.entityId, {});
    byTask.get(c.entityId)[c.field] = c.target;
  }
  if (byTask.size) {
    const devIds = new Set((await ctx.prisma.$queryRawUnsafe(`SELECT id FROM "AssetDev"`)).map(d => d.id));
    const patches = [];
    for (const [id, patch] of byTask) {
      if (patch.assigneeDevId && !devIds.has(patch.assigneeDevId)) {
        failed.push({ entityType: 'task', entityId: id, field: 'assigneeDevId', error: 'That dev is no longer on the roster' });
        delete patch.assigneeDevId;
      }
      if (Object.keys(patch).length) patches.push({ id, patch });
    }
    await service.applyTaskPatches(rctx, patches);
    applied += patches.reduce((n, p) => n + Object.keys(p.patch).length, 0);
  }

  const apply = {
    item: (id, patch) => service.updateContentItem(rctx, id, patch),
    update: (id, patch) => service.updateUpdate(rctx, id, patch),
    dev: (id, patch) => service.updateDev(rctx, id, patch),
    template: (id, patch) => service.updateTemplate(rctx, id, patch),
  };
  for (const c of todo.filter(c => c.entityType !== 'task')) {
    try {
      await apply[c.entityType](c.entityId, { [c.field]: c.target });
      applied++;
    } catch (err) {
      if (!(err instanceof AssetError)) throw err;
      failed.push({ entityType: c.entityType, entityId: c.entityId, field: c.field, error: err.message });
    }
  }
  return { applied, failed, denied: denied.length };
}

// ── public operations ────────────────────────────────────────────────────────

// Undo specific entries: each field goes back to what it was before the entry.
async function revertEntries(ctx, access, ids, { dryRun = false } = {}) {
  const rows = await entriesByIds(ctx.prisma, [...new Set(ids)].slice(0, 500));
  if (!rows.length) throw new AssetError(404, 'Audit entry not found');
  const plan = await buildPlan(ctx.prisma, rows);
  if (dryRun) return { ...plan, denied: plan.changes.filter(c => !allowed(access, c)).length };
  if (plan.changes.length && !plan.changes.some(c => allowed(access, c))) throw new AssetError(403, 'You do not have permission to revert that');
  return { ...plan, ...(await applyPlan(ctx, access, plan, rows.length === 1 ? rows[0].id : null)) };
}

// Put things back the way they were right after an entry: undo everything since.
async function restoreToEntry(ctx, access, anchorId, scope, { dryRun = false } = {}) {
  const [anchor] = await entriesByIds(ctx.prisma, [anchorId]);
  if (!anchor) throw new AssetError(404, 'Audit entry not found');
  const later = await entriesAfter(ctx.prisma, anchor, scope);
  const plan = await buildPlan(ctx.prisma, later);
  const summary = {
    anchor: { id: anchor.id, createdAt: anchor.createdAt, actorName: anchor.actorName },
    entriesSince: later.length,
    people: [...new Set(later.map(r => r.actorName))].slice(0, 20),
  };
  if (dryRun) return { ...summary, ...plan, denied: plan.changes.filter(c => !allowed(access, c)).length };
  if (plan.changes.length && !plan.changes.some(c => allowed(access, c))) throw new AssetError(403, 'You do not have permission to restore that');
  const result = await applyPlan(ctx, access, plan, anchor.id);
  await service.logActivity(ctx, [{
    entityType: 'audit', entityId: anchor.id, updateId: scope.kind === 'update' ? anchor.updateId : null, action: 'restored',
    label: `Restored ${result.applied} field${result.applied === 1 ? '' : 's'} to how ${scope.kind === 'all' ? 'everything' : scope.kind === 'update' ? 'this update' : scope.kind === 'item' ? 'this item' : 'this'} stood at ${new Date(anchor.createdAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
  }]);
  return { ...summary, ...plan, ...result };
}

module.exports = { REVERTIBLE, isRevertible, listAudit, facets, revertEntries, restoreToEntry, listActivity: q.listActivity };
