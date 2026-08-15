const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

const prisma = new PrismaClient();

// GET /api/history/activity/feed - recent activity across bug reports and
// dev board task cards, merged into one chronological feed
router.get('/activity/feed', auth, async (req, res) => {
  try {
    const reportActivity = await prisma.$queryRawUnsafe(`
      SELECT
        rh.id,
        rh."reportId",
        rh.action,
        rh.detail,
        rh."actorName",
        rh."actorId",
        rh."createdAt",
        r.title,
        r.type::text AS "reportType",
        r.status::text AS "reportStatus",
        r."bugLevel"::text AS "bugLevel"
      FROM "ReportHistory" rh
      JOIN "Report" r ON r.id = rh."reportId"
      JOIN "User" u ON u.id = rh."actorId"
      WHERE r.type IN ('bug', 'crash')
      ORDER BY rh."createdAt" DESC
      LIMIT 250
    `);

    // Board task activity — same "must have a real actor" filter as reports,
    // which also has the side effect of excluding the one-time migration's
    // backfilled "created" entries (logged with actorId NULL).
    const boardTaskActivity = await prisma.$queryRawUnsafe(`
      SELECT
        bth.id,
        bth."boardTaskId",
        bth.action,
        bth.detail,
        bth."actorName",
        bth."actorId",
        bth."createdAt",
        bt.title
      FROM "BoardTaskHistory" bth
      JOIN "BoardTask" bt ON bt.id = bth."boardTaskId"
      JOIN "User" u ON u.id = bth."actorId"
      ORDER BY bth."createdAt" DESC
      LIMIT 250
    `).catch(() => []); // table may not exist yet if no board task has ever changed

    const merged = [
      ...reportActivity.map(r => ({ ...r, sourceType: 'report' })),
      ...boardTaskActivity.map(b => ({ ...b, sourceType: 'boardTask' })),
    ]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 250);

    res.json(merged);
  } catch (err) {
    console.error('[Activity GET]', err.message);
    res.status(500).json({ error: 'Could not fetch activity' });
  }
});

// GET /api/history/:reportId
router.get('/:reportId', auth, async (req, res) => {
  try {
    const history = await prisma.reportHistory.findMany({
      where: { reportId: req.params.reportId },
      orderBy: { createdAt: 'asc' }
    });
    res.json(history);
  } catch (err) {
    console.error('[History GET]', err.message);
    res.status(500).json({ error: 'Could not fetch history' });
  }
});

// POST /api/history — log a history entry (internal use)
router.post('/', auth, requireRole('admin'), async (req, res) => {
  const { reportId, action, detail, actorName, actorId } = req.body;
  if (!reportId || !action) return res.status(400).json({ error: 'reportId and action required' });
  try {
    const entry = await prisma.reportHistory.create({
      data: {
        reportId,
        action,
        detail: detail || null,
        actorName: actorName || 'System',
        actorId: actorId || '',
      }
    });
    res.status(201).json(entry);
  } catch (err) {
    console.error('[History POST]', err.message);
    res.status(500).json({ error: 'Could not log history' });
  }
});

module.exports = router;
