// /api/bot/assets: what the Discord bot needs for the asset tracker. Same
// x-bot-secret auth as the other bot routes. 404 unless ASSETS_ENABLED;
// the agent endpoints additionally need ASSET_AGENT_ENABLED.

const router = require('express').Router();
const { getPrisma } = require('../assets/db');
const { ensureAssetSchema } = require('../assets/schema');
const C = require('../assets/constants');
const q = require('../assets/queries');
const service = require('../assets/service');
const perms = require('../assets/permissions');
const pipeline = require('../assets/agent/pipeline');
const assistant = require('../assets/agent/assistant');
const payouts = require('../assets/payouts');
const suggestions = require('../assets/agent/suggestions');

const { AssetError } = service;

const h = fn => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json(result === undefined ? { success: true } : result);
  } catch (err) {
    if (err instanceof AssetError) return res.status(err.status).json({ error: err.message });
    console.error(`[BotAssets ${req.method} ${req.path}]`, err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
};

router.use((req, res, next) => {
  if (!C.isEnabled('ASSETS_ENABLED')) return res.status(404).json({ error: 'Not found' });
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_SECRET) return res.status(401).json({ error: 'Unauthorized bot request' });
  next();
});
router.use(async (req, res, next) => {
  try {
    req.prisma = getPrisma();
    await ensureAssetSchema(req.prisma);
    next();
  } catch (err) {
    console.error('[BotAssets setup]', err.message);
    res.status(500).json({ error: 'Asset tracker is not ready' });
  }
});

const requireAgent = () => { if (!C.isEnabled('ASSET_AGENT_ENABLED')) throw new AssetError(404, 'The asset agent is not enabled'); };

// Who a Discord user is on the tracker: their roster entry, and what they may do.
async function discordIdentity(prisma, discordUserId) {
  const devs = await q.listDevs(prisma);
  const dev = devs.find(d => d.discordUserId && d.discordUserId === String(discordUserId)) || null;
  if (!dev) return { dev: null, access: perms.accessFor({}) };
  let role = '';
  if (dev.userId) role = (await prisma.$queryRawUnsafe(`SELECT role FROM "User" WHERE id = $1`, dev.userId))[0]?.role || '';
  const updates = await prisma.$queryRawUnsafe(`SELECT id, "leadDevId" FROM "AssetUpdate" WHERE "leadDevId" IS NOT NULL`);
  return { dev, access: perms.accessFor({ role, dev, updates }) };
}

// ── agent ────────────────────────────────────────────────────────────────────

// The bot refreshes this every couple of minutes to know which channels to read.
router.get('/agent/config', h(async req => ({
  enabled: C.isEnabled('ASSET_AGENT_ENABLED'),
  channelIds: C.isEnabled('ASSET_AGENT_ENABLED') ? [...await pipeline.allowedChannelIds(req.prisma)] : [],
  selfTestToken: C.isEnabled('ASSET_AGENT_ENABLED') ? await pipeline.selfTestToken(req.prisma) : null,
  assistant: C.isEnabled('ASSET_AGENT_ENABLED') ? await assistant.getSettings(req.prisma) : { enabled: false, prefix: '--', admins: [], channels: [] },
  payouts: C.isEnabled('ASSET_AGENT_ENABLED') ? await payouts.getSettings(req.prisma) : { enabled: false, adminChannelId: '', managerRoleId: '' },
})));

// ── payout requests ──────────────────────────────────────────────────────────

// A message in a dev's Payments post. Says what the bot should do with it.
router.post('/payout-request', h(async req => {
  requireAgent();
  const message = req.body.message || {};
  if (!message.id || !message.channelId || !message.authorDiscordId) throw new AssetError(400, 'Incomplete message');
  return payouts.handleRequest(req.prisma, message);
}));

router.post('/payouts/:id/posted', h(async req => {
  await payouts.markPosted(req.prisma, req.params.id, req.body || {});
}));

