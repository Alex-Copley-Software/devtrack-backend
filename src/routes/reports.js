const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { notify } = require('../discord-notifier');
const { log } = require('../history-logger');

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

// Raw SQL helper — bypasses Prisma enum deserialization for 'declined' etc.
async function fetchReports(whereClauses = [], values = [], extra = '') {
  const where = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';
  const sql = `
    SELECT r.*,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email))
        FILTER (WHERE u.id IS NOT NULL), '[]'
      ) AS assignees,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('id', a.id, 'type', a.type, 'url', a.url, 'filename', a.filename))
        FILTER (WHERE a.id IS NOT NULL), '[]'
      ) AS attachments
    FROM "Report" r
    LEFT JOIN "_AssignedReports" ar ON ar."A" = r.id
    LEFT JOIN "User" u ON u.id = ar."B"
    LEFT JOIN "Attachment" a ON a."reportId" = r.id
    ${where}
    GROUP BY r.id
    ${extra}
  `;
  return prisma.$queryRawUnsafe(sql, ...values);
}

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
    const whereClauses = [];
    const vals = [];
    let idx = 1;
    if (type)       { whereClauses.push(`r.type = $${idx++}::"ReportType"`); vals.push(type); }
    if (status)     { whereClauses.push(`r.status = $${idx++}::"Status"`);   vals.push(status); }
    if (priority)   { whereClauses.push(`r.priority = $${idx++}::"Priority"`); vals.push(priority); }
    if (queued !== undefined) { whereClauses.push(`r.queued = $${idx++}`);   vals.push(queued === 'true'); }
    if (assigneeId) { whereClauses.push(`EXISTS (SELECT 1 FROM "_AssignedReports" x WHERE x."A" = r.id AND x."B" = $${idx++})`); vals.push(assigneeId); }
    if (search) {
      whereClauses.push(`(r.title ILIKE $${idx} OR r.description ILIKE $${idx++})`);
      vals.push('%' + search + '%');
    }
    const reports = await fetchReports(whereClauses, vals, 'ORDER BY r."createdAt" DESC');
    res.json(reports);
  } catch (err) {
    console.error('[GET reports]', err.message);
    res.status(500).json({ error: 'Could not fetch reports' });
  }
});

// GET /api/reports/similar — Jaccard similarity duplicate check
router.get('/similar', auth, async (req, res) => {
  const { title, description, excludeId } = req.query;
  if (!title) return res.json([]);

  try {
    const candidateRows = await prisma.$queryRawUnsafe(`
      SELECT r.*, r.status::text AS status,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name)) FILTER (WHERE u.id IS NOT NULL), '[]') AS assignees,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', a.id, 'type', a.type, 'url', a.url)) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
      FROM "Report" r
      LEFT JOIN "_AssignedReports" ar ON ar."A" = r.id
      LEFT JOIN "User" u ON u.id = ar."B"
      LEFT JOIN "Attachment" a ON a."reportId" = r.id
      ${excludeId ? `WHERE r.id != '${excludeId.replace(/'/g,"''")}'` : ''}
      GROUP BY r.id
      ORDER BY r."createdAt" DESC
      LIMIT 100
    `);
    const candidates = candidateRows;

    function tokenize(str) {
      return new Set(
        (str || '').toLowerCase()
          .replace(/[*_#`]/g, '')
          .split(/\W+/)
          .filter(w => w.length >= 3)
      );
    }

    function jaccard(setA, setB) {
      if (!setA.size || !setB.size) return 0;
      const intersection = new Set([...setA].filter(x => setB.has(x)));
      const union = new Set([...setA, ...setB]);
      return intersection.size / union.size;
    }

    function containsSimilarity(a, b) {
      const tokA = tokenize(a);
      const tokB = tokenize(b);
      if (!tokA.size || !tokB.size) return 0;
      const smaller = tokA.size <= tokB.size ? tokA : tokB;
      const larger  = tokA.size <= tokB.size ? tokB : tokA;
      const hits = [...smaller].filter(w => larger.has(w)).length;
      return hits / smaller.size;
    }

    const titleToks = tokenize(title);
    const descToks  = tokenize(description || '');

    const scored = candidates.map(c => {
      const cTitleToks = tokenize(c.title);
      const cDescToks  = tokenize(c.description);

      const titleJaccard  = jaccard(titleToks, cTitleToks);
      const titleContains = containsSimilarity(title, c.title);
      const descJaccard   = jaccard(descToks, cDescToks);

      const combined  = (Math.max(titleJaccard, titleContains) * 0.75) + (descJaccard * 0.25);
      const pct       = Math.round(combined * 100);
      const titlePct  = Math.round(Math.max(titleJaccard, titleContains) * 100);
      const descPct   = Math.round(descJaccard * 100);

      return { ...c, _score: combined, _titlePct: titlePct, _descPct: descPct, _pct: pct };
    });

    const results = scored
      .filter(c => c._pct >= 40 || c._titlePct >= 55)
      .sort((a, b) => b._score - a._score)
      .slice(0, 6);

    res.json(results);
  } catch (err) {
    console.error('[Similar]', err.message);
    res.status(500).json({ error: 'Could not search similar' });
  }
});

