// Developers and where their Linear dot goes.
//   /api/devs       the Developers page (admins)
//   /api/bot/devs   the bot: the list, plus the channels and dots it reports back

const express = require('express');
const axios = require('axios');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const devs = require('../devs');

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (!(err instanceof devs.DevError)) console.error('[Devs]', err);
  res.status(err.status || 500).json({ error: err.status ? err.message : `Something went wrong: ${err.message}` });
});

// Tells the bot to look again now, so a change shows on Discord in seconds rather than at the next sync.
function nudgeBot() {
  const url = process.env.BOT_WEBHOOK_URL || 'http://localhost:3002';
  axios.post(`${url}/linear-refresh`, {}, { headers: { 'x-bot-secret': process.env.BOT_SECRET }, timeout: 5000 })
    .catch(err => console.error('[Devs] Could not nudge the bot:', err.code || err.message));
}

function pageRouter() {
  const router = express.Router();
  router.use(auth, requireRole('admin'));
  router.get('/', wrap(async (req, res) => res.json(await devs.overview())));
  router.post('/', wrap(async (req, res) => { const d = await devs.create(req.body); nudgeBot(); res.status(201).json(d); }));
  router.patch('/:id', wrap(async (req, res) => { const d = await devs.update(req.params.id, req.body); nudgeBot(); res.json(d); }));
  router.delete('/:id', wrap(async (req, res) => { await devs.remove(req.params.id); nudgeBot(); res.json({ ok: true }); }));
  router.post('/refresh', wrap(async (req, res) => { nudgeBot(); res.json({ ok: true }); }));
  return router;
}

function botRouter() {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!req.headers['x-bot-secret'] || req.headers['x-bot-secret'] !== process.env.BOT_SECRET) return res.status(401).json({ error: 'Unauthorized bot request' });
    next();
  });
  router.get('/', wrap(async (req, res) => res.json({ devs: await devs.list() })));
  router.put('/channels', express.json({ limit: '2mb' }), wrap(async (req, res) => { await devs.setChannels(req.body?.channels); res.json({ ok: true }); }));
  router.put('/status', express.json({ limit: '2mb' }), wrap(async (req, res) => { await devs.setStatus(req.body?.status); res.json({ ok: true }); }));
  return router;
}

module.exports = { pageRouter, botRouter };
