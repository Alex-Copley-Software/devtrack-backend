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

  const stopWords = new Set(['this','that','with','have','from','they','been','were','when','what','your','will','would','could','should','there','their','about','which','after','before','other','also','more','just','than','then','into','over','some','such','these','those','only','even','most']);
  const titleWords = (title||'').toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopWords.has(w));
  const descWords  = (description||'').toLowerCase().split(/\W+/).filter(w => w.length > 4 && !stopWords.has(w));
  const allWords   = [...new Set([...titleWords, ...descWords.slice(0, 10)])];
  if (!allWords.length) return res.json([]);

  try {
    const candidates = await prisma.report.findMany({
      where: {
        id: excludeId ? { not: excludeId } : undefined,
        OR: [
          ...titleWords.map(w => ({ title: { contains: w, mode: 'insensitive' } })),
          ...descWords.slice(0, 6).map(w => ({ description: { contains: w, mode: 'insensitive' } })),
        ]
      },
      include,
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    const scored = candidates.map(c => {
      const ct = c.title.toLowerCase();
      const cd = c.description.toLowerCase();
      let score = 0, titleHits = 0, descHits = 0;
      titleWords.forEach(w => { if(ct.includes(w)){score+=3;titleHits++;} if(cd.includes(w)) score+=1; });
      descWords.slice(0,10).forEach(w => { if(ct.includes(w)) score+=2; if(cd.includes(w)){score+=2;descHits++;} });
      return {
        ...c,
        _score: score,
        _titlePct: titleWords.length ? Math.round(titleHits/titleWords.length*100) : 0,
        _descPct:  descWords.length  ? Math.round(descHits/Math.min(descWords.length,10)*100) : 0
      };
    });

    const results = scored
      .filter(c => c._score >= 3)
      .sort((a,b) => b._score - a._score)
      .slice(0, 6)
      .filter(c => c._titlePct >= 50 || c._descPct >= 50);
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
  if (req.body.publishStatus !== undefined) data.publishStatus = req.body.publishStatus;
  if (assigneeIds !== undefined) data.assignees = { set: assigneeIds.map(id => ({ id })) };

  try {
    const report = await prisma.report.update({ where: { id: req.params.id }, data, include });

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

// POST /api/reports/publish-all — mark all resolved+unpublished as published
router.post('/publish-all', auth, async (req, res) => {
  try {
    const result = await prisma.report.updateMany({
      where: { status: 'resolved', publishStatus: 'unpublished' },
      data: { publishStatus: 'published' }
    });
    res.json({ success: true, count: result.count });
  } catch (err) {
    res.status(500).json({ error: 'Could not publish reports' });
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