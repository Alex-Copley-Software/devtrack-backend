const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { hasRole } = require('../middleware/roles');

const prisma = new PrismaClient();

// GET /api/tasks - get all tasks (grouped by user for dashboard)
router.get('/', auth, async (req, res) => {
  try {
    const tasks = await prisma.task.findMany({
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' }
    });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch tasks' });
  }
});

// GET /api/tasks/my - get only current user's tasks
router.get('/my', auth, async (req, res) => {
  try {
    const tasks = await prisma.task.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'asc' }
    });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch tasks' });
  }
});

// POST /api/tasks
router.post('/', auth, async (req, res) => {
  const { text, tag, userId } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const assignTo = userId || req.user.id;
  if (assignTo !== req.user.id && !hasRole(req.user, ['admin'])) {
    return res.status(403).json({ error: 'Cannot create tasks for another user' });
  }

  try {
    const task = await prisma.task.create({
      data: { text, tag: tag || 'feature', userId: assignTo },
      include: { user: { select: { id: true, name: true } } }
    });
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: 'Could not create task' });
  }
});

// PATCH /api/tasks/:id
router.patch('/:id', auth, async (req, res) => {
  const { text, done, tag } = req.body;

  const data = {};
  if (text !== undefined) data.text = text;
  if (done !== undefined) data.done = done;
  if (tag !== undefined) data.tag = tag;

  try {
    const existing = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (existing.userId !== req.user.id && !hasRole(req.user, ['admin'])) {
      return res.status(403).json({ error: 'Cannot update another user task' });
    }

    const task = await prisma.task.update({
      where: { id: req.params.id },
      data
    });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: 'Could not update task' });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const existing = await prisma.task.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (existing.userId !== req.user.id && !hasRole(req.user, ['admin'])) {
      return res.status(403).json({ error: 'Cannot delete another user task' });
    }

    await prisma.task.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete task' });
  }
});

module.exports = router;
