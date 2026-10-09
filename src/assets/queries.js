// Read side of the asset tracker. Every rollup is computed here.

const { taskCounts, withProgress, workloadOf } = require('./rollups');

const DATE = col => `to_char(${col}, 'YYYY-MM-DD')`;
// Updates that still count toward a dev's workload.
const LIVE_UPDATE = `u.status NOT IN ('Released', 'Cancelled')`;
const OPEN = `t.status IN ('Not Started', 'In Progress', 'Review', 'Blocked')`;

async function listDisciplines(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT "name" FROM "AssetDiscipline" ORDER BY "sortOrder", "name"`);
  return rows.map(r => r.name);
}

async function listContentTypes(prisma) {
  return prisma.$queryRawUnsafe(`
    SELECT ct.id, ct.name, ct."sortOrder", ct.active,
      (SELECT COUNT(*)::int FROM "AssetTaskTemplate" tt WHERE tt."contentTypeId" = ct.id AND tt.active) AS "templateCount",
      (SELECT COUNT(*)::int FROM "AssetContentItem" ci WHERE ci."contentTypeId" = ct.id) AS "itemCount"
    FROM "AssetContentType" ct
    ORDER BY ct."sortOrder", ct.name
  `);
}

async function listTemplates(prisma, { includeInactive = true } = {}) {
  return prisma.$queryRawUnsafe(`
    SELECT id, "taskCode", "contentTypeId", "taskNumber", discipline, deliverable, "definitionOfDone", required, active
    FROM "AssetTaskTemplate"
    ${includeInactive ? '' : 'WHERE active'}
    ORDER BY "contentTypeId", "taskNumber", "taskCode"
  `);
}

async function listDevs(prisma) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT d.id, d.name, d.discipline, d."secondaryDiscipline", d.status, d."discordProfileUrl", d."discordUserId",
      d.notes, d."userId", d."discordThreadId", d."robloxAccount",
      COALESCE((SELECT array_agg(dd.discipline ORDER BY dd.discipline) FROM "AssetDevDiscipline" dd WHERE dd."devId" = d.id), ARRAY[]::text[]) AS disciplines,
      COALESCE(w."openTasks", 0) AS "openTasks",
      COALESCE(w."doneTasks", 0) AS "doneTasks",
      COALESCE(w."blockedTasks", 0) AS "blockedTasks",
      COALESCE(w."overdueTasks", 0) AS "overdueTasks"
    FROM "AssetDev" d
    LEFT JOIN (
      SELECT t."assigneeDevId" AS "devId",
        COUNT(*) FILTER (WHERE ${OPEN} AND ${LIVE_UPDATE})::int AS "openTasks",
        COUNT(*) FILTER (WHERE t.status = 'Done')::int AS "doneTasks",
        COUNT(*) FILTER (WHERE t.status = 'Blocked' AND ${LIVE_UPDATE})::int AS "blockedTasks",
        COUNT(*) FILTER (WHERE ${OPEN} AND ${LIVE_UPDATE} AND t."dueDate" < CURRENT_DATE)::int AS "overdueTasks"
      FROM "AssetTask" t
      JOIN "AssetContentItem" ci ON ci.id = t."contentItemId" AND NOT ci.archived
      JOIN "AssetUpdate" u ON u.id = ci."updateId"
      WHERE t.active AND t."assigneeDevId" IS NOT NULL
      GROUP BY t."assigneeDevId"
    ) w ON w."devId" = d.id
    ORDER BY (d.status = 'Active') DESC, d.name
  `);
  return rows.map(r => ({ ...r, workload: workloadOf(r.openTasks) }));
}

