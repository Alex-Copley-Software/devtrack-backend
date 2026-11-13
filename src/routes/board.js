// The Assets board.
//   /api/board       the Assets page (admins): units and tasks from Linear, images, notes,
//                    check-ins, the list of updates from Discord, settings
//   /api/board/img   an image, by its signed link (no sign-in, so <img> can show it)
//   /api/bot/board   the bot: which channels to read, the messages, "Linear just changed"

const express = require('express');
const axios = require('axios');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const B = require('../board/board');
const T = require('../board/triage');
const notifier = require('../discord-notifier');

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (!(err instanceof B.BoardError)) console.error('[Board]', err);
  res.status(err.status || (err.response?.status === 400 ? 400 : 500)).json({ error: err.status ? err.message : String(err.response?.data?.error || err.message) });
});
const who = req => req.user?.name || req.user?.email || null;
const header = (req, name) => { try { return decodeURIComponent(req.headers[name] || ''); } catch { return req.headers[name] || ''; } };

// The dots on the devs' places follow In Progress: tell the bot to look again.
function nudgeDots() {
  axios.post(`${process.env.BOT_WEBHOOK_URL || 'http://localhost:3002'}/linear-refresh`, {}, { headers: { 'x-bot-secret': process.env.BOT_SECRET }, timeout: 5000 })
    .catch(err => console.error('[Board] Could not nudge the bot:', err.code || err.message));
}

function pageRouter() {
  const router = express.Router();
  // Images first: they're fetched by <img>, which can't sign in; the link itself is signed.
  router.get('/img/:id', wrap(async (req, res) => {
    const { mime, data } = await B.image(req.params.id, req.query.s);
    res.set('Content-Type', mime);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(data);
  }));
  router.use(auth, requireRole('admin'));

  router.get('/', wrap(async (req, res) => res.json(await B.board())));
  router.post('/sync', wrap(async (req, res) => { await B.sync(); res.json(await B.board()); }));

  router.patch('/items/:ref', wrap(async (req, res) => {
    const i = await B.setStatus(req.params.ref, req.body?.status, req.body?.devId, who(req));
    nudgeDots();
    res.json({ ok: true, identifier: i.identifier, title: i.title, state: i.state?.name });
  }));
  router.put('/items/:ref/notes', wrap(async (req, res) => res.json({ notes: await B.setNotes(B.issue(req.params.ref).id, req.body?.text, who(req)) })));
  router.post('/items/:ref/checkin', wrap(async (req, res) => {
    await B.addActivity(B.issue(req.params.ref).id, 'checkin', { text: req.body?.note, by: who(req) });
    res.json({ ok: true });
  }));
  router.get('/items/:ref/history', wrap(async (req, res) => res.json(await B.history(req.params.ref))));

  // Ask the dev how it's going: a DM from the bot (or in their place on Discord if DMs are closed).
  router.post('/items/:ref/ping', wrap(async (req, res) => {
    const b = await B.board();
    const all = b.units.flatMap(u => u.tasks.flatMap(t => [t, ...t.shinies].map(x => ({ unit: u, task: t, x }))));
    const hit = all.find(a => a.x.identifier === req.params.ref || a.x.id === req.params.ref);
    if (!hit) throw new B.BoardError(404, 'No such task');
    const dev = hit.x.dev;
    if (!dev?.discordUserId && !dev?.channelId) throw new B.BoardError(400, `${hit.x.devName || 'Nobody'} has no Discord account or place on the Developers page`);
    const what = hit.x === hit.task ? hit.task.name : `${hit.task.name} (${hit.x.name})`;
    const text = String(req.body?.text || '').trim() || `Hey! How's the **${what}** for **${hit.unit.name}** going? Any update or a WIP shot you can share?`;
    const sent = await notifier.boardPing({ userId: dev.discordUserId, channelId: dev.channelId, text: text.slice(0, 1800), from: who(req) });
    await B.addActivity(hit.x.id, 'ping', { text, by: who(req) });
    res.json({ ok: true, queued: !sent });
  }));

  // Images: a unit's base image, or a reference on anything. The page resizes before it uploads.
  router.post('/images', express.raw({ type: () => true, limit: '10mb' }), wrap(async (req, res) => {
    const ref = header(req, 'x-issue');
    const issueId = ref ? B.issue(ref).id : null;
    res.status(201).json(await B.addImage({
      issueId, kind: header(req, 'x-kind') || 'ref', data: req.body, width: Number(req.headers['x-width']), height: Number(req.headers['x-height']),
      caption: header(req, 'x-caption'), by: who(req),
    }));
  }));
  router.post('/images/:id/use', wrap(async (req, res) => {
    res.status(201).json(await B.useImage(req.params.id, B.issue(req.body?.issue).id, req.body?.kind || 'ref', who(req)));
  }));
  router.delete('/images/:id', wrap(async (req, res) => { await B.removeImage(req.params.id); res.json({ ok: true }); }));

  router.get('/settings', wrap(async (req, res) => res.json(await settingsView())));
  router.put('/settings', wrap(async (req, res) => { await B.setSettings(req.body || {}); res.json(await settingsView()); }));

  router.get('/inbox', wrap(async (req, res) => res.json(await T.inbox())));
  router.post('/inbox/:id', wrap(async (req, res) => {
    await T.decide(req.params.id, req.body?.decision, who(req), undefined, { devId: req.body?.devId });
    if (req.body?.decision === 'apply') nudgeDots();
    res.json(await T.inbox());
  }));
  router.post('/triage', wrap(async (req, res) => { const r = await T.triage(); res.json({ ...r, ...(await T.inbox()) }); }));
  router.post('/digest', wrap(async (req, res) => res.json(await T.digest(undefined, undefined, new Date(), true))));
  return router;
}

// The settings, with the channels the bot can see (for the picker) and the ones it reads now.
async function settingsView() {
  const s = await B.settings();
  const devs = require('../devs');
  const all = await devs.overview();
  return { settings: s, channels: all.channels || [], reading: await T.watchList(), devPlaces: all.devs.filter(d => d.channelId).length, digest: await B.getMeta('digest') };
}

function botRouter() {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!req.headers['x-bot-secret'] || req.headers['x-bot-secret'] !== process.env.BOT_SECRET) return res.status(401).json({ error: 'Unauthorized bot request' });
    next();
  });
  router.get('/watch', wrap(async (req, res) => res.json({ channelIds: await T.watchList() })));
  router.post('/messages', express.json({ limit: '1mb' }), wrap(async (req, res) => res.json(await T.addMessage(req.body || {}))));
  // /linear just changed something: read Linear again now rather than in up to a minute.
  router.post('/sync', wrap(async (req, res) => { B.sync().catch(() => {}); res.json({ ok: true }); }));
  return router;
}

module.exports = { pageRouter, botRouter };