// Paid out / Decline in the admins' channel. Approved accounts and server administrators only.
router.post('/payouts/:id/resolve', h(async req => {
  requireAgent();
  const approved = (await assistant.getSettings(req.prisma)).admins.some(a => a.id === String(req.body.discordUserId));
  if (!approved && req.body.isAdministrator !== true) throw new AssetError(403, 'Only approved admins can mark payouts.');
  return payouts.resolve(req.prisma, req.params.id, {
    decision: req.body.decision, actorName: req.body.actorName, reason: req.body.reason, via: 'discord',
  });
}));

// The assistant: an approved person said something to the bot. Returns the reply to post.
router.post('/assistant', h(async req => {
  requireAgent();
  const message = req.body.message || {};
  if (!message.id || !message.channelId || !message.authorDiscordId) throw new AssetError(400, 'Incomplete message');
  const result = await assistant.respond(req.prisma, { message, history: Array.isArray(req.body.history) ? req.body.history : [] });
  if (result.denied) throw new AssetError(403, 'Not an approved account');
  return result;
}));

// Self-test: what would the agent propose for these messages? Stores nothing.
router.post('/agent/dry-run', h(async req => {
  requireAgent();
  const messages = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(0, 25)
    .filter(m => m && m.id && m.channelId && m.authorDiscordId && String(m.content || '').trim())
    .map(m => ({ ...m, content: String(m.content).slice(0, 2000), attachments: [] }));
  if (!messages.length) return { relevant: false, proposals: [], dropped: [], costUsd: 0, empty: true };
  return pipeline.dryRun(req.prisma, messages);
}));

router.post('/messages', h(async req => {
  requireAgent();
  return { stored: await pipeline.ingestMessages(req.prisma, req.body.messages) };
}));

router.post('/agent/tick', h(async req => {
  requireAgent();
  return pipeline.tick(req.prisma);
}));

router.post('/suggestions/:id/posted', h(async req => {
  await req.prisma.$executeRawUnsafe(
    `UPDATE "AssetAgentSuggestion" SET "discordChannelId" = $1, "discordMessageId" = $2 WHERE id = $3`,
    String(req.body.channelId || ''), String(req.body.messageId || ''), req.params.id);
}));

// Accept / Reject button in the review channel. Only leads and managers.
router.post('/suggestions/:id/resolve', h(async req => {
  requireAgent();
  const decision = req.body.decision === 'reject' ? 'reject' : 'accept';
  const suggestion = await suggestions.getSuggestion(req.prisma, req.params.id);
  if (!suggestion) throw new AssetError(404, 'Suggestion not found');
  // An approved assistant account can approve without being on the roster.
  const approved = (await assistant.getSettings(req.prisma)).admins.find(a => a.id === String(req.body.discordUserId));
  if (approved) {
    return suggestions.resolveSuggestion(req.prisma, suggestion.id, {
      decision, via: 'discord', actor: { userId: null, name: approved.label || req.body.discordUserName || 'Admin' },
    });
  }
  const { dev, access } = await discordIdentity(req.prisma, req.body.discordUserId);
  if (!dev) throw new AssetError(403, 'You are not on the asset roster, so you cannot review suggestions.');
  if (!perms.canResolveSuggestion(access, suggestion.updateId)) throw new AssetError(403, 'Only leads and managers can accept or reject suggestions.');
  return suggestions.resolveSuggestion(req.prisma, suggestion.id, {
    decision, via: 'discord', actor: { userId: dev.userId || null, name: dev.name },
  });
}));

// ── availability ─────────────────────────────────────────────────────────────

// Who is free to take work. The bot shows this on each dev's forum post.
// "Tasked" means at least one open task in an update that is still live.
router.get('/dev-status', h(async req => ({
  devs: (await q.listDevs(req.prisma)).filter(d => d.status === 'Active').map(d => ({
    id: d.id, name: d.name, discordUserId: d.discordUserId, discordThreadId: d.discordThreadId || null,
    openTasks: d.openTasks, blockedTasks: d.blockedTasks, available: d.openTasks === 0,
  })),
})));

