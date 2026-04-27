const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { notify } = require('../discord-notifier');

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

const include = {
  assignees: { select: { id: true, name: true, email: true } },
  attachments: true
};

// GET /api/reports
router.get('/', auth, async (req, res) => {
  const { type, status, priority, search, assigneeId, queued } = req.query;
  const where = {};
  if (type) where.type = type;
  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (queued !== undefined) where.queued = queued === 'true';
  if (search) where.OR = [
    { title: { contains: search, mode: 'insensitive' } },
    { description: { contains: search, mode: 'insensitive' } }
  ];
  if (assigneeId) where.assignees = { some: { id: assigneeId } };
  try {
    const reports = await prisma.report.findMany({ where, include, orderBy: { createdAt: 'desc' } });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch reports' });
  }
});

// GET /api/reports/similar
router.get('/similar', auth, async (req, res) => {
  const { title, description, excludeId } = req.query;
  if (!title && !description) return res.json([]);

  // Expanded stop words to avoid common gaming/bug terms inflating scores
  const stopWords = new Set([
    'this','that','with','have','from','they','been','were','when','what','your','will','would',
    'could','should','there','their','about','which','after','before','other','also','more','just',
    'than','then','into','over','some','such','these','those','only','even','most','very','game',
    'using','unit','units','does','not','can','still','being','used','show','appear','able','gets',
    'cant','cannot','make','makes','made','like','same','different','another','issue','problem',
    'report','minor','major','moderate','feedback','feature','request','please','screen','menu',
    'button','click','select','when','where','mode','page','area','section'
  ]);

  // Only use meaningful words — min 5 chars for title, 6 for description
  const titleWords = (title||'').toLowerCase().split(/\W+/).filter(w => w.length >= 5 && !stopWords.has(w));
  const descWords  = (description||'').toLowerCase().split(/\W+/).filter(w => w.length >= 6 && !stopWords.has(w));

  if (!titleWords.length) return res.json([]);

  try {
    // Only search by title words — description matches alone are too noisy
    const candidates = await prisma.report.findMany({
      where: {
        id: excludeId ? { not: excludeId } : undefined,
        OR: titleWords.map(w => ({ title: { contains: w, mode: 'insensitive' } }))
      },
      include,
      orderBy: { createdAt: 'desc' },
      take: 15
    });

    const scored = candidates.map(c => {
      const ct = c.title.toLowerCase();
      const cd = c.description.toLowerCase();

      // Count exact word matches in title (whole word boundary)
      let titleHits = 0;
      titleWords.forEach(w => {
        // Require whole-word match to avoid partial false positives
        const regex = new RegExp(`\b${w}\b`, 'i');
        if (regex.test(ct)) titleHits++;
      });

      // Count desc word matches in candidate description
      let descHits = 0;
      descWords.slice(0, 8).forEach(w => {
        const regex = new RegExp(`\b${w}\b`, 'i');
        if (regex.test(cd)) descHits++;
      });

      const titlePct = titleWords.length >= 2 ? Math.round(titleHits / titleWords.length * 100) : (titleHits > 0 ? 100 : 0);
      const descPct  = descWords.length >= 2  ? Math.round(descHits  / Math.min(descWords.length, 8) * 100) : 0;

      // Combined score — title match is primary signal
      const combinedScore = (titlePct * 0.7) + (descPct * 0.3);

      return { ...c, _score: combinedScore, _titlePct: titlePct, _descPct: descPct };
    });

    // Only show results where title match is 60%+ OR both title+desc are 50%+
    const results = scored
      .filter(c => c._titlePct >= 60 || (c._titlePct >= 50 && c._descPct >= 50))
      .sort((a, b) => b._score - a._score)
      .slice(0, 5);

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Could not search similar' });
  }
});

// GET /api/reports/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const report = await prisma.report.findUnique({ where: { id: req.params.id }, include });
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch report' });
  }
});

// POST /api/reports
router.post('/', auth, upload.array('attachments', 10), async (req, res) => {
  const { type, priority, title, description, tags, discordUser, discordUserId, discordChannel, discordMessageId, discordThreadId } = req.body;
  if (!type || !title || !description)
    return res.status(400).json({ error: 'type, title, and description are required' });
  try {
    const report = await prisma.report.create({
      data: {
        type, priority: priority || 'medium', title, description,
        tags: tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim())) : [],
        discordUser: discordUser || 'unknown',
        discordUserId: discordUserId || null,
        discordChannel: discordChannel || 'unknown',
        discordThreadId: discordThreadId || null,
        discordMessageId: discordMessageId || null,
        queued: true,
        status: 'queued',
        attachments: {
          create: (req.files || []).map(f => ({
            type: f.mimetype.startsWith('image/') ? 'image' : 'video',
            url: `/uploads/${f.filename}`,
            filename: f.originalname
          }))
        }
      },
      include
    });
    res.status(201).json(report);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Already submitted' });
    res.status(500).json({ error: 'Could not create report' });
  }
});

