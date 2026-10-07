// /api/assets: the asset tracker API. Off (404) unless ASSETS_ENABLED=true.

const router = require('express').Router();
const auth = require('../middleware/auth');
const { getPrisma, newId } = require('../assets/db');
const { ensureAssetSchema } = require('../assets/schema');
const C = require('../assets/constants');
const q = require('../assets/queries');
const service = require('../assets/service');
const perms = require('../assets/permissions');

const { AssetError } = service;
const forbidden = () => new AssetError(403, 'You do not have permission to do that');

// Wraps a handler so AssetError becomes its status and anything else a 500.
const h = fn => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json(result === undefined ? { success: true } : result);
  } catch (err) {
    if (err instanceof AssetError) return res.status(err.status).json({ error: err.message });
    console.error(`[Assets ${req.method} ${req.path}]`, err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
};

router.use((req, res, next) => {
  if (!C.isEnabled('ASSETS_ENABLED')) return res.status(404).json({ error: 'Not found' });
  next();
});
router.use(auth);

// Schema, page access and the caller's asset permissions, once per request.
router.use(async (req, res, next) => {
  try {
    const prisma = getPrisma();
    await ensureAssetSchema(prisma);
    const isAdmin = ['owner', 'admin'].includes(req.user.role);
    if (!isAdmin) {
      const rows = await prisma.$queryRawUnsafe(`SELECT "pageAccess" FROM "User" WHERE id = $1`, req.user.id);
      if (!(rows[0]?.pageAccess || []).includes('assets')) return res.status(403).json({ error: 'Insufficient role' });
    }
    const [devs, updates] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT d.id, d."userId", d.discipline, d."secondaryDiscipline",
          COALESCE((SELECT array_agg(dd.discipline) FROM "AssetDevDiscipline" dd WHERE dd."devId" = d.id), ARRAY[]::text[]) AS disciplines
        FROM "AssetDev" d WHERE d."userId" IS NOT NULL`),
      prisma.$queryRawUnsafe(`SELECT id, "leadDevId" FROM "AssetUpdate" WHERE "leadDevId" IS NOT NULL`),
    ]);
    req.prisma = prisma;
    req.access = perms.resolveAccess(req.user, { devs, updates });
    req.ctx = { prisma, source: 'human', actor: { userId: req.user.id, name: req.user.name } };
    next();
  } catch (err) {
    console.error('[Assets setup]', err.message);
    res.status(500).json({ error: 'Asset tracker is not ready' });
  }
});

const requireManager = (req, updateId) => { if (!perms.canManageUpdate(req.access, updateId)) throw forbidden(); };
const requireAdmin = req => { if (!req.access.isAdmin) throw forbidden(); };

// ── read ─────────────────────────────────────────────────────────────────────

router.get('/bootstrap', h(async req => {
  const { prisma } = req;
  const [disciplines, contentTypes, templates, devs, updates, views] = await Promise.all([
    q.listDisciplines(prisma), q.listContentTypes(prisma), q.listTemplates(prisma),
    q.listDevs(prisma), q.listUpdates(prisma), q.listSavedViews(prisma, req.user.id),
  ]);
  return {
    enums: {
      taskStatuses: C.TASK_STATUSES, priorities: C.PRIORITIES, updateStatuses: C.UPDATE_STATUSES,
      devStatuses: C.DEV_STATUSES, suggestionTypes: C.SUGGESTION_TYPES,
    },
    disciplines, contentTypes, templates, devs, updates, views,
    access: req.access,
    me: { id: req.user.id, name: req.user.name, role: req.user.role },
    flags: { agentEnabled: C.isEnabled('ASSET_AGENT_ENABLED') },
  };
}));

router.get('/updates/:id/overview', h(async req => {
  const overview = await q.getUpdateOverview(req.prisma, req.params.id);
  if (!overview) throw new AssetError(404, 'Update not found');
  return overview;
}));

router.get('/items', h(req => q.listItems(req.prisma, {
  updateId: req.query.updateId || undefined,
  includeArchived: req.query.includeArchived === 'true',
})));

router.get('/items/:id', h(async req => {
  const item = await q.getItem(req.prisma, req.params.id);
  if (!item) throw new AssetError(404, 'Content item not found');
  return item;
}));

router.get('/tasks', h(req => q.listTasks(req.prisma, { updateId: req.query.updateId || undefined })));
router.get('/devs', h(req => q.listDevs(req.prisma)));
router.get('/updates', h(req => q.listUpdates(req.prisma)));
router.get('/templates', h(async req => ({
  contentTypes: await q.listContentTypes(req.prisma),
  templates: await q.listTemplates(req.prisma),
  disciplines: await q.listDisciplines(req.prisma),
})));

router.get('/activity', h(req => q.listActivity(req.prisma, {
  taskId: req.query.taskId || undefined,
  contentItemId: req.query.contentItemId || undefined,
  updateId: req.query.updateId || undefined,
  limit: req.query.limit,
})));

// ── audit log ────────────────────────────────────────────────────────────────
// Reading it is for leads and managers. Reverting is checked per change, with
// the same rules as editing the thing directly.

const audit = require('../assets/audit');
const requireAuditor = req => { if (!req.access.isManager && !req.access.leadUpdateIds.length) throw forbidden(); };

router.get('/audit', h(req => {
  requireAuditor(req);
  return audit.listAudit(req.prisma, req.query);
}));
router.get('/audit/facets', h(req => {
  requireAuditor(req);
  return audit.facets(req.prisma);
}));
// body: { ids: [...], dryRun }. Puts each field back to its value before those entries.
router.post('/audit/revert', h(req => {
  requireAuditor(req);
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(String);
  if (!ids.length) throw new AssetError(400, 'Nothing selected');
  return audit.revertEntries(req.ctx, req.access, ids, { dryRun: req.body.dryRun === true });
}));
// body: { entryId, scope: 'entity' | 'item' | 'update' | 'all', dryRun }. Undoes everything since that entry.
router.post('/audit/restore', h(req => {
  requireAuditor(req);
  const kind = String(req.body.scope || 'entity');
  if (kind === 'all' && !req.access.isManager) throw forbidden();
  return audit.restoreToEntry(req.ctx, req.access, String(req.body.entryId || ''), { kind }, { dryRun: req.body.dryRun === true });
}));

// DevTrack logins, for linking a roster dev to an account.
router.get('/users', h(async req => {
  if (!perms.canEditRoster(req.access)) throw forbidden();
  return req.prisma.$queryRawUnsafe(`SELECT id, name, email, role FROM "User" ORDER BY name`);
}));

// ── updates ──────────────────────────────────────────────────────────────────

router.post('/updates', h(async (req, res) => {
  requireManager(req);
  res.status(201);
  return service.createUpdate(req.ctx, req.body);
}));
router.patch('/updates/:id', h(req => {
  requireManager(req, req.params.id);
  return service.updateUpdate(req.ctx, req.params.id, req.body);
}));
router.delete('/updates/:id', h(async req => {
  requireManager(req);
  await service.deleteUpdate(req.ctx, req.params.id);
}));

// ── content items ────────────────────────────────────────────────────────────

router.post('/items', h(async (req, res) => {
  requireManager(req, req.body.updateId);
  res.status(201);
  return service.createContentItem(req.ctx, req.body);
}));
router.patch('/items/:id', h(async req => {
  const item = await q.getItem(req.prisma, req.params.id);
  if (!item) throw new AssetError(404, 'Content item not found');
  requireManager(req, item.updateId);
  return service.updateContentItem(req.ctx, req.params.id, req.body);
}));

// ── tasks ────────────────────────────────────────────────────────────────────

async function assertCanEditTasks(req, ids, patch) {
  const fields = Object.keys(patch || {});
  if (!fields.length) throw new AssetError(400, 'Nothing to update');
  const rows = await req.prisma.$queryRawUnsafe(`
    SELECT t.id, t."assigneeDevId", ci."updateId"
    FROM "AssetTask" t JOIN "AssetContentItem" ci ON ci.id = t."contentItemId"
    WHERE t.id = ANY($1::text[])`, ids);
  if (rows.length !== new Set(ids).size) throw new AssetError(404, 'Task not found');
  if (!rows.every(task => perms.canEditTask(req.access, task, fields))) throw forbidden();
}

const pickTaskPatch = body => Object.fromEntries(
  ['status', 'assigneeDevId', 'dueDate', 'notes', 'blockedReason'].filter(f => body?.[f] !== undefined).map(f => [f, body[f]]));

router.patch('/tasks/:id', h(async req => {
  const patch = pickTaskPatch(req.body);
  await assertCanEditTasks(req, [req.params.id], patch);
  return service.updateTask(req.ctx, req.params.id, patch);
}));

router.post('/tasks/bulk', h(async req => {
  const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(String))] : [];
  if (!ids.length) throw new AssetError(400, 'No tasks selected');
  if (ids.length > 2000) throw new AssetError(400, 'Too many tasks in one bulk edit (max 2000)');
  const patch = pickTaskPatch(req.body.patch);
  await assertCanEditTasks(req, ids, patch);
  return { tasks: await service.updateTasks(req.ctx, ids, patch) };
}));

// ── roster ───────────────────────────────────────────────────────────────────

router.post('/devs', h(async (req, res) => {
  if (!perms.canEditRoster(req.access)) throw forbidden();
  res.status(201);
  return service.createDev(req.ctx, req.body);
}));
router.patch('/devs/:id', h(req => {
  if (!perms.canEditRoster(req.access)) throw forbidden();
  return service.updateDev(req.ctx, req.params.id, req.body);
}));

router.delete('/devs/:id', h(req => {
  if (!perms.canEditRoster(req.access)) throw forbidden();
  return service.deleteDev(req.ctx, req.params.id);
}));

// ── templates (admin) ────────────────────────────────────────────────────────

router.post('/content-types', h(async (req, res) => {
  requireAdmin(req);
  res.status(201);
  return service.createContentType(req.ctx, req.body);
}));
router.patch('/content-types/:id', h(req => {
  requireAdmin(req);
  return service.updateContentType(req.ctx, req.params.id, req.body);
}));
router.post('/disciplines', h(async req => {
  requireAdmin(req);
  return { disciplines: await service.addDiscipline(req.ctx, req.body.name) };
}));
router.post('/templates/preview', h(req => {
  requireAdmin(req);
  return service.previewTemplateImpact(req.prisma, {
    contentTypeId: req.body.contentTypeId,
    addCount: req.body.addCount,
    restoreIds: Array.isArray(req.body.restoreIds) ? req.body.restoreIds : [],
    removeIds: Array.isArray(req.body.removeIds) ? req.body.removeIds : [],
  });
}));
router.post('/templates/reorder', h(async req => {
  requireAdmin(req);
  if (!Array.isArray(req.body.orderedIds)) throw new AssetError(400, 'orderedIds is required');
  return { templates: await service.reorderTemplates(req.ctx, req.body.contentTypeId, req.body.orderedIds) };
}));
router.post('/templates', h(async (req, res) => {
  requireAdmin(req);
  res.status(201);
  return service.createTemplate(req.ctx, req.body);
}));
router.patch('/templates/:id', h(req => {
  requireAdmin(req);
  return service.updateTemplate(req.ctx, req.params.id, req.body);
}));

// ── saved views (per user) ───────────────────────────────────────────────────

router.post('/views', h(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new AssetError(400, 'View name is required');
  const id = newId();
  await req.prisma.$executeRawUnsafe(
    `INSERT INTO "AssetSavedView" ("id", "userId", "name", "config") VALUES ($1, $2, $3, $4::jsonb)`,
    id, req.user.id, name.slice(0, 60), JSON.stringify(req.body.config || {}));
  res.status(201);
  return (await q.listSavedViews(req.prisma, req.user.id)).find(v => v.id === id);
}));
router.patch('/views/:id', h(async req => {
  const sets = [];
  const values = [];
  if (req.body.name !== undefined) { values.push(String(req.body.name).trim().slice(0, 60)); sets.push(`"name" = $${values.length}`); }
  if (req.body.config !== undefined) { values.push(JSON.stringify(req.body.config)); sets.push(`"config" = $${values.length}::jsonb`); }
  if (!sets.length) throw new AssetError(400, 'Nothing to update');
  values.push(req.params.id, req.user.id);
  const n = await req.prisma.$executeRawUnsafe(
    `UPDATE "AssetSavedView" SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND "userId" = $${values.length}`, ...values);
  if (!n) throw new AssetError(404, 'View not found');
  return (await q.listSavedViews(req.prisma, req.user.id)).find(v => v.id === req.params.id);
}));
router.delete('/views/:id', h(async req => {
  await req.prisma.$executeRawUnsafe(`DELETE FROM "AssetSavedView" WHERE id = $1 AND "userId" = $2`, req.params.id, req.user.id);
}));

// Suggestions inbox and agent settings.
require('./assets-agent')(router, h);

module.exports = router;
