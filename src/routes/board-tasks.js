const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const db = require('../board-tasks-db');
const taskHistory = require('../board-task-history-logger');
const { broadcast } = require('../events');

const prisma = new PrismaClient();

router.use(async (req, res, next) => {
  try {
    await db.ensureBoardTaskTable(prisma);
    await taskHistory.ensureBoardTaskHistoryTable(prisma);
    next();
  } catch (err) {
    console.error('[BoardTasks schema]', err.message);
    res.status(500).json({ error: 'Task storage is not ready' });
  }
});

// GET /api/board-tasks — list, filterable by status/assignee/tag/search
router.get('/', auth, requireRole('engineer', 'admin'), async (req, res) => {
  try {
    const tasks = await db.fetchAll(prisma, {
      status: req.query.status,
      assigneeId: req.query.assigneeId,
      tag: req.query.tag,
      search: req.query.search,
    });
    res.json(tasks);
  } catch (err) {
    console.error('[BoardTasks GET]', err.message);
    res.status(500).json({ error: 'Could not fetch tasks' });
  }
});

// GET /api/board-tasks/tags — distinct tags in use, for the filter dropdown
// and the tag-input autocomplete when creating/editing a card
router.get('/tags', auth, requireRole('engineer', 'admin'), async (req, res) => {
  try {
    res.json(await db.listTags(prisma));
  } catch (err) {
    console.error('[BoardTasks tags]', err.message);
    res.status(500).json({ error: 'Could not fetch tags' });
  }
});

// POST /api/board-tasks — create a card
router.post('/', auth, requireRole('engineer', 'admin'), async (req, res) => {
  const { title, status, details, notionUrl, assigneeIds, tags } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Title is required' });
  try {
    const task = await db.create(prisma, {
      title: String(title).trim(),
      status,
      details,
      notionUrl,
      assigneeIds: Array.isArray(assigneeIds) ? assigneeIds.filter(Boolean) : [],
      tags: Array.isArray(tags) ? tags.filter(Boolean) : [],
      createdById: req.user.id,
    });
    await taskHistory.log(prisma, { boardTaskId: task.id, action: 'created', actorName: req.user.name, actorId: req.user.id });
    broadcast('boardTask.created', { task, timestamp: new Date().toISOString() });
    res.status(201).json(task);
  } catch (err) {
    console.error('[BoardTasks POST]', err.message);
    res.status(500).json({ error: 'Could not create task' });
  }
});

// PATCH /api/board-tasks/:id — update any subset of fields, drag-and-drop
// status changes go through here too
router.patch('/:id', auth, requireRole('engineer', 'admin'), async (req, res) => {
  try {
    const existing = await db.fetchById(prisma, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const { title, status, details, notionUrl, assigneeIds, tags } = req.body;
    const task = await db.update(prisma, req.params.id, { title, status, details, notionUrl, assigneeIds, tags });

    if (title !== undefined && title !== existing.title) {
      await taskHistory.log(prisma, { boardTaskId: req.params.id, action: 'title', detail: title, actorName: req.user.name, actorId: req.user.id });
    }
    if (status !== undefined && status !== existing.status) {
      await taskHistory.log(prisma, { boardTaskId: req.params.id, action: 'status', detail: `${existing.status} → ${status}`, actorName: req.user.name, actorId: req.user.id });
    }
    if (assigneeIds !== undefined && JSON.stringify([...assigneeIds].sort()) !== JSON.stringify([...(existing.assigneeIds||[])].sort())) {
      const names = (task.assignees || []).map(a => a.name).join(', ') || 'Unassigned';
      await taskHistory.log(prisma, { boardTaskId: req.params.id, action: 'assigned', detail: names, actorName: req.user.name, actorId: req.user.id });
    }
    if (tags !== undefined && JSON.stringify(tags) !== JSON.stringify(existing.tags)) {
      await taskHistory.log(prisma, { boardTaskId: req.params.id, action: 'tags', detail: (tags || []).join(', ') || 'cleared', actorName: req.user.name, actorId: req.user.id });
    }
    if (details !== undefined && details !== existing.details) {
      await taskHistory.log(prisma, { boardTaskId: req.params.id, action: 'details', detail: 'Details updated', actorName: req.user.name, actorId: req.user.id });
    }

    broadcast('boardTask.updated', { task, timestamp: new Date().toISOString() });
    res.json(task);
  } catch (err) {
    console.error('[BoardTasks PATCH]', err.message);
    res.status(500).json({ error: 'Could not update task' });
  }
});

// DELETE /api/board-tasks/:id
router.delete('/:id', auth, requireRole('engineer', 'admin'), async (req, res) => {
  try {
    await db.deleteTask(prisma, req.params.id);
    broadcast('boardTask.deleted', { id: req.params.id, timestamp: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    console.error('[BoardTasks DELETE]', err.message);
    res.status(500).json({ error: 'Could not delete task' });
  }
});

module.exports = router;
