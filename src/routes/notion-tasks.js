const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const notion = require('../notion-client');
const db = require('../notion-tasks-db');
const { broadcast } = require('../events');

const prisma = new PrismaClient();

router.use(async (req, res, next) => {
  try {
    await db.ensureNotionTaskTable(prisma);
    await db.ensureNotionNicknameColumn(prisma);
    next();
  } catch (err) {
    console.error('[NotionTasks schema]', err.message);
    res.status(500).json({ error: 'Task storage is not ready' });
  }
});

// GET /api/notion-tasks — list, filterable by status/database/assignee/search
router.get('/', auth, requireRole('engineer', 'admin'), async (req, res) => {
  try {
    const tasks = await db.fetchAll(prisma, {
      status: req.query.status,
      notionDatabaseId: req.query.notionDatabaseId,
      assigneeId: req.query.assigneeId,
      search: req.query.search,
    });
    res.json(tasks);
  } catch (err) {
    console.error('[NotionTasks GET]', err.message);
    res.status(500).json({ error: 'Could not fetch tasks' });
  }
});

// GET /api/notion-tasks/nicknames — assignee option list for the admin mapping UI
router.get('/nicknames', auth, requireRole('admin'), async (req, res) => {
  try {
    const databaseIds = notion.getKnownDatabaseIds();
    const results = [];
    for (const databaseId of databaseIds) {
      const nicknames = await notion.getAssigneeOptions(databaseId);
      results.push({ databaseId, nicknames });
    }
    res.json(results);
  } catch (err) {
    console.error('[NotionTasks nicknames]', err.message);
    res.status(500).json({ error: 'Could not fetch Notion assignee options' });
  }
});

// PATCH /api/notion-tasks/:id — update locally, then write back to Notion.
// The Notion write-back failure is reported separately (notionSync) so a
// dev's change is never silently lost even if Notion is unreachable.
router.patch('/:id', auth, requireRole('engineer', 'admin'), async (req, res) => {
  try {
    const existing = await db.fetchById(prisma, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const title = req.body.title !== undefined ? String(req.body.title) : undefined;
    const status = req.body.status !== undefined ? String(req.body.status) : undefined;
    const priority = req.body.priority !== undefined ? String(req.body.priority) : undefined;
    const assigneeIds = req.body.assigneeIds !== undefined ? req.body.assigneeIds : undefined;
    // Direct nickname override, for use before a user has a notionNickname
    // mapped (normal UI flow should prefer assigneeIds once mapping exists).
    const assigneeNicknamesOverride = req.body.assigneeNicknames !== undefined ? req.body.assigneeNicknames : undefined;

    if (assigneeIds !== undefined && !Array.isArray(assigneeIds)) {
      return res.status(400).json({ error: 'assigneeIds must be an array' });
    }
    if (assigneeNicknamesOverride !== undefined && !Array.isArray(assigneeNicknamesOverride)) {
      return res.status(400).json({ error: 'assigneeNicknames must be an array' });
    }

    const updates = [];
    const values = [];
    let idx = 1;
    if (title !== undefined) { updates.push(`"title" = $${idx++}`); values.push(title); }
    if (status !== undefined) { updates.push(`"status" = $${idx++}`); values.push(status); }
    if (priority !== undefined) { updates.push(`"priority" = $${idx++}`); values.push(priority); }
    let nicknames;
    if (assigneeNicknamesOverride !== undefined) {
      nicknames = assigneeNicknamesOverride;
      const resolvedIds = await db.resolveAssigneeIds(prisma, nicknames);
      updates.push(`"assigneeIds" = $${idx++}`);
      values.push(resolvedIds);
      updates.push(`"assigneeNicknames" = $${idx++}`);
      values.push(nicknames);
    } else if (assigneeIds !== undefined) {
      nicknames = await db.resolveNicknamesForUsers(prisma, assigneeIds);
      updates.push(`"assigneeIds" = $${idx++}`);
      values.push(assigneeIds);
      updates.push(`"assigneeNicknames" = $${idx++}`);
      values.push(nicknames);
    }
    if (!updates.length) return res.status(400).json({ error: 'No changes provided' });

    updates.push(`"lastSyncedBy" = 'app'`, `"updatedAt" = CURRENT_TIMESTAMP`);
    values.push(req.params.id);
    await prisma.$executeRawUnsafe(`UPDATE "NotionTask" SET ${updates.join(', ')} WHERE id = $${idx}`, ...values);

    let task = await db.fetchById(prisma, req.params.id);
    const unmappedAssigneeIds = assigneeIds !== undefined
      ? assigneeIds.filter((_, i) => !nicknames[i])
      : [];

    let notionSync = { ok: true };
    try {
      const changes = {};
      if (title !== undefined) changes.title = title;
      if (status !== undefined) changes.status = status;
      if (priority !== undefined) changes.priority = priority;
      if (assigneeIds !== undefined || assigneeNicknamesOverride !== undefined) changes.assigneeNicknames = nicknames.filter(Boolean);
      const result = await notion.updateNotionPage(task.notionPageId, task.notionDatabaseId, changes);
      if (result?.notionLastEditedTime) {
        await prisma.$executeRawUnsafe(
          `UPDATE "NotionTask" SET "notionLastEditedTime" = $1 WHERE id = $2`,
          new Date(result.notionLastEditedTime), req.params.id
        );
        task = await db.fetchById(prisma, req.params.id);
      }
    } catch (err) {
      console.error('[NotionTasks write-back]', err.message);
      notionSync = { ok: false, error: err.message };
    }

    broadcast('notionTask.updated', { task, timestamp: new Date().toISOString() });
    res.json({ success: true, task, notionSync, unmappedAssigneeIds });
  } catch (err) {
    console.error('[NotionTasks PATCH]', err.message);
    res.status(500).json({ error: 'Could not update task' });
  }
});

// POST /api/notion-tasks/:id/resync — retry pushing the current Postgres
// state to Notion without changing any fields (used by the frontend's
// "retry" action after a failed write-back).
router.post('/:id/resync', auth, requireRole('engineer', 'admin'), async (req, res) => {
  try {
    const task = await db.fetchById(prisma, req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const result = await notion.updateNotionPage(task.notionPageId, task.notionDatabaseId, {
      title: task.title,
      status: task.status,
      priority: task.priority,
      assigneeNicknames: task.assigneeNicknames || [],
    });
    if (result?.notionLastEditedTime) {
      await prisma.$executeRawUnsafe(
        `UPDATE "NotionTask" SET "lastSyncedBy" = 'app', "notionLastEditedTime" = $1 WHERE id = $2`,
        new Date(result.notionLastEditedTime), req.params.id
      );
    }
    const fresh = await db.fetchById(prisma, req.params.id);
    broadcast('notionTask.updated', { task: fresh, timestamp: new Date().toISOString() });
    res.json({ success: true, task: fresh, notionSync: { ok: true } });
  } catch (err) {
    console.error('[NotionTasks resync]', err.message);
    res.status(500).json({ success: false, notionSync: { ok: false, error: err.message } });
  }
});

module.exports = router;
