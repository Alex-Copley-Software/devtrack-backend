const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { uploadBuffer, uploadFile } = require('../r2');
const { maybeAlertQueueBacklog, alertQaReview } = require('../server-alerts');
const { broadcast } = require('../events');

const prisma = new PrismaClient();
const VALID_STATUSES = ['queued', 'open', 'in_progress', 'reviewing', 'on_hold', 'resolved', 'declined'];
let statusEnumReady = false;

async function ensureStatusEnumValues() {
  if (statusEnumReady) return;
  await prisma.$executeRawUnsafe(`ALTER TYPE "Status" ADD VALUE IF NOT EXISTS 'on_hold'`);
  statusEnumReady = true;
}

let creditColumnsReady = false;
async function ensureCreditColumns() {
  if (creditColumnsReady) return;
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "creditedDiscordUserId" TEXT`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "creditedDiscordUser" TEXT`);
  creditColumnsReady = true;
}

let creditRequestTableReady = false;
async function ensureCreditRequestTable() {
  if (creditRequestTableReady) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CreditRequest" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "reportId" TEXT NOT NULL REFERENCES "Report"(id) ON DELETE CASCADE,
      "requestedDiscordUserId" TEXT NOT NULL,
      "requestedDiscordUser" TEXT NOT NULL,
      "ownerDiscordUserId" TEXT,
      "threadId" TEXT NOT NULL,
      "promptMessageId" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "resolvedByDiscordUserId" TEXT,
      "resolvedByDiscordUser" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "escalatedAt" TIMESTAMP(3),
      "resolvedAt" TIMESTAMP(3)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditRequest_reportId_idx" ON "CreditRequest"("reportId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditRequest_status_idx" ON "CreditRequest"("status")`);
  creditRequestTableReady = true;
}
const MAX_REMOTE_ATTACHMENT_BYTES = Number(process.env.MAX_REMOTE_ATTACHMENT_BYTES || 125 * 1024 * 1024);

const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

