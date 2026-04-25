const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();

function botAuth(req, res, next) {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/messages/:reportId
router.get('/:reportId', auth, async (req, res) => {
  try {
    const messages = await prisma.message.findMany({
      where: { reportId: req.params.reportId },
      orderBy: { createdAt: 'asc' }
    });
    res.json(messages);
  } catch (err) {
    console.error('[Messages GET] Error:', err.message);
    res.status(500).json({ error: 'Could not fetch messages' });
  }
});

// POST /api/messages
router.post('/', botAuth, async (req, res) => {
  const { reportId, content, authorName, authorId, authorAvatar, attachments, isBot } = req.body;
  if (!reportId || !content) return res.status(400).json({ error: 'reportId and content required' });
  try {
    const message = await prisma.message.create({
      data: {
        reportId,
        content: String(content),
        authorName: String(authorName || 'Unknown'),
        authorId: String(authorId || ''),
        authorAvatar: authorAvatar ? String(authorAvatar) : null,
        attachments: Array.isArray(attachments) ? attachments.map(String) : [],
        isBot: Boolean(isBot),
      }
    });
    res.status(201).json(message);
  } catch (err) {
    console.error('[Messages POST] Error:', err.message, '| reportId:', reportId);
    res.status(500).json({ error: 'Could not save message', detail: err.message });
  }
});

module.exports = router;