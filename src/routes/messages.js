const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();

// Bot auth middleware
function botAuth(req, res, next) {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/messages/:reportId — get all messages for a report
router.get('/:reportId', auth, async (req, res) => {
  try {
    const messages = await prisma.message.findMany({
      where: { reportId: req.params.reportId },
      orderBy: { createdAt: 'asc' }
    });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch messages' });
  }
});

// POST /api/messages — bot posts a new message
router.post('/', botAuth, async (req, res) => {
  const { reportId, content, authorName, authorId, authorAvatar, attachments, isBot } = req.body;
  if (!reportId || !content) return res.status(400).json({ error: 'reportId and content required' });
  try {
    // Check report exists
    const report = await prisma.report.findUnique({ where: { id: reportId } });
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const message = await prisma.message.create({
      data: {
        reportId,
        content,
        authorName: authorName || 'Unknown',
        authorId: authorId || '',
        authorAvatar: authorAvatar || null,
        attachments: attachments || [],
        isBot: isBot || false,
      }
    });
    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: 'Could not save message' });
  }
});

module.exports = router;