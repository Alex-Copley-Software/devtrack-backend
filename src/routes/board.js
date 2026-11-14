// The Assets board.
//   /api/board       the Assets page (admins): cards, tasks and subtasks, updates, images, notes,
//                    check-ins, the list of updates from Discord, settings
//   /api/board/img   an image, by its signed link (no sign-in, so <img> can show it)
//   /api/bot/board   the bot: which channels to read, the messages, and /assets, Give task and
//                    Send to Assets from Discord

const express = require('express');
const axios = require('axios');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const B = require('../board/board');
const T = require('../board/triage');
const devs = require('../devs');
const notifier = require('../discord-notifier');

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (!(err instanceof B.BoardError) && !(err instanceof devs.DevError)) console.error('[Board]', err);
  res.status(err.status || (err.response?.status === 400 ? 400 : 500)).json({ error: err.status ? err.message : String(err.response?.data?.error || err.message) });
});
const who = req => req.user?.name || req.user?.email || null;
const header = (req, name) => { try { return decodeURIComponent(req.headers[name] || ''); } catch { return req.headers[name] || ''; } };

// The dots on the devs' places follow who has something in progress: tell the bot to look again.
function nudgeDots() {
  axios.post(`${process.env.BOT_WEBHOOK_URL || 'http://localhost:3002'}/dots-refresh`, {}, { headers: { 'x-bot-secret': process.env.BOT_SECRET }, timeout: 5000 })
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

  // Game updates
  router.post('/updates', wrap(async (req, res) => res.status(201).json(await B.createUpdate(req.body?.name))));
  router.patch('/updates/:id', wrap(async (req, res) => res.json(await B.renameUpdate(req.params.id, req.body?.name))));
  router.delete('/updates/:id', wrap(async (req, res) => res.json(await B.removeUpdate(req.params.id))));

  // Cards
  router.post('/cards', wrap(async (req, res) => res.status(201).json(await B.createCard(req.body || {}, who(req)))));
  router.patch('/cards/:ref', wrap(async (req, res) => res.json(await B.updateCard(req.params.ref, req.body || {}))));
  router.delete('/cards/:ref', wrap(async (req, res) => { await B.archiveCard(req.params.ref); nudgeDots(); res.json({ ok: true }); }));
  router.post('/cards/:ref/tasks', wrap(async (req, res) => res.status(201).json(await B.addTask(req.params.ref, { name: req.body?.name, parentId: req.body?.parentId }, who(req)))));

  // Tasks and subtasks: a status (with the dev), or a new name
  router.patch('/items/:ref', wrap(async (req, res) => {
    let t = null;
    if ('name' in (req.body || {})) t = await B.renameTask(req.params.ref, req.body.name, who(req));
    if ('status' in (req.body || {})) { t = await B.setStatus(req.params.ref, req.body.status, req.body.devId, who(req)); nudgeDots(); }
    if (!t) throw new B.BoardError(400, 'Send a status or a name');
    res.json({ ok: true, identifier: t.identifier, name: t.name, status: t.status });
  }));
  router.delete('/items/:ref', wrap(async (req, res) => { const r = await B.removeTask(req.params.ref); nudgeDots(); res.json(r); }));
  router.delete('/deliveries/:id', wrap(async (req, res) => { await B.removeDelivery(req.params.id); res.json({ ok: true }); }));

  // Notes, check-ins and history: on a card or a task.
  router.put('/items/:ref/notes', wrap(async (req, res) => res.json({ notes: await B.setNotes(await B.idOf(req.params.ref), req.body?.text, who(req)) })));
  router.post('/items/:ref/checkin', wrap(async (req, res) => {
    await B.addActivity((await B.findTask(req.params.ref)).id, 'checkin', { text: req.body?.note, by: who(req) });
    res.json({ ok: true });
  }));
  router.get('/items/:ref/history', wrap(async (req, res) => res.json(await B.history(req.params.ref))));

  // Ask the dev how it's going: a DM from the bot (or in their place on Discord if DMs are closed).
  router.post('/items/:ref/ping', wrap(async (req, res) => {
    const b = await B.board();
    const all = b.cards.flatMap(u => u.tasks.flatMap(t => [t, ...t.subtasks].map(x => ({ unit: u, task: t, x }))));
    const hit = all.find(a => a.x.identifier === req.params.ref || a.x.id === req.params.ref);
    if (!hit) throw new B.BoardError(404, 'No such task');
    const dev = hit.x.dev;
    if (!dev?.discordUserId && !dev?.channelId) throw new B.BoardError(400, `${hit.x.devName || 'Nobody'} has no Discord account or place on the Developers tab`);
    const what = hit.x === hit.task ? hit.task.name : `${hit.task.name} (${hit.x.name})`;
    const text = String(req.body?.text || '').trim() || `Hey! How's the **${what}** for **${hit.unit.name}** going? Any update or a WIP shot you can share?`;
    const sent = await notifier.boardPing({ userId: dev.discordUserId, channelId: dev.channelId, text: text.slice(0, 1800), from: who(req) });
    await B.addActivity(hit.x.id, 'ping', { text, by: who(req) });
    res.json({ ok: true, queued: !sent });
  }));

  // Images: a card's base image, or a reference on anything. The page resizes before it uploads.
  router.post('/images', express.raw({ type: () => true, limit: '10mb' }), wrap(async (req, res) => {
    const ref = header(req, 'x-issue');
    const issueId = ref ? await B.idOf(ref) : null;
    res.status(201).json(await B.addImage({
      issueId, kind: header(req, 'x-kind') || 'ref', data: req.body, width: Number(req.headers['x-width']), height: Number(req.headers['x-height']),
      caption: header(req, 'x-caption'), by: who(req),
    }));
  }));
  router.post('/images/:id/use', wrap(async (req, res) => {
    res.status(201).json(await B.useImage(req.params.id, await B.idOf(req.body?.issue), req.body?.kind || 'ref', who(req)));
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
  const all = await devs.overview();
  return { settings: s, channels: all.channels || [], reading: await T.watchList(), devPlaces: all.devs.filter(d => d.channelId).length, digest: await B.getMeta('digest') };
}

function botRouter() {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!req.headers['x-bot-secret'] || req.headers['x-bot-secret'] !== process.env.BOT_SECRET) return res.status(401).json({ error: 'Unauthorized bot request' });
    next();
  });
  router.use(express.json({ limit: '1mb' }));
  router.get('/watch', wrap(async (req, res) => res.json({ channelIds: await T.watchList() })));
  router.post('/messages', wrap(async (req, res) => res.json(await T.addMessage(req.body || {}))));

  // /assets and the right-click menus.
  router.get('/search', wrap(async (req, res) => res.json({ tasks: await B.search(req.query.q, { withDone: req.query.done === '1' }) })));
  router.get('/dev-tasks', wrap(async (req, res) => {
    const { byDiscord } = await B.roster();
    const dev = byDiscord.get(String(req.query.discordUserId || ''));
    res.json({ dev: dev || null, tasks: dev ? await B.tasksOf(dev.id) : [] });
  }));
  // Give a task to someone on Discord (added to the Developers tab if they aren't on it).
  router.post('/give', wrap(async (req, res) => {
    const dev = await devs.forDiscord(req.body?.discordUserId, req.body?.name);
    const before = await B.findTask(req.body?.task);
    const t = await B.setStatus(before.id, 'in_progress', dev.id, req.body?.by);
    nudgeDots();
    res.json({ task: { identifier: t.identifier, label: `${t.cardName} › ${t.name}` }, dev: dev.name, was: before.devName && before.devId !== dev.id ? before.devName : null });
  }));
  router.post('/remove', wrap(async (req, res) => {
    const before = await B.findTask(req.body?.task);
    if (before.status !== 'in_progress' && !before.devName) throw new B.BoardError(400, `${before.identifier} isn't anyone's`);
    const t = await B.setStatus(before.id, 'untasked', null, req.body?.by);
    nudgeDots();
    res.json({ task: { identifier: t.identifier, label: `${t.cardName} › ${t.name}` }, was: before.devName });
  }));
  // Send to Assets: the message's link goes on the task, and it's done.
  router.post('/deliver', wrap(async (req, res) => {
    let dev = null;
    if (req.body?.discordUserId) dev = await devs.forDiscord(req.body.discordUserId, req.body.name);
    const { task, was } = await B.deliver(req.body?.task, { url: req.body?.url, files: req.body?.files, note: req.body?.note, devId: dev?.id, devName: req.body?.name, by: req.body?.by });
    nudgeDots();
    res.json({ task: { identifier: task.identifier, label: `${task.cardName} › ${task.name}` }, was, dev: dev?.name || null });
  }));
  router.get('/deliveries', wrap(async (req, res) => res.json(await B.deliveriesOf(req.query.task))));
  // For the dots: each dev and what they have in progress.
  router.get('/working', wrap(async (req, res) => res.json({ devs: await B.working() })));
  return router;
}

module.exports = { pageRouter, botRouter };
