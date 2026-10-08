// /api/payouts: what testers are owed. Admins and owners only.
//
//   GET  /settings                    rates and rules
//   PUT  /settings
//   GET  /periods                     pay periods
//   POST /periods                     { name, startsOn, endsOn, notes }
//   PATCH/DELETE /periods/:id
//   GET  /periods/:id/summary         per-tester totals for the period (frozen once paid)
//   POST /periods/:id/paid            freeze the numbers and mark it paid
//   POST /periods/:id/reopen
//   GET  /summary?from=&to=           the same totals for any date range
//   GET  /checks?status=&from=&to=    the tester QA log

const router = require('express').Router();
const { getPrisma } = require('../assets/db');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const pay = require('../tester-pay');

// Resolved per request so the local dev server can swap in its in-memory database.
const db = () => getPrisma();

const h = fn => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json(result === undefined ? { success: true } : result);
  } catch (err) {
    if (err instanceof pay.PayError) return res.status(err.status).json({ error: err.message });
    console.error(`[Payouts ${req.method} ${req.path}]`, err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
};

router.use(auth, requireRole('admin'));

router.get('/settings', h(() => pay.getSettings(db())));
router.put('/settings', h(req => pay.saveSettings(db(), req.body || {})));

router.get('/periods', h(() => pay.listPeriods(db())));
router.post('/periods', h(async (req, res) => {
  res.status(201);
  return pay.createPeriod(db(), req.body || {}, req.user.name);
}));
router.patch('/periods/:id', h(req => pay.updatePeriod(db(), req.params.id, req.body || {})));
router.delete('/periods/:id', h(req => pay.deletePeriod(db(), req.params.id)));
router.get('/periods/:id/summary', h(req => pay.periodSummary(db(), req.params.id)));
router.post('/periods/:id/paid', h(req => pay.markPaid(db(), req.params.id, req.user.name)));
router.post('/periods/:id/reopen', h(req => pay.reopenPeriod(db(), req.params.id)));

router.get('/summary', h(req => pay.summarize(db(), { from: req.query.from, to: req.query.to })));
router.get('/checks', h(req => pay.listChecks(db(), req.query)));

module.exports = router;