async function listUpdates(prisma) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT u.id, u.number, u.name, u.status, ${DATE('u."targetRelease"')} AS "targetRelease",
      u."leadDevId", COALESCE(ld.name, u."leadName") AS "leadName", u.notes, u."notionUrl",
      COUNT(DISTINCT ci.id)::int AS "itemCount",
      ${taskCounts('t')}
    FROM "AssetUpdate" u
    LEFT JOIN "AssetDev" ld ON ld.id = u."leadDevId"
    LEFT JOIN "AssetContentItem" ci ON ci."updateId" = u.id AND NOT ci.archived
    LEFT JOIN "AssetTask" t ON t."contentItemId" = ci.id
    GROUP BY u.id, ld.name
    ORDER BY u.number DESC
  `);
  return rows.map(withProgress);
}

async function getUpdate(prisma, id) {
  return (await listUpdates(prisma)).find(u => u.id === id) || null;
}

const ITEM_FIELDS = `
  ci.id, ci."itemNumber", ci."updateId", ci."contentTypeId", ct.name AS "contentType",
  ci."displayName", ci."internalName", ci."ownerDevId", COALESCE(od.name, ci."ownerName") AS "ownerName",
  ci.priority, ci.notes, ci."notionUrl", ci.archived, ci."createdAt", ci."updatedAt"`;

async function listItems(prisma, { updateId, id, includeArchived = false } = {}) {
  const where = [];
  const values = [];
  if (updateId) { values.push(updateId); where.push(`ci."updateId" = $${values.length}`); }
  if (id) { values.push(id); where.push(`ci.id = $${values.length}`); }
  if (!includeArchived && !id) where.push(`NOT ci.archived`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const items = await prisma.$queryRawUnsafe(`
    SELECT ${ITEM_FIELDS}, ${taskCounts('t')}
    FROM "AssetContentItem" ci
    JOIN "AssetContentType" ct ON ct.id = ci."contentTypeId"
    LEFT JOIN "AssetDev" od ON od.id = ci."ownerDevId"
    LEFT JOIN "AssetTask" t ON t."contentItemId" = ci.id
    ${whereSql}
    GROUP BY ci.id, ct.name, od.name
    ORDER BY ci."itemNumber"
  `, ...values);
  if (!items.length) return [];

  const byDiscipline = await prisma.$queryRawUnsafe(`
    SELECT ci.id AS "itemId", tt.discipline, ${taskCounts('t')}
    FROM "AssetContentItem" ci
    JOIN "AssetTask" t ON t."contentItemId" = ci.id
    JOIN "AssetTaskTemplate" tt ON tt.id = t."templateId"
    ${whereSql}
    GROUP BY ci.id, tt.discipline
  `, ...values);
  const grouped = new Map();
  for (const row of byDiscipline) {
    if (!row.taskCount) continue;
    if (!grouped.has(row.itemId)) grouped.set(row.itemId, []);
    const { itemId, ...rest } = row;
    grouped.get(itemId).push(withProgress(rest));
  }
  return items.map(item => ({ ...withProgress(item), disciplines: grouped.get(item.id) || [] }));
}

async function getItem(prisma, id) {
  return (await listItems(prisma, { id }))[0] || null;
}

// Compact rows for the task table. Template text is not repeated per row:
// the client joins on templateId using the templates from /bootstrap.
const TASK_FIELDS = `
  t.id, t.ref, t."contentItemId", t."templateId", t.status, t."assigneeDevId",
  ${DATE('t."dueDate"')} AS "dueDate", t.notes, t."blockedReason", t."updatedAt",
  (SELECT json_build_object('id', p.id, 'status', p.status, 'amount', p."amountText", 'url', p."requestUrl")
   FROM "AssetPayoutTask" pt JOIN "AssetPayout" p ON p.id = pt."payoutId"
   WHERE pt."taskId" = t.id AND p.status IN ('pending', 'paid')
   ORDER BY (p.status = 'paid') DESC, p."createdAt" DESC LIMIT 1) AS payout`;

async function listTasks(prisma, { updateId, contentItemId, ids } = {}) {
  const where = [`t.active`];
  const values = [];
  if (updateId) { values.push(updateId); where.push(`ci."updateId" = $${values.length}`); }
  if (contentItemId) { values.push(contentItemId); where.push(`t."contentItemId" = $${values.length}`); }
  if (ids) { values.push(ids); where.push(`t.id = ANY($${values.length}::text[])`); }
  else where.push(`NOT ci.archived`);
  return prisma.$queryRawUnsafe(`
    SELECT ${TASK_FIELDS}, ci."updateId"
    FROM "AssetTask" t
    JOIN "AssetContentItem" ci ON ci.id = t."contentItemId"
    JOIN "AssetTaskTemplate" tt ON tt.id = t."templateId"
    WHERE ${where.join(' AND ')}
    ORDER BY ci."itemNumber", tt."taskNumber", t.ref
  `, ...values);
}

// Full task rows, for Discord and the agent, where there is no client-side join.
async function listTasksDetailed(prisma, { updateId, contentItemId, assigneeDevId, ref, openOnly = false } = {}) {
  const where = [`t.active`, `NOT ci.archived`];
  const values = [];
  if (updateId) { values.push(updateId); where.push(`ci."updateId" = $${values.length}`); }
  if (contentItemId) { values.push(contentItemId); where.push(`t."contentItemId" = $${values.length}`); }
  if (assigneeDevId) { values.push(assigneeDevId); where.push(`t."assigneeDevId" = $${values.length}`); }
  if (ref !== undefined) { values.push(Number(ref)); where.push(`t.ref = $${values.length}`); }
  if (openOnly) where.push(OPEN);
  return prisma.$queryRawUnsafe(`
    SELECT ${TASK_FIELDS}, ci."updateId", u.number AS "updateNumber", ci."itemNumber", ci."displayName", ci."internalName",
      ct.name AS "contentType", tt."taskCode", tt."taskNumber", tt.discipline, tt.deliverable, tt."definitionOfDone",
      tt.required, ad.name AS "assigneeName"
    FROM "AssetTask" t
    JOIN "AssetContentItem" ci ON ci.id = t."contentItemId"
    JOIN "AssetUpdate" u ON u.id = ci."updateId"
    JOIN "AssetContentType" ct ON ct.id = ci."contentTypeId"
    JOIN "AssetTaskTemplate" tt ON tt.id = t."templateId"
    LEFT JOIN "AssetDev" ad ON ad.id = t."assigneeDevId"
    WHERE ${where.join(' AND ')}
    ORDER BY ci."itemNumber", tt."taskNumber", t.ref
  `, ...values);
}

async function getUpdateOverview(prisma, updateId) {
  const update = await getUpdate(prisma, updateId);
  if (!update) return null;

  const disciplines = (await prisma.$queryRawUnsafe(`
    SELECT tt.discipline, ${taskCounts('t')}
    FROM "AssetContentItem" ci
    JOIN "AssetTask" t ON t."contentItemId" = ci.id
    JOIN "AssetTaskTemplate" tt ON tt.id = t."templateId"
    WHERE ci."updateId" = $1 AND NOT ci.archived
    GROUP BY tt.discipline
    ORDER BY tt.discipline
  `, updateId)).filter(r => r.taskCount).map(withProgress);

  const attention = cond => prisma.$queryRawUnsafe(`
    SELECT t.id
    FROM "AssetTask" t
    JOIN "AssetContentItem" ci ON ci.id = t."contentItemId"
    JOIN "AssetTaskTemplate" tt ON tt.id = t."templateId"
    WHERE ci."updateId" = $1 AND NOT ci.archived AND t.active AND ${cond}
    ORDER BY ci."itemNumber", tt."taskNumber"
  `, updateId).then(rows => rows.map(r => r.id));

  const [blocked, overdue, unassignedRequired, noOwner] = await Promise.all([
    attention(`t.status = 'Blocked'`),
    attention(`${OPEN} AND t."dueDate" < CURRENT_DATE`),
    attention(`${OPEN} AND tt.required AND t."assigneeDevId" IS NULL`),
    prisma.$queryRawUnsafe(`
      SELECT ci.id FROM "AssetContentItem" ci
      WHERE ci."updateId" = $1 AND NOT ci.archived AND ci."ownerDevId" IS NULL AND COALESCE(ci."ownerName", '') = ''
      ORDER BY ci."itemNumber"
    `, updateId).then(rows => rows.map(r => r.id)),
  ]);

  return { update, disciplines, attention: { blocked, overdue, unassignedRequired, noOwner } };
}

async function listActivity(prisma, { taskId, contentItemId, updateId, limit = 100 } = {}) {
  const where = [];
  const values = [];
  if (taskId) { values.push(taskId); where.push(`a."taskId" = $${values.length}`); }
  if (contentItemId) { values.push(contentItemId); where.push(`a."contentItemId" = $${values.length}`); }
  if (updateId) { values.push(updateId); where.push(`a."updateId" = $${values.length}`); }
  values.push(Math.min(500, Math.max(1, Number(limit) || 100)));
  return prisma.$queryRawUnsafe(`
    SELECT a.id, a."entityType", a."entityId", a."updateId", a."contentItemId", a."taskId", a.action, a.field,
      a.before, a.after, a.label, a.source, a."actorUserId", a."actorName", a."suggestionId", a.evidence, a."createdAt"
    FROM "AssetActivity" a
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a."createdAt" DESC, a.id
    LIMIT $${values.length}
  `, ...values);
}

async function listSavedViews(prisma, userId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, name, config, "createdAt" FROM "AssetSavedView" WHERE "userId" = $1 ORDER BY "createdAt"`, userId);
}

module.exports = {
  listDisciplines, listContentTypes, listTemplates, listDevs,
  listUpdates, getUpdate, getUpdateOverview,
  listItems, getItem, listTasks, listTasksDetailed,
  listActivity, listSavedViews,
};