// GET /api/reports/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const rows = await fetchReports(['r.id = $1'], [req.params.id]);
    const report = rows[0];
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) {
    console.error('[GET report]', err.message);
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
  const id = req.params.id;

  try {
    // Build raw SQL SET clauses — fully bypasses Prisma enum validation
    const setClauses = [];
    const values     = [];
    let   idx        = 1;

    if (status      !== undefined) { setClauses.push(`status = $${idx++}::"Status"`);        values.push(status); }
    // Auto-dequeue when declining
    if (status === 'declined' && queued === undefined) { setClauses.push(`queued = $${idx++}`); values.push(false); }
    if (priority    !== undefined) { setClauses.push(`priority = $${idx++}::"Priority"`);    values.push(priority); }
    if (bugLevel    !== undefined) { setClauses.push(`"bugLevel" = $${idx++}::"BugLevel"`);  values.push(bugLevel === '' ? null : bugLevel); }
    if (devNotes    !== undefined) { setClauses.push(`"devNotes" = $${idx++}`);               values.push(devNotes); }
    if (queued      !== undefined) { setClauses.push(`queued = $${idx++}`);                   values.push(queued); }
    if (req.body.publishStatus !== undefined) { setClauses.push(`"publishStatus" = $${idx++}`); values.push(req.body.publishStatus); }
    if (req.body.notifyOwner   !== undefined) { setClauses.push(`"notifyOwner" = $${idx++}`);   values.push(req.body.notifyOwner); }
    if (tags !== undefined) {
      const arr = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
      setClauses.push(`tags = $${idx++}`);
      values.push(arr);
    }

    setClauses.push(`"updatedAt" = NOW()`);
    values.push(id);
    const sql = `UPDATE "Report" SET ${setClauses.join(', ')} WHERE id = $${idx}`;
    await prisma.$executeRawUnsafe(sql, ...values);

    // Handle assignees separately (Prisma relation, no enum involved)
    if (assigneeIds !== undefined) {
      await prisma.report.update({
        where: { id },
        data:  { assignees: { set: assigneeIds.map(i => ({ id: i })) } },
      });
    }

    // Auto-publish when resolved
    if (status === 'resolved' && req.body.publishStatus === undefined) {
      await prisma.$executeRawUnsafe(`UPDATE "Report" SET "publishStatus" = 'published' WHERE id = $1`, id);
    }

    // Read back with raw SQL to avoid Prisma enum deserialization on 'declined' etc.
    const rows = await prisma.$queryRawUnsafe(`
      SELECT r.*,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email))
          FILTER (WHERE u.id IS NOT NULL), '[]'
        ) AS assignees,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', a.id, 'type', a.type, 'url', a.url, 'filename', a.filename))
          FILTER (WHERE a.id IS NOT NULL), '[]'
        ) AS attachments
      FROM "Report" r
      LEFT JOIN "_AssignedReports" ar ON ar."A" = r.id
      LEFT JOIN "User" u ON u.id = ar."B"
      LEFT JOIN "Attachment" a ON a."reportId" = r.id
      WHERE r.id = $1
      GROUP BY r.id
    `, id);

    const report = rows[0];
    if (!report) return res.status(404).json({ error: 'Report not found' });

    // Log history
    if (status) {
      await log({ reportId: id, action: status, actorName: req.user.name, actorId: req.user.id });
    }
    if (assigneeIds !== undefined && assigneeIds.length > 0) {
      const assigneeNames = Array.isArray(report.assignees) ? report.assignees.map(a => a.name).join(', ') : 'Unassigned';
      await log({ reportId: id, action: 'assigned', detail: assigneeNames, actorName: req.user.name, actorId: req.user.id });
    }
    if (devNotes !== undefined) {
      await log({ reportId: id, action: 'devnotes', actorName: req.user.name, actorId: req.user.id });
    }

    // Notify Discord on status changes
    if (status && ['in_progress', 'reviewing', 'resolved', 'declined'].includes(status)) {
      const assigneeName = Array.isArray(report.assignees) ? report.assignees[0]?.name || null : null;
      notify({
        threadId:      report.discordThreadId,
        reportType:    report.type,
        action:        status,
        bugLevel:      report.bugLevel,
        devNotes:      devNotes || report.devNotes,
        discordUserId: report.discordUserId,
        assigneeName,
        notifyOwner:   report.notifyOwner,
      });
    }

    res.json(report);
  } catch (err) {
    console.error('[PATCH]', err.message);
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

    notify({
      threadId:      report.discordThreadId,
      reportType:    report.type,
      action:        'accepted',
      bugLevel:      report.bugLevel,
      devNotes:      report.devNotes,
      discordUserId: report.discordUserId,
      assigneeName:  report.assignees?.[0]?.name || null,
      notifyOwner:   report.notifyOwner,
    });

    await log({ reportId: req.params.id, action: 'accepted', detail: `${report.bugLevel||''}${report.assignees?.[0]?.name ? ' → ' + report.assignees[0].name : ''}`, actorName: req.user.name, actorId: req.user.id });
    if (report.assignees?.[0]?.name) await log({ reportId: req.params.id, action: 'assigned', detail: report.assignees[0].name, actorName: req.user.name, actorId: req.user.id });
    if (report.bugLevel) await log({ reportId: req.params.id, action: 'buglevel', detail: report.bugLevel, actorName: req.user.name, actorId: req.user.id });

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Could not accept report' });
  }
});

