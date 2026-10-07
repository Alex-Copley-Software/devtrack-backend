// Agent routes on the Assets page: the suggestions inbox (leads and
// managers) and the agent settings panel (admins). Registered onto the
// /api/assets router, so auth, the feature flag and req.access already apply.

const C = require('../assets/constants');
const perms = require('../assets/permissions');
const { AssetError } = require('../assets/service');
const suggestions = require('../assets/agent/suggestions');
const settingsStore = require('../assets/agent/settings');
const pipeline = require('../assets/agent/pipeline');

module.exports = function registerAgentRoutes(router, h) {
  const forbidden = () => new AssetError(403, 'You do not have permission to do that');
  const requireAdmin = req => { if (!perms.canEditAgentSettings(req.access)) throw forbidden(); };
  const actorOf = req => ({ userId: req.user.id, name: req.user.name });

  // ── suggestions ────────────────────────────────────────────────────────────

  router.get('/suggestions', h(async req => {
    const status = ['pending', 'resolved'].includes(req.query.status) ? req.query.status : 'pending';
    const list = await suggestions.listSuggestions(req.prisma, { status });
    return {
      suggestions: list.map(s => ({ ...s, canResolve: perms.canResolveSuggestion(req.access, s.updateId) })),
      pending: await suggestions.countPending(req.prisma),
      agentEnabled: C.isEnabled('ASSET_AGENT_ENABLED'),
    };
  }));

  async function resolve(req, id, decision, edits) {
    const suggestion = await suggestions.getSuggestion(req.prisma, id);
    if (!suggestion) throw new AssetError(404, 'Suggestion not found');
    if (!perms.canResolveSuggestion(req.access, suggestion.updateId)) throw forbidden();
    return suggestions.resolveSuggestion(req.prisma, id, {
      decision, via: 'web', actor: actorOf(req),
      edits: decision === 'accept' ? suggestions.pickEdits(suggestion.type, edits) : undefined,
    });
  }

  router.post('/suggestions/:id/accept', h(req => resolve(req, req.params.id, 'accept', req.body.edits)));
  router.post('/suggestions/:id/reject', h(req => resolve(req, req.params.id, 'reject')));

  // Accepts each one independently and reports failures instead of stopping at the first.
  router.post('/suggestions/bulk-accept', h(async req => {
    const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(String))].slice(0, 200) : [];
    if (!ids.length) throw new AssetError(400, 'No suggestions selected');
    const accepted = [];
    const failed = [];
    for (const id of ids) {
      try { accepted.push((await resolve(req, id, 'accept')).id); }
      catch (err) { failed.push({ id, error: err.message }); }
    }
    return { accepted, failed };
  }));

  // ── settings (admin) ───────────────────────────────────────────────────────

  router.get('/agent/settings', h(async req => {
    requireAdmin(req);
    const [settings, channels, usage] = await Promise.all([
      settingsStore.getSettings(req.prisma), pipeline.listChannels(req.prisma), settingsStore.usageSummary(req.prisma),
    ]);
    const [{ n: waiting }] = await req.prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetAgentMessage" WHERE "batchId" IS NULL`);
    return {
      enabled: C.isEnabled('ASSET_AGENT_ENABLED'),
      apiKeySet: !!process.env.ANTHROPIC_API_KEY,
      settings, channels, usage, waitingMessages: waiting,
      autoApplyTypes: settingsStore.AUTO_APPLY_TYPES,
      neverAutoApply: C.NEVER_AUTO_APPLY,
      models: { filter: require('../assets/agent/model').FILTER_MODEL(), extract: require('../assets/agent/model').EXTRACT_MODEL() },
    };
  }));

  router.put('/agent/settings', h(async req => {
    requireAdmin(req);
    const before = await settingsStore.getSettings(req.prisma);
    const settings = await settingsStore.saveSettings(req.prisma, req.body || {});
    await require('../assets/service').logActivity(req.ctx, [{
      entityType: 'setting', entityId: 'agent', action: 'updated', field: 'agent', before, after: settings, label: 'Agent settings changed',
    }]);
    return { settings };
  }));

  router.post('/agent/channels', h(async (req, res) => {
    requireAdmin(req);
    const channelId = String(req.body.channelId || '').trim();
    if (!/^\d{17,20}$/.test(channelId)) throw new AssetError(400, 'Enter a Discord channel or category ID (17 to 20 digits). Right-click the channel in Discord and choose Copy Channel ID.');
    await req.prisma.$executeRawUnsafe(`
      INSERT INTO "AssetAgentChannel" ("channelId", "label", "addedByName") VALUES ($1, $2, $3)
      ON CONFLICT ("channelId") DO UPDATE SET label = EXCLUDED.label, enabled = true
    `, channelId, String(req.body.label || '').trim().slice(0, 80) || null, req.user.name);
    res.status(201);
    return { channels: await pipeline.listChannels(req.prisma) };
  }));

  router.patch('/agent/channels/:id', h(async req => {
    requireAdmin(req);
    if (req.body.enabled !== undefined) {
      await req.prisma.$executeRawUnsafe(`UPDATE "AssetAgentChannel" SET enabled = $1 WHERE "channelId" = $2`, !!req.body.enabled, req.params.id);
    }
    if (req.body.label !== undefined) {
      await req.prisma.$executeRawUnsafe(`UPDATE "AssetAgentChannel" SET label = $1 WHERE "channelId" = $2`, String(req.body.label).trim().slice(0, 80) || null, req.params.id);
    }
    return { channels: await pipeline.listChannels(req.prisma) };
  }));

  // Removing a channel also drops what was stored from it and not yet read.
  router.delete('/agent/channels/:id', h(async req => {
    requireAdmin(req);
    await req.prisma.$executeRawUnsafe(`DELETE FROM "AssetAgentChannel" WHERE "channelId" = $1`, req.params.id);
    await req.prisma.$executeRawUnsafe(
      `DELETE FROM "AssetAgentMessage" WHERE "batchId" IS NULL AND ("channelId" = $1 OR "parentChannelId" = $1 OR "categoryId" = $1)`, req.params.id);
    return { channels: await pipeline.listChannels(req.prisma) };
  }));
};