function broadcastReport(event, report) {
  if (!report) return;
  broadcast(event, {
    report: {
      assignees: [],
      ...report,
      attachments: report.attachments || [],
    },
    actor: null,
    timestamp: new Date().toISOString(),
  });
  broadcast('activity.changed', { reportId: report.id, timestamp: new Date().toISOString() });
}

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
    broadcastReport('report.created', report);

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
      await ensureStatusEnumValues();

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
      const fresh = await prisma.$queryRawUnsafe(`
        SELECT r.*,
          COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)) FILTER (WHERE u.id IS NOT NULL), '[]') AS assignees,
          COALESCE(json_agg(DISTINCT jsonb_build_object('id', a.id, 'type', a.type, 'url', a.url, 'filename', a.filename)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
        FROM "Report" r
        LEFT JOIN "_AssignedReports" ar ON ar."A" = r.id
        LEFT JOIN "User" u ON u.id = ar."B"
        LEFT JOIN "Attachment" a ON a."reportId" = r.id
        WHERE r.id = $1
        GROUP BY r.id
      `, req.params.id);
      broadcastReport('report.updated', fresh[0] || updated[0]);
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
    await ensureCreditColumns();
    const reports = await prisma.$queryRawUnsafe(
      `SELECT id, title, type::text AS type, status::text AS status, queued,
              "discordUserId", "discordUser", "creditedDiscordUserId", "creditedDiscordUser"
       FROM "Report" WHERE "discordThreadId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
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
    await ensureCreditColumns();
    const reports = await prisma.$queryRaw`
      SELECT id, type::text, "bugLevel"::text, status::text,
             "discordUser", "discordUserId", "creditedDiscordUserId", "creditedDiscordUser",
             queued, "createdAt"
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

// POST /api/bot/report/:id/credit — the report owner attaches another
// Discord user as a co-finder, so that person's leaderboard count also
// reflects this bug. Overwrites any previously credited user.
router.post('/report/:id/credit', botAuth, async (req, res) => {
  const { creditedDiscordUserId, creditedDiscordUser, actorDiscordUserId, actorDiscordUser } = req.body;
  if (!creditedDiscordUserId || !creditedDiscordUser) {
    return res.status(400).json({ error: 'creditedDiscordUserId and creditedDiscordUser are required' });
  }
  try {
    await ensureCreditColumns();
    const rows = await prisma.$queryRawUnsafe(`SELECT id, "discordUserId" FROM "Report" WHERE id = $1`, req.params.id);
    if (!rows.length) return res.status(404).json({ error: 'Report not found' });

    await prisma.$executeRawUnsafe(
      `UPDATE "Report" SET "creditedDiscordUserId" = $1, "creditedDiscordUser" = $2, "updatedAt" = NOW() WHERE id = $3`,
      creditedDiscordUserId, creditedDiscordUser, req.params.id
    );

    const { log } = require('../history-logger');
    await log({
      reportId: req.params.id,
      action: 'credited',
      detail: `${creditedDiscordUser} credited for finding this bug`,
      actorName: actorDiscordUser || 'Discord',
      actorId: actorDiscordUserId || '',
    });

    const fresh = await prisma.$queryRawUnsafe(`
      SELECT r.*,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)) FILTER (WHERE u.id IS NOT NULL), '[]') AS assignees,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', a.id, 'type', a.type, 'url', a.url, 'filename', a.filename)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
      FROM "Report" r
      LEFT JOIN "_AssignedReports" ar ON ar."A" = r.id
      LEFT JOIN "User" u ON u.id = ar."B"
      LEFT JOIN "Attachment" a ON a."reportId" = r.id
      WHERE r.id = $1
      GROUP BY r.id
    `, req.params.id);
    broadcastReport('report.updated', fresh[0]);
    res.json({ success: true, report: fresh[0] });
  } catch (err) {
    console.error('[Bot POST /report/:id/credit]', err.message);
    res.status(500).json({ error: 'Could not credit report' });
  }
});

// POST /api/bot/credit-request — creates a pending credit request
router.post('/credit-request', botAuth, async (req, res) => {
  const { reportId, requestedDiscordUserId, requestedDiscordUser, ownerDiscordUserId, threadId } = req.body;
  if (!reportId || !requestedDiscordUserId || !requestedDiscordUser || !threadId) {
    return res.status(400).json({ error: 'reportId, requestedDiscordUserId, requestedDiscordUser, and threadId are required' });
  }
  try {
    await ensureCreditRequestTable();
    const id = require('crypto').randomUUID();
    await prisma.$executeRawUnsafe(`
      INSERT INTO "CreditRequest" ("id", "reportId", "requestedDiscordUserId", "requestedDiscordUser", "ownerDiscordUserId", "threadId")
      VALUES ($1,$2,$3,$4,$5,$6)
    `, id, reportId, requestedDiscordUserId, requestedDiscordUser, ownerDiscordUserId || null, threadId);
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "CreditRequest" WHERE id = $1`, id);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[Bot POST /credit-request]', err.message);
    res.status(500).json({ error: 'Could not create credit request' });
  }
});

// GET /api/bot/credit-request/existing — check for an already-pending/
// escalated request from this user on this report, to avoid duplicates
router.get('/credit-request/existing', botAuth, async (req, res) => {
  const { reportId, requestedDiscordUserId } = req.query;
  if (!reportId || !requestedDiscordUserId) {
    return res.status(400).json({ error: 'reportId and requestedDiscordUserId are required' });
  }
  try {
    await ensureCreditRequestTable();
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM "CreditRequest" WHERE "reportId" = $1 AND "requestedDiscordUserId" = $2 AND status IN ('pending','escalated') ORDER BY "createdAt" DESC LIMIT 1`,
      reportId, requestedDiscordUserId
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('[Bot GET /credit-request/existing]', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// GET /api/bot/credit-request/:id
router.get('/credit-request/:id', botAuth, async (req, res) => {
  try {
    await ensureCreditRequestTable();
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "CreditRequest" WHERE id = $1`, req.params.id);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[Bot GET /credit-request/:id]', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// PATCH /api/bot/credit-request/:id — currently only used to record the
// posted prompt message's id so later steps can reference/edit it
router.patch('/credit-request/:id', botAuth, async (req, res) => {
  const { promptMessageId } = req.body;
  try {
    await ensureCreditRequestTable();
    if (promptMessageId !== undefined) {
      await prisma.$executeRawUnsafe(`UPDATE "CreditRequest" SET "promptMessageId" = $1 WHERE id = $2`, promptMessageId, req.params.id);
    }
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "CreditRequest" WHERE id = $1`, req.params.id);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[Bot PATCH /credit-request/:id]', err.message);
    res.status(500).json({ error: 'Could not update credit request' });
  }
});

// POST /api/bot/credit-request/:id/approve — marks the request approved
// and applies credit to the linked report in one step
router.post('/credit-request/:id/approve', botAuth, async (req, res) => {
  const { resolvedByDiscordUserId, resolvedByDiscordUser } = req.body;
  try {
    await ensureCreditRequestTable();
    await ensureCreditColumns();
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "CreditRequest" WHERE id = $1`, req.params.id);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const request = rows[0];
    if (request.status === 'approved' || request.status === 'denied') {
      return res.status(409).json({ error: `Request already ${request.status}`, request });
    }

    await prisma.$executeRawUnsafe(
      `UPDATE "CreditRequest" SET status = 'approved', "resolvedByDiscordUserId" = $1, "resolvedByDiscordUser" = $2, "resolvedAt" = NOW() WHERE id = $3`,
      resolvedByDiscordUserId || null, resolvedByDiscordUser || null, req.params.id
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "Report" SET "creditedDiscordUserId" = $1, "creditedDiscordUser" = $2, "updatedAt" = NOW() WHERE id = $3`,
      request.requestedDiscordUserId, request.requestedDiscordUser, request.reportId
    );

    const { log } = require('../history-logger');
    await log({
      reportId: request.reportId,
      action: 'credited',
      detail: `${request.requestedDiscordUser} credited for finding this bug (approved by ${resolvedByDiscordUser || 'unknown'})`,
      actorName: resolvedByDiscordUser || 'Discord',
      actorId: resolvedByDiscordUserId || '',
    });

    const fresh = await prisma.$queryRawUnsafe(`
      SELECT r.*,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email)) FILTER (WHERE u.id IS NOT NULL), '[]') AS assignees,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', a.id, 'type', a.type, 'url', a.url, 'filename', a.filename)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
      FROM "Report" r
      LEFT JOIN "_AssignedReports" ar ON ar."A" = r.id
      LEFT JOIN "User" u ON u.id = ar."B"
      LEFT JOIN "Attachment" a ON a."reportId" = r.id
      WHERE r.id = $1
      GROUP BY r.id
    `, request.reportId);
    broadcastReport('report.updated', fresh[0]);

    const updated = await prisma.$queryRawUnsafe(`SELECT * FROM "CreditRequest" WHERE id = $1`, req.params.id);
    res.json({ success: true, request: updated[0] });
  } catch (err) {
    console.error('[Bot POST /credit-request/:id/approve]', err.message);
    res.status(500).json({ error: 'Could not approve credit request' });
  }
});

// POST /api/bot/credit-request/:id/deny
router.post('/credit-request/:id/deny', botAuth, async (req, res) => {
  const { resolvedByDiscordUserId, resolvedByDiscordUser } = req.body;
  try {
    await ensureCreditRequestTable();
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "CreditRequest" WHERE id = $1`, req.params.id);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const request = rows[0];
    if (request.status === 'approved' || request.status === 'denied') {
      return res.status(409).json({ error: `Request already ${request.status}`, request });
    }
    await prisma.$executeRawUnsafe(
      `UPDATE "CreditRequest" SET status = 'denied', "resolvedByDiscordUserId" = $1, "resolvedByDiscordUser" = $2, "resolvedAt" = NOW() WHERE id = $3`,
      resolvedByDiscordUserId || null, resolvedByDiscordUser || null, req.params.id
    );
    const updated = await prisma.$queryRawUnsafe(`SELECT * FROM "CreditRequest" WHERE id = $1`, req.params.id);
    res.json({ success: true, request: updated[0] });
  } catch (err) {
    console.error('[Bot POST /credit-request/:id/deny]', err.message);
    res.status(500).json({ error: 'Could not deny credit request' });
  }
});

// POST /api/bot/credit-requests/escalate-stale — atomically flips any
// still-pending request older than 12h to 'escalated' and returns them,
// so the bot can ping Senior Testers exactly once per request.
router.post('/credit-requests/escalate-stale', botAuth, async (req, res) => {
  try {
    await ensureCreditRequestTable();
    const rows = await prisma.$queryRawUnsafe(`
      UPDATE "CreditRequest"
      SET status = 'escalated', "escalatedAt" = NOW()
      WHERE status = 'pending' AND "createdAt" < NOW() - INTERVAL '12 hours'
      RETURNING *
    `);
    res.json(rows);
  } catch (err) {
    console.error('[Bot POST /credit-requests/escalate-stale]', err.message);
    res.status(500).json({ error: 'Could not escalate credit requests' });
  }
});

module.exports = router;
