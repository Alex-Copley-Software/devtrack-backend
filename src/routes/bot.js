const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { uploadBuffer, uploadFile } = require('../r2');

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

function botAuth(req, res, next) {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized bot request' });
  }
  next();
}

// Download a Discord CDN attachment, upload to R2, return URLs
async function processAttachment(att) {
  const { url: discordUrl, filename, contentType } = att;
  const ext = path.extname(filename) || '.bin';
  const key = `attachments/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  const type = contentType?.startsWith('image/') ? 'image' : 'video';

  let primaryUrl = null;

  try {
    // Download from Discord CDN
    const response = await axios.get(discordUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    const buffer = Buffer.from(response.data);

    // Try to upload to R2
    primaryUrl = await uploadBuffer(buffer, key, contentType);

    // Also save locally as fallback
    const localFname = path.basename(key);
    const localPath = path.join(uploadsDir, localFname);
    fs.writeFileSync(localPath, buffer);

    if (!primaryUrl) {
      // R2 not configured — use local path
      primaryUrl = `/uploads/${localFname}`;
    }
  } catch (err) {
    console.error('[Bot] Failed to process attachment:', filename, err.message);
    // Fall back to Discord CDN URL directly
    primaryUrl = discordUrl;
  }

  return {
    type,
    url: primaryUrl,
    discordUrl,   // always store original Discord URL as backup
    filename,
  };
}

// POST /api/bot/report
router.post('/report', botAuth, upload.array('attachments', 10), async (req, res) => {
  const { type, title, description, tags, discordUser, discordChannel, discordMessageId, priority, attachmentUrls } = req.body;

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
    const parsedTags = tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [];
    const parsedUrls = attachmentUrls ? JSON.parse(attachmentUrls) : [];

    // Process all Discord CDN attachments
    const processedAttachments = [];
    for (const att of parsedUrls) {
      const processed = await processAttachment(att);
      processedAttachments.push(processed);
    }

    // Handle directly uploaded files
    const uploadedAttachments = [];
    for (const f of (req.files || [])) {
      const localPath = path.join(uploadsDir, f.filename);
      const key = `attachments/${f.filename}`;
      const r2Url = await uploadFile(localPath, key, f.mimetype);
      uploadedAttachments.push({
        type: f.mimetype.startsWith('image/') ? 'image' : 'video',
        url: r2Url || `/uploads/${f.filename}`,
        discordUrl: null,
        filename: f.originalname,
      });
    }

    const allAttachments = [...processedAttachments, ...uploadedAttachments];

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
        status: 'queued',
        attachments: {
          create: allAttachments.map(a => ({
            type: a.type,
            url: a.url,
            filename: a.filename,
          }))
        }
      },
      include: { attachments: true }
    });

    res.status(201).json({ success: true, reportId: report.id });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Already submitted' });
    console.error(err);
    res.status(500).json({ error: 'Could not create report from bot' });
  }
});

// PATCH /api/bot/report/:id
router.patch('/report/:id', botAuth, async (req, res) => {
  try {
    const data = {};
    if (req.body.notifyOwner !== undefined) data.notifyOwner = req.body.notifyOwner;
    await prisma.report.update({ where: { id: req.params.id }, data });
    res.json({ success: true });
  } catch (err) {
    console.error('[Bot PATCH] Error:', err.message);
    res.status(500).json({ error: 'Could not update report' });
  }
});

// GET /api/bot/report-by-thread/:threadId
router.get('/report-by-thread/:threadId', botAuth, async (req, res) => {
  try {
    const report = await prisma.report.findFirst({
      where: { discordThreadId: req.params.threadId },
      select: { id: true }
    });
    if (!report) return res.status(404).json({ error: 'Not found' });
    res.json({ reportId: report.id });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

module.exports = router;