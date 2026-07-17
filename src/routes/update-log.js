const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requirePageAccess } = require('../middleware/page-access');
const db = require('../update-log-db');
const ai = require('../ai-update-log');

const prisma = new PrismaClient();
const requireAccess = requirePageAccess('reports');

router.use(async (req, res, next) => {
  try {
    await db.ensureUpdateLogTable(prisma);
    next();
  } catch (err) {
    console.error('[UpdateLog schema]', err.message);
    res.status(500).json({ error: 'Update log storage is not ready' });
  }
});

// GET /api/update-logs — list past generated update logs
router.get('/', auth, requireAccess, async (req, res) => {
  try {
    const logs = await db.listUpdateLogs(prisma, { limit: 20 });
    res.json(logs);
  } catch (err) {
    console.error('[UpdateLog GET]', err.message);
    res.status(500).json({ error: 'Could not fetch update logs' });
  }
});

// GET /api/update-logs/fixes?since=ISO — candidate resolved fixes to build a log from.
// Defaults "since" to the last saved log's cutoff, or 7 days back if none exist.
router.get('/fixes', auth, requireAccess, async (req, res) => {
  try {
    const until = new Date();
    const since = req.query.since
      ? new Date(req.query.since)
      : (await db.getLastUpdateLogUntil(prisma)) || new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fixes = await db.fetchResolvedFixes(prisma, since, until);
    res.json({ since, until, fixes });
  } catch (err) {
    console.error('[UpdateLog fixes]', err.message);
    res.status(500).json({ error: 'Could not fetch fixes' });
  }
});

// POST /api/update-logs/generate {since, reportIds} — format the selected
// fixes with Claude and save the result. "since" must match the value the
// fixes were fetched with so the same resolved-history window is re-scoped.
router.post('/generate', auth, requireAccess, async (req, res) => {
  const { since, reportIds } = req.body;
  if (!since) return res.status(400).json({ error: 'since is required' });
  if (!Array.isArray(reportIds) || !reportIds.length) {
    return res.status(400).json({ error: 'Select at least one fix' });
  }
  try {
    const until = new Date();
    const sinceDate = new Date(since);
    const candidates = await db.fetchResolvedFixes(prisma, sinceDate, until);
    const fixes = candidates.filter(f => reportIds.includes(f.id));
    if (!fixes.length) return res.status(400).json({ error: 'No matching fixes found — try refreshing the list' });

    const content = await ai.generateUpdateLog(fixes, sinceDate, until);
    const log = await db.saveUpdateLog(prisma, {
      content,
      sinceDate,
      untilDate: until,
      reportIds: fixes.map(f => f.id),
      generatedById: req.user.id,
      generatedByName: req.user.name,
    });
    res.status(201).json(log);
  } catch (err) {
    console.error('[UpdateLog generate]', err.message);
    const message = /ANTHROPIC_API_KEY/.test(err.message)
      ? 'AI generation is not configured (missing ANTHROPIC_API_KEY on the backend)'
      : 'Could not generate update log';
    res.status(500).json({ error: message });
  }
});

module.exports = router;