// DELETE /api/reports/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const [report] = await fetchReports(['r.id = $1'], [req.params.id]);
    await prisma.report.delete({ where: { id: req.params.id } });
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

// POST /api/reports/publish-all — move in_progress+flagged to reviewing
router.post('/publish-all', auth, async (req, res) => {
  try {
    const flagged = await prisma.$queryRaw`SELECT id, "discordThreadId", "discordUserId", "notifyOwner", "devNotes", "bugLevel", type FROM "Report" WHERE status = 'in_progress' AND "publishStatus" = 'flagged'`;
    if (!flagged.length) return res.json({ success: true, count: 0 });

    await prisma.$executeRaw`UPDATE "Report" SET status = 'reviewing', "publishStatus" = 'unpublished' WHERE status = 'in_progress' AND "publishStatus" = 'flagged'`;

    for (const r of flagged) {
      await log({ reportId: r.id, action: 'reviewing', actorName: req.user.name, actorId: req.user.id });
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

// POST /api/reports/:id/publish-resolved — QA approved
router.post('/:id/publish-resolved', auth, async (req, res) => {
  try {
    await prisma.$executeRaw`UPDATE "Report" SET status = 'resolved', "publishStatus" = 'published' WHERE id = ${req.params.id}`;
    const [report] = await fetchReports(['r.id = $1'], [req.params.id]);
    notify({
      threadId:      report.discordThreadId,
      reportType:    report.type,
      action:        'resolved',
      bugLevel:      report.bugLevel,
      devNotes:      report.devNotes,
      discordUserId: report.discordUserId,
      notifyOwner:   report.notifyOwner,
    });
    await log({ reportId: req.params.id, action: 'resolved', actorName: req.user.name, actorId: req.user.id });
    await log({ reportId: req.params.id, action: 'published', actorName: req.user.name, actorId: req.user.id });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Could not resolve report' });
  }
});


// POST /api/reports/:id/approve-suggestion
router.post('/:id/approve-suggestion', auth, async (req, res) => {
  try {
    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: { status: 'open', queued: false },
      include
    });
    notify({
      threadId:      report.discordThreadId,
      reportType:    report.type,
      action:        'accepted',
      devNotes:      report.devNotes,
      discordUserId: report.discordUserId,
      notifyOwner:   report.notifyOwner,
    });
    await log({ reportId: req.params.id, action: 'accepted', actorName: req.user.name, actorId: req.user.id });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Could not approve suggestion' });
  }
});

// POST /api/reports/:id/decline-suggestion
router.post('/:id/decline-suggestion', auth, async (req, res) => {
  const { devNotes } = req.body;
  try {
    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: { status: 'resolved', queued: false, devNotes: devNotes || null },
      include
    });
    notify({
      threadId:      report.discordThreadId,
      reportType:    report.type,
      action:        'declined',
      devNotes:      report.devNotes,
      discordUserId: report.discordUserId,
      notifyOwner:   report.notifyOwner,
    });
    await log({ reportId: req.params.id, action: 'declined', detail: devNotes || null, actorName: req.user.name, actorId: req.user.id });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Could not decline suggestion' });
  }
});

