// Model viewer.
//   /api/bot/models   the bot hands over a .blend from Discord (x-bot-secret)
//   /api/models       the Models page: list, view, name the parts, export FBX (admins)

const express = require('express');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const store = require('../models/store');

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (!(err instanceof store.ModelError)) console.error('[Models]', err);
  res.status(err.status || 500).json({ error: err.status ? err.message : `Something went wrong: ${err.message}` });
});

const header = (req, name) => { try { return decodeURIComponent(req.headers[name] || ''); } catch { return req.headers[name] || ''; } };

function botRouter() {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!req.headers['x-bot-secret'] || req.headers['x-bot-secret'] !== process.env.BOT_SECRET) return res.status(401).json({ error: 'Unauthorized bot request' });
    next();
  });
  router.post('/', express.raw({ type: () => true, limit: '40mb' }), wrap(async (req, res) => {
    const made = await store.create({
      name: header(req, 'x-file-name'), blend: req.body, uploadedBy: header(req, 'x-uploaded-by'), sourceUrl: header(req, 'x-source-url'),
    });
    res.status(201).json(made);
  }));
  return router;
}

function pageRouter() {
  const router = express.Router();
  router.use(auth, requireRole('admin'));
  router.get('/', wrap(async (req, res) => res.json(await store.list())));
  router.get('/:id', wrap(async (req, res) => res.json(await store.get(req.params.id))));
  for (const [route, column, type] of [['glb', 'glb', 'model/gltf-binary'], ['blend', 'blend', 'application/octet-stream']]) {
    router.get(`/:id/${route}`, wrap(async (req, res) => {
      const { name, data } = await store.file(req.params.id, column);
      res.set('Content-Type', type);
      if (route === 'blend') res.attachment(name);
      res.send(data);
    }));
  }
  router.put('/:id/assignments', wrap(async (req, res) => res.json({ assignments: await store.setAssignments(req.params.id, req.body?.assignments) })));
  router.post('/:id/export', wrap(async (req, res) => {
    const { embedTextures, smallScale } = req.body || {};
    const { name, data, plan } = await store.exportModel(req.params.id, req.user?.name || req.user?.email, undefined, undefined, { embedTextures, smallScale });
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Renamed', String(Object.keys(plan.rename).length));
    res.set('X-Dropped', String(plan.drop.length));
    res.set('Access-Control-Expose-Headers', 'Content-Disposition, X-Renamed, X-Dropped');
    res.attachment(name);
    res.send(data);
  }));
  router.delete('/:id', wrap(async (req, res) => { await store.remove(req.params.id); res.json({ ok: true }); }));
  return router;
}

module.exports = { botRouter, pageRouter };
