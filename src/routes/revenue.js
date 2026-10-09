// /api/revenue: the Revenue page (revenue share, payouts, expenses, Salary
// Pay). Off (404) unless REVENUE_ENABLED=true.
//
// The standalone app this was ported from had no sign-in at all. Here it is
// behind the DevTrack login and its own page-access key: the owner always
// has it, and anyone else needs the Revenue box ticked on their account.
// Being an admin is not enough on its own, because this page shows
// everyone's share and what each person is paid.

const express = require('express');
const auth = require('../middleware/auth');
const { getPrisma } = require('../assets/db');
const { isEnabled } = require('../assets/constants');
const { ensureRevenueSchema } = require('../revenue/schema');
const { buildRouter } = require('../revenue/api');
const transfer = require('../revenue/transfer');
const { RevenueError } = require('../revenue/store');

const router = express.Router();

router.use((req, res, next) => {
  if (!isEnabled('REVENUE_ENABLED')) return res.status(404).json({ detail: 'Not found' });
  next();
});
router.use(auth);

async function hasAccess(prisma, user) {
  if (user.role === 'owner') return true;
  const rows = await prisma.$queryRawUnsafe(`SELECT "pageAccess" FROM "User" WHERE id = $1`, user.id);
  return (rows[0]?.pageAccess || []).includes('revenue');
}

router.use(async (req, res, next) => {
  try {
    const prisma = getPrisma();
    if (!await hasAccess(prisma, req.user)) return res.status(403).json({ detail: 'You do not have access to Revenue.' });
    await ensureRevenueSchema(prisma);
    next();
  } catch (err) {
    console.error('[Revenue setup]', err.message);
    res.status(500).json({ detail: 'Revenue is not ready' });
  }
});

// ── moving the data in and out ───────────────────────────────────────────────
// Replacing or downloading everything is for the owner, or an admin who has been given the page.

const canTransfer = user => ['owner', 'admin'].includes(user.role);
const ownerOnly = (req, res, next) => (canTransfer(req.user) ? next() : res.status(403).json({ detail: 'Only the owner or an admin can do that.' }));
const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)); } catch (err) {
    if (err instanceof RevenueError) return res.status(err.status).json({ detail: err.detail });
    console.error(`[Revenue ${req.method} ${req.path}]`, err.message);
    res.status(500).json({ detail: 'Something went wrong. Nothing was changed.' });
  }
};

router.get('/admin/status', wrap(async req => {
  const prisma = getPrisma();
  const settings = Object.fromEntries((await prisma.$queryRawUnsafe(`SELECT key, value FROM rev_settings WHERE key IN ('imported_at', 'imported_by')`)).map(s => [s.key, s.value]));
  return { counts: await transfer.counts(prisma), imported_at: settings.imported_at || null, imported_by: settings.imported_by || null, is_owner: canTransfer(req.user) };
}));

router.get('/admin/export', ownerOnly, wrap(() => transfer.exportDump(getPrisma())));

// body: { dump, dry_run }. A dry run says what the file holds and changes nothing.
router.post('/admin/import', ownerOnly, express.json({ limit: '25mb' }), wrap(async req => {
  if (req.body.dry_run) return { dry_run: true, ...transfer.describe(req.body.dump), current: await transfer.counts(getPrisma()) };
  const result = await transfer.importDump(getPrisma(), req.body.dump, { actorName: req.user.name });
  console.log(`[Revenue] ${req.user.name} imported a backup: ${JSON.stringify(result.imported)}`);
  return result;
}));

router.use(buildRouter(getPrisma));

module.exports = router;