// POST /api/reports/:id/implement-suggestion
router.post('/:id/implement-suggestion', auth, async (req, res) => {
  try {
    await prisma.$executeRaw`UPDATE "Report" SET status = 'resolved', "publishStatus" = 'published' WHERE id = ${req.params.id}`;
    const [report] = await fetchReports(['r.id = $1'], [req.params.id]);
    notify({
      threadId:      report.discordThreadId,
      reportType:    report.type,
      action:        'resolved',
      devNotes:      report.devNotes,
      discordUserId: report.discordUserId,
      notifyOwner:   report.notifyOwner,
    });
    await log({ reportId: req.params.id, action: 'resolved', detail: 'Implemented', actorName: req.user.name, actorId: req.user.id });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: 'Could not implement suggestion' });
  }
});


// POST /api/reports/sync-stars — bot syncs all suggestion star counts
router.post('/sync-stars', async (req, res) => {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const { updates } = req.body; // [{reportId, upvotes}]
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
  try {
    for (const u of updates) {
      await prisma.report.update({
        where: { id: u.reportId },
        data: { upvotes: parseInt(u.upvotes) || 0 }
      });
    }
    res.json({ success: true, count: updates.length });
  } catch (err) {
    res.status(500).json({ error: 'Could not sync stars' });
  }
});

// PATCH /api/reports/:id/upvotes — sync star count from Discord
router.patch('/:id/upvotes', async (req, res) => {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { upvotes } = req.body;
    const report = await prisma.report.update({
      where: { id: req.params.id },
      data: { upvotes: parseInt(upvotes) || 0 }
    });
    res.json({ upvotes: report.upvotes });
  } catch (err) {
    res.status(500).json({ error: 'Could not update upvotes' });
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
