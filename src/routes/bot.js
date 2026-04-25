const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Simple bot auth via shared secret
function botAuth(req, res, next) {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized bot request' });
  }
  next();
}

// POST /api/bot/report
// Called by the Discord bot when a new forum post is detected
router.post('/report', botAuth, upload.array('attachments', 10), async (req, res) => {
  const {
    type, title, description, tags,
    discordUser, discordChannel, discordMessageId,
    priority, attachmentUrls // Discord CDN URLs as JSON string
  } = req.body;

  if (!type || !title || !description) {
    return res.status(400).json({ error: 'type, title, and description required' });
  }

  console.log('[Bot] Incoming fields:', {
    discordUser: req.body.discordUser,
    discordUserId: req.body.discordUserId,
    discordThreadId: req.body.discordThreadId,
    discordMessageId: req.body.discordMessageId,
  });

  try {
    const parsedTags = tags
      ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim()))
      : [];

    const parsedUrls = attachmentUrls ? JSON.parse(attachmentUrls) : [];

    // Download Discord CDN attachments and store locally
    const downloadedAttachments = [];
    for (const att of parsedUrls) {
      try {
        const response = await axios.get(att.url, { responseType: 'arraybuffer' });
        const ext = path.extname(att.filename) || '.bin';
        const fname = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
        const fpath = path.join(uploadsDir, fname);
        fs.writeFileSync(fpath, response.data);
        downloadedAttachments.push({
          type: att.contentType?.startsWith('image/') ? 'image' : 'video',
          url: `/uploads/${fname}`,
          filename: att.filename
        });
      } catch (dlErr) {
        console.error('Failed to download attachment:', att.url, dlErr.message);
      }
    }

    // Also handle directly uploaded files (multipart)
    const uploadedAttachments = (req.files || []).map(f => ({
      type: f.mimetype.startsWith('image/') ? 'image' : 'video',
      url: `/uploads/${f.filename}`,
      filename: f.originalname
    }));

    const report = await prisma.report.create({
      data: {
        type,
        priority: priority || 'medium',
        title,
        description,
        tags: parsedTags,
        discordUser: discordUser || 'unknown',
        discordUserId: req.body.discordUserId || null,
        discordThreadId: req.body.discordThreadId || null,
        discordChannel: discordChannel || 'unknown',
        discordMessageId: discordMessageId || null,
        queued: true,
        status: "queued",
        attachments: {
          create: [...downloadedAttachments, ...uploadedAttachments]
        }
      },
      include: { attachments: true }
    });

    res.status(201).json({ success: true, reportId: report.id });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'This Discord message has already been submitted' });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not create report from bot' });
  }
});

// PATCH /api/bot/report/:id — bot updates report fields
router.patch('/report/:id', botAuth, async (req, res) => {
  try {
    await prisma.report.update({
      where: { id: req.params.id },
      data: { notifyOwner: req.body.notifyOwner }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not update report' });
  }
});

module.exports = router;
