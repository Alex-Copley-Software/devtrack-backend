// Agent routes on the Assets page: the suggestions inbox (leads and
// managers) and the agent settings panel (admins). Registered onto the
// /api/assets router, so auth, the feature flag and req.access already apply.

const C = require('../assets/constants');
const perms = require('../assets/permissions');
const { AssetError } = require('../assets/service');
const suggestions = require('../assets/agent/suggestions');
const settingsStore = require('../assets/agent/settings');
const pipeline = require('../assets/agent/pipeline');
const assistant = require('../assets/agent/assistant');
const payouts = require('../assets/payouts');

module.exports = function registerAgentRoutes(router, h) {
  const forbidden = () => new AssetError(403, 'You do not have permission to do that');
  const requireAdmin = req => { if (!perms.canEditAgentSettings(req.access)) throw forbidden(); };
  const actorOf = req => ({ userId: req.user.id, name: req.user.name });

  // ── suggestions ────────────────────────────────────────────────────────────

  router.get('/suggestions', h(async req => {
    const status = ['pending', 'resolved'].includes(req.query.status) ? req.query.status : 'pending';
    const list = await suggestions.listSuggestions(req.prisma, { status });
    return {
      suggestions: await Promise.all(list.map(async s => ({ ...s, canResolve: s.type === 'log_expenses' ? await canLogExpenses(req) : perms.canResolveSuggestion(req.access, s.updateId) }))),
      pending: await suggestions.countPending(req.prisma),
      agentEnabled: C.isEnabled('ASSET_AGENT_ENABLED'),
    };
  }));

  // Logging expenses is a Revenue action: the owner, or someone with the Revenue page.
  async function canLogExpenses(req) {
    if (req.user?.role === 'owner') return true;
    if (!req.user?.id) return false;
    const rows = await req.prisma.$queryRawUnsafe(`SELECT "pageAccess" FROM "User" WHERE id = $1`, req.user.id).catch(() => []);
    return (rows[0]?.pageAccess || []).includes('revenue');
  }

  async function resolve(req, id, decision, edits) {
    const suggestion = await suggestions.getSuggestion(req.prisma, id);
    if (!suggestion) throw new AssetError(404, 'Suggestion not found');
    if (suggestion.type === 'log_expenses' ? !(await canLogExpenses(req)) : !perms.canResolveSuggestion(req.access, suggestion.updateId)) throw forbidden();
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

  const logSetting = (req, label) => require('../assets/service').logActivity(req.ctx, [{
    entityType: 'setting', entityId: 'agent', action: 'updated', label,
  }]);

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

  // ── assistant (admin) ──────────────────────────────────────────────────────

  router.get('/agent/assistant', h(req => {
    requireAdmin(req);
    return assistant.getSettings(req.prisma);
  }));
  router.put('/agent/assistant', h(async req => {
    requireAdmin(req);
    const before = await assistant.getSettings(req.prisma);
    const settings = await assistant.saveSettings(req.prisma, req.body || {});
    await require('../assets/service').logActivity(req.ctx, [{
      entityType: 'setting', entityId: 'assistant', action: 'updated', field: 'assistant', before, after: settings, label: 'Assistant access changed',
    }]);
    return settings;
  }));

  // ── payout requests ────────────────────────────────────────────────────────
  // Leads and managers see them and can mark them; where they are forwarded is an admin setting.

  router.get('/payouts', h(req => {
    if (!req.access.isManager) throw forbidden();
    return payouts.listPayouts(req.prisma, { status: req.query.status, devId: req.query.devId });
  }));
  router.post('/payouts/:id/resolve', h(req => {
    if (!req.access.isManager) throw forbidden();
    return payouts.resolve(req.prisma, req.params.id, {
      decision: req.body.decision, actorName: req.user.name, reason: req.body.reason, via: 'web', costSharePersonIds: req.body.costSharePersonIds,
    });
  }));
  router.get('/payout-audience', h(async req => {
    if (!req.access.isManager) throw forbidden();
    return { people: await require('../revenue/sync').audienceOptions(req.prisma) };
  }));
  router.get('/agent/payouts', h(req => {
    requireAdmin(req);
    return payouts.getSettings(req.prisma);
  }));
  router.put('/agent/payouts', h(req => {
    requireAdmin(req);
    return payouts.saveSettings(req.prisma, req.body || {});
  }));

  // Files and notes, for the item panel and anyone browsing.
  router.get('/files', h(async req => (await assistant.searchFiles(req.prisma, {
    contentItemId: req.query.contentItemId, item: req.query.item, dev: req.query.dev, text: req.query.q, kind: req.query.kind, limit: req.query.limit,
  })).files));
  router.get('/notes', h(req => assistant.listNotes(req.prisma, { contentItemId: req.query.contentItemId, devId: req.query.devId, text: req.query.q, limit: req.query.limit })));

  // Asks the bot to check it can read the allowlisted channels and post to
  // the review channel. The bot picks it up within a couple of minutes.
  router.post('/agent/self-test', h(async req => {
    requireAdmin(req);
    if (!C.isEnabled('ASSET_AGENT_ENABLED')) throw new AssetError(400, 'The agent is switched off.');
    await pipeline.requestSelfTest(req.prisma, req.user.name);
    await logSetting(req, 'Agent self-test requested');
    return { ok: true };
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
    await logSetting(req, `Agent started reading channel or category ${String(req.body.label || '').trim().slice(0, 80) || channelId} (${channelId})`);
    res.status(201);
    return { channels: await pipeline.listChannels(req.prisma) };
  }));

  router.patch('/agent/channels/:id', h(async req => {
    requireAdmin(req);
    if (req.body.enabled !== undefined) {
      await req.prisma.$executeRawUnsafe(`UPDATE "AssetAgentChannel" SET enabled = $1 WHERE "channelId" = $2`, !!req.body.enabled, req.params.id);
      await logSetting(req, `Agent reading ${req.body.enabled ? 'resumed' : 'paused'} for channel ${req.params.id}`);
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
    await logSetting(req, `Agent stopped reading channel or category ${req.params.id}`);
    await req.prisma.$executeRawUnsafe(
      `DELETE FROM "AssetAgentMessage" WHERE "batchId" IS NULL AND ("channelId" = $1 OR "parentChannelId" = $1 OR "categoryId" = $1)`, req.params.id);
    return { channels: await pipeline.listChannels(req.prisma) };
  }));
};
