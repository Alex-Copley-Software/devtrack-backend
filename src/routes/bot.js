const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { uploadBuffer, uploadFile } = require('../r2');
const { maybeAlertQueueBacklog, alertQaReview } = require('../server-alerts');

const prisma = new PrismaClient();
const VALID_STATUSES = ['queued', 'open', 'in_progress', 'reviewing', 'resolved', 'declined'];
const MAX_REMOTE_ATTACHMENT_BYTES = Number(process.env.MAX_REMOTE_ATTACHMENT_BYTES || 125 * 1024 * 1024);

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
  const reportedSize = Number(att.size || 0);
  const ext = path.extname(filename) || '.bin';
  const key = `attachments/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
  const type = contentType?.startsWith('image/') ? 'image' : 'video';

  let primaryUrl = null;

  if (reportedSize > MAX_REMOTE_ATTACHMENT_BYTES) {
    console.warn(
      `[Bot] Attachment too large to mirror safely; storing Discord URL only: ${filename} (${reportedSize} bytes)`
    );
    return {
      type,
      url: discordUrl,
      discordUrl,
      filename,
    };
  }

  try {
    // Download from Discord CDN
    const response = await axios.get(discordUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: MAX_REMOTE_ATTACHMENT_BYTES,
      maxBodyLength: MAX_REMOTE_ATTACHMENT_BYTES,
    });
    const contentLength = Number(response.headers['content-length'] || 0);
    if (contentLength > MAX_REMOTE_ATTACHMENT_BYTES) {
      console.warn(
        `[Bot] Attachment content-length exceeded safe mirror limit; storing Discord URL only: ${filename} (${contentLength} bytes)`
      );
      return {
        type,
        url: discordUrl,
        discordUrl,
        filename,
      };
    }
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
            discordUrl: a.discordUrl || null,
            filename: a.filename,
          }))
        }
      },
      include: { attachments: true }
    });

    // Set publishStatus via raw SQL since Prisma client may not have it generated yet
    await prisma.$executeRaw`UPDATE "Report" SET "publishStatus" = 'unpublished' WHERE id = ${report.id}`.catch(()=>{});

    // Log initial queue entry to history
    const { log } = require('../history-logger');
    await log({ reportId: report.id, action: 'queued', detail: `Submitted by ${discordUser||'unknown'} via Discord`, actorName: discordUser||'Discord', actorId: req.body.discordUserId||'' });
    maybeAlertQueueBacklog(prisma).catch(err => console.error('[Bot] Queue alert failed:', err.message));

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
    if (req.body.status !== undefined) {
      const status = String(req.body.status);
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      const existing = await prisma.$queryRawUnsafe(
        'SELECT id, status::text AS status FROM "Report" WHERE id = $1 LIMIT 1',
        req.params.id
      );
      if (!existing.length) return res.status(404).json({ error: 'Report not found' });

      const queued = status === 'queued';
      const publishStatus = status === 'resolved' ? 'published' : 'unpublished';

      await prisma.$executeRawUnsafe(
        'UPDATE "Report" SET status = $1::"Status", queued = $2, "publishStatus" = $3, "updatedAt" = NOW() WHERE id = $4',
        status,
        queued,
        publishStatus,
        req.params.id
      );

      const { log } = require('../history-logger');
      const actorName = req.body.actorName || 'Discord';
      const actorId = req.body.actorId || '';
      const detail = req.body.detail || `Moved from ${existing[0].status} to ${status} via Discord /reopen`;
      await log({ reportId: req.params.id, action: status, detail, actorName, actorId });
      if (status === 'reviewing' && existing[0].status !== 'reviewing') {
        alertQaReview(prisma).catch(err => console.error('[Bot PATCH] QA alert failed:', err.message));
      }

      const updated = await prisma.$queryRawUnsafe(
        'SELECT id, status::text AS status, queued, "publishStatus" FROM "Report" WHERE id = $1 LIMIT 1',
        req.params.id
      );
      return res.json({ success: true, report: updated[0] });
    }

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
    const reports = await prisma.$queryRawUnsafe(
      'SELECT id, title, type::text AS type, status::text AS status, queued FROM "Report" WHERE "discordThreadId" = $1 ORDER BY "createdAt" DESC LIMIT 1',
      req.params.threadId
    );
    if (!reports.length) return res.status(404).json({ error: 'Not found' });
    const report = reports[0];
    res.json({ reportId: report.id, report });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// GET /api/bot/report-by-message/:messageId
router.get('/report-by-message/:messageId', botAuth, async (req, res) => {
  try {
    const reports = await prisma.$queryRawUnsafe(
      'SELECT id, title, type::text AS type, status::text AS status, queued FROM "Report" WHERE "discordMessageId" = $1 LIMIT 1',
      req.params.messageId
    );
    if (!reports.length) return res.status(404).json({ error: 'Not found' });
    const report = reports[0];
    res.json({ reportId: report.id, report });
  } catch (err) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// GET /api/bot/reports — bot fetches all reports for leaderboard
router.get('/reports', botAuth, async (req, res) => {
  try {
    const reports = await prisma.$queryRaw`
      SELECT id, type::text, "bugLevel"::text, status::text,
             "discordUser", "discordUserId", queued, "createdAt"
      FROM "Report"
      WHERE queued = false
      ORDER BY "createdAt" DESC
    `;
    res.json(reports);
  } catch (err) {
    console.error('[Bot GET /reports]', err.message);
    res.status(500).json({ error: 'Could not fetch reports' });
  }
});

module.exports = router;