// PATCH /api/reports/:id
router.patch('/:id', auth, async (req, res) => {
  const { status, priority, bugLevel, assigneeIds, tags, devNotes, queued } = req.body;
  const data = {};
  if (status    !== undefined) data.status   = status;
  if (priority  !== undefined) data.priority = priority;
  if (bugLevel  !== undefined) data.bugLevel = bugLevel || null;
  if (tags      !== undefined) data.tags     = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
  if (devNotes  !== undefined) data.devNotes = devNotes;
  if (queued    !== undefined) data.queued   = queued;
  if (req.body.notifyOwner !== undefined) data.notifyOwner = req.body.notifyOwner;
  if (assigneeIds !== undefined) data.assignees = { set: assigneeIds.map(id => ({ id })) };

  try {
    // Handle publishStatus via raw SQL since Prisma client may not have it generated yet
    if (req.body.publishStatus !== undefined) {
      await prisma.$executeRaw`UPDATE "Report" SET "publishStatus" = ${req.body.publishStatus} WHERE id = ${req.params.id}`;
    }
    const report = await prisma.report.update({ where: { id: req.params.id }, data, include });

    // Auto-publish when manually resolved via dropdown
    if (status === 'resolved' && req.body.publishStatus === undefined) {
      await prisma.$executeRaw`UPDATE "Report" SET "publishStatus" = 'published' WHERE id = ${req.params.id}`;
    }

    // Notify Discord on status changes
    if (status && ['in_progress','reviewing','resolved'].includes(status)) {
      const assigneeName = report.assignees?.[0]?.name || null;
      const actionMap = {
        in_progress: 'in_progress',
        reviewing:   'reviewing',
        resolved:    'resolved',
      };
      notify({
        threadId:      report.discordThreadId,
        reportType:    report.type,
        action:        actionMap[status],
        bugLevel:      report.bugLevel,
        devNotes:      report.devNotes,
        discordUserId: report.discordUserId,
        assigneeName,
        notifyOwner:   report.notifyOwner,
      });
    }

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Could not update report' });
  }
});

// POST /api/reports/:id/accept
router.post('/:id/accept', auth, async (req, res) => {
  const { bugLevel, assigneeIds, devNotes, priority } = req.body;
  try {
    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: {
        queued:    false,
        status:    'open',
        bugLevel:  bugLevel || null,
        devNotes:  devNotes || null,
        priority:  priority || 'medium',
        assignees: assigneeIds?.length ? { set: assigneeIds.map(id => ({ id })) } : undefined
      },
      include
    });

    // Notify Discord of acceptance
    const assigneeName = report.assignees?.[0]?.name || null;
    notify({
      threadId:      report.discordThreadId,
      reportType:    report.type,
      action:        'accepted',
      bugLevel:      report.bugLevel,
      devNotes:      report.devNotes,
      discordUserId: report.discordUserId,
      assigneeName,
      notifyOwner:   report.notifyOwner,
    });

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Could not accept report' });
  }
});

// DELETE /api/reports/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    // Fetch before deleting so we have the Discord info
    const report = await prisma.report.findUnique({ where: { id: req.params.id } });

    await prisma.report.delete({ where: { id: req.params.id } });

    // Notify Discord of decline
    if (report) {
      notify({
        threadId:      report.discordThreadId,
        reportType:    report.type,
        action:        'declined',
        devNotes:      report.devNotes,
        discordUserId: report.discordUserId,
        notifyOwner:   report.notifyOwner,
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete report' });
  }
});

// POST /api/reports/publish-all — move all in_progress+flagged to reviewing
router.post('/publish-all', auth, async (req, res) => {
  try {
    // Find all in_progress reports flagged as ready (publishStatus = 'flagged')
    const flagged = await prisma.$queryRaw`SELECT id, "discordThreadId", "discordUserId", "notifyOwner", "devNotes", "bugLevel", type FROM "Report" WHERE status = 'in_progress' AND "publishStatus" = 'flagged'`;
    if (!flagged.length) return res.json({ success: true, count: 0 });

    // Move them all to reviewing
    await prisma.$executeRaw`UPDATE "Report" SET status = 'reviewing', "publishStatus" = 'unpublished' WHERE status = 'in_progress' AND "publishStatus" = 'flagged'`;

    // Notify Discord for each
    const { notify } = require('../discord-notifier');
    for (const r of flagged) {
      notify({
        threadId:      r.discordThreadId,
        reportType:    r.type,
        action:        'reviewing',
        bugLevel:      r.bugLevel,
        devNotes:      r.devNotes,
        discordUserId: r.discordUserId,
        notifyOwner:   r.notifyOwner,
      });
    }

    res.json({ success: true, count: flagged.length });
  } catch (err) {
    console.error('[PublishAll]', err.message);
    res.status(500).json({ error: 'Could not publish reports' });
  }
});

// POST /api/reports/:id/publish-resolved — QA approved, mark as resolved+published
router.post('/:id/publish-resolved', auth, async (req, res) => {
  try {
    await prisma.$executeRaw`UPDATE "Report" SET status = 'resolved', "publishStatus" = 'published' WHERE id = ${req.params.id}`;
    const report = await prisma.report.findUnique({ where: { id: req.params.id }, include });
    const { notify } = require('../discord-notifier');
    notify({
      threadId:      report.discordThreadId,
      reportType:    report.type,
      action:        'resolved',
      bugLevel:      report.bugLevel,
      devNotes:      report.devNotes,
      discordUserId: report.discordUserId,
      notifyOwner:   report.notifyOwner,
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Could not resolve report' });
  }
});

// POST /api/reports/:id/upvote
router.post('/:id/upvote', auth, async (req, res) => {
  try {
    const report = await prisma.report.update({ where: { id: req.params.id }, data: { upvotes: { increment: 1 } } });
    res.json({ upvotes: report.upvotes });
  } catch (err) {
    res.status(500).json({ error: 'Could not upvote' });
  }
});

module.exports = router;