// ── /assets slash command ────────────────────────────────────────────────────

router.get('/update', h(async req => {
  const updates = await q.listUpdates(req.prisma);
  const wanted = req.query.number !== undefined && req.query.number !== ''
    ? updates.find(u => u.number === Number(req.query.number))
    : updates.find(u => u.status === 'In Development') || updates.find(u => u.status === 'Testing') || updates[0];
  if (!wanted) throw new AssetError(404, req.query.number ? `There is no update #${req.query.number}.` : 'There are no updates yet.');
  const overview = await q.getUpdateOverview(req.prisma, wanted.id);
  return {
    update: overview.update,
    disciplines: overview.disciplines,
    attention: Object.fromEntries(Object.entries(overview.attention).map(([k, v]) => [k, v.length])),
  };
}));

router.get('/mine', h(async req => {
  const { dev } = await discordIdentity(req.prisma, req.query.discordUserId);
  if (!dev) throw new AssetError(404, 'You are not on the asset roster yet. Ask a lead to add your Discord profile link to your roster entry.');
  const tasks = await q.listTasksDetailed(req.prisma, { assigneeDevId: dev.id, openOnly: true });
  return { dev: { name: dev.name, openTasks: dev.openTasks, doneTasks: dev.doneTasks }, tasks: tasks.slice(0, 40), total: tasks.length };
}));

router.get('/item', h(async req => {
  const name = String(req.query.name || '').trim().toLowerCase();
  if (!name) throw new AssetError(400, 'Give an item name.');
  const items = await q.listItems(req.prisma, {});
  const match = items.find(i => i.internalName.toLowerCase() === name || (i.displayName || '').toLowerCase() === name)
    || items.find(i => i.internalName.toLowerCase().includes(name) || (i.displayName || '').toLowerCase().includes(name));
  if (!match) throw new AssetError(404, `No content item matches "${req.query.name}".`);
  const update = await q.getUpdate(req.prisma, match.updateId);
  return { item: match, update: { number: update.number, name: update.name }, tasks: await q.listTasksDetailed(req.prisma, { contentItemId: match.id }) };
}));

// A dev updating their own task from Discord.
router.post('/task-status', h(async req => {
  const status = C.TASK_STATUSES.find(s => s.toLowerCase() === String(req.body.status || '').toLowerCase());
  if (!status) throw new AssetError(400, `Status must be one of: ${C.TASK_STATUSES.join(', ')}.`);
  const ref = Number(String(req.body.ref ?? '').replace(/^#/, ''));
  if (!Number.isInteger(ref)) throw new AssetError(400, 'Give the task number, for example 412.');
  const [task] = await q.listTasksDetailed(req.prisma, { ref });
  if (!task) throw new AssetError(404, `There is no task #${ref}.`);
  const { dev, access } = await discordIdentity(req.prisma, req.body.discordUserId);
  if (!dev) throw new AssetError(403, 'You are not on the asset roster yet.');
  if (!perms.canEditTask(access, task, ['status'])) throw new AssetError(403, `Task #${task.ref} is not assigned to you.`);
  const reason = String(req.body.reason || '').trim();
  if (status === 'Blocked' && !reason) throw new AssetError(400, 'Add a reason when you mark a task blocked, so the lead knows what you are waiting on.');
  const ctx = { prisma: req.prisma, source: 'human', actor: { userId: dev.userId || null, name: `${dev.name} (Discord)` } };
  await service.updateTask(ctx, task.id, status === 'Blocked' ? { status, blockedReason: reason } : { status });
  const [updated] = await q.listTasksDetailed(req.prisma, { ref: task.ref });
  return { task: updated, previousStatus: task.status };
}));

module.exports = router;
