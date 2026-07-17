const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requirePageAccess } = require('../middleware/page-access');
const db = require('../team-reports-db');
const ai = require('../ai-report');

const prisma = new PrismaClient();

// Team Reports lives on the "reports" dashboard page, unlocked by that
// page-access checkbox alone (not full admin role) — a QA/reviewer/engineer
// with the box checked can view and generate reports without gaining
// user-management access, which stays restricted to true admin/owner roles
// (see requireRole('admin') elsewhere, e.g. auth.js user routes).
const requireAdminAccess = requirePageAccess('reports');

router.use(async (req, res, next) => {
  try {
    await db.ensureTeamReportTable(prisma);
    next();
  } catch (err) {
    console.error('[TeamReports schema]', err.message);
    res.status(500).json({ error: 'Report storage is not ready' });
  }
});

// GET /api/team-reports — list past generated reports
router.get('/', auth, requireAdminAccess, async (req, res) => {
  try {
    const reports = await db.listReports(prisma, { limit: 20 });
    res.json(reports);
  } catch (err) {
    console.error('[TeamReports GET]', err.message);
    res.status(500).json({ error: 'Could not fetch reports' });
  }
});

// POST /api/team-reports/generate — gather activity + call Claude + save
router.post('/generate', auth, requireAdminAccess, async (req, res) => {
  const period = req.body.period === 'daily' ? 'daily' : 'weekly';
  const end = new Date();
  const start = new Date(end.getTime() - (period === 'daily' ? 24 : 7 * 24) * 60 * 60 * 1000);
  try {
    const summary = await db.buildActivitySummary(prisma, start, end);
    const content = await ai.generateReport(period, start, end, summary);
    const report = await db.saveReport(prisma, {
      period,
      periodStart: start,
      periodEnd: end,
      content,
      generatedById: req.user.id,
      generatedByName: req.user.name,
    });
    res.status(201).json(report);
  } catch (err) {
    console.error('[TeamReports generate]', err.message);
    const message = /ANTHROPIC_API_KEY/.test(err.message)
      ? 'AI report generation is not configured (missing ANTHROPIC_API_KEY on the backend)'
      : 'Could not generate report';
    res.status(500).json({ error: message });
  }
});

module.exports = router;
