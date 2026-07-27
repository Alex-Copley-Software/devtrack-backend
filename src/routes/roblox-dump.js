const crypto = require('crypto');
const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requirePageAccess } = require('../middleware/page-access');
const db = require('../roblox-dump-db');

const prisma = new PrismaClient();
const requireAccess = requirePageAccess('admin');

router.use(async (req, res, next) => {
  try {
    await db.ensureRobloxDumpTable(prisma);
    next();
  } catch (err) {
    console.error('[RobloxDump schema]', err.message);
    res.status(500).json({ error: 'Dump storage is not ready' });
  }
});

function verifySecret(header) {
  const secret = process.env.ROBLOX_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(String(header));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// POST /api/roblox-dump/webhook — Roblox posts arbitrary JSON here.
// Authenticated via a shared secret header (not a user JWT — Roblox can't
// hold one), mirroring the bot's x-bot-secret pattern. Mounted with its own
// larger JSON body limit in index.js since content dumps can be sizable.
router.post('/webhook', async (req, res) => {
  if (!verifySecret(req.headers['x-roblox-secret'])) {
    return res.status(401).json({ error: 'Invalid or missing x-roblox-secret header' });
  }
  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }
  try {
    const id = await db.saveDump(prisma, {
      eventType: typeof payload.eventType === 'string' ? payload.eventType : 'unknown',
      robloxUserId: payload.userId !== undefined ? String(payload.userId) : null,
      payload,
    });
    console.log(`[RobloxDump] Saved dump ${id} (${payload.eventType || 'unknown'})`);
    res.status(201).json({ success: true, id });
  } catch (err) {
    console.error('[RobloxDump webhook]', err.message);
    res.status(500).json({ error: 'Could not save dump' });
  }
});

// GET /api/roblox-dump — list (no full payload), admin page-access only
router.get('/', auth, requireAccess, async (req, res) => {
  try {
    const dumps = await db.listDumps(prisma, { limit: 50, eventType: req.query.eventType });
    res.json(dumps);
  } catch (err) {
    console.error('[RobloxDump GET]', err.message);
    res.status(500).json({ error: 'Could not fetch dumps' });
  }
});

// GET /api/roblox-dump/event-types — distinct event types for the filter dropdown
router.get('/event-types', auth, requireAccess, async (req, res) => {
  try {
    res.json(await db.listEventTypes(prisma));
  } catch (err) {
    console.error('[RobloxDump event-types]', err.message);
    res.status(500).json({ error: 'Could not fetch event types' });
  }
});

// GET /api/roblox-dump/:id — full record including payload
router.get('/:id', auth, requireAccess, async (req, res) => {
  try {
    const dump = await db.getDump(prisma, req.params.id);
    if (!dump) return res.status(404).json({ error: 'Dump not found' });
    res.json(dump);
  } catch (err) {
    console.error('[RobloxDump GET :id]', err.message);
    res.status(500).json({ error: 'Could not fetch dump' });
  }
});

// DELETE /api/roblox-dump/:id
router.delete('/:id', auth, requireAccess, async (req, res) => {
  try {
    await db.deleteDump(prisma, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[RobloxDump DELETE]', err.message);
    res.status(500).json({ error: 'Could not delete dump' });
  }
});

module.exports = router;
