// End-to-end over HTTP: the real routers on a real port, with the in-process
// database. Covers the feature flags, role permissions as enforced by the
// API, and the bot-facing routes the Discord agent and /assets command use.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createTestDb, seedBasics } = require('./helpers');
const { setPrisma } = require('../../src/assets/db');
const q = require('../../src/assets/queries');

process.env.JWT_SECRET = 'test-secret';
process.env.BOT_SECRET = 'bot-secret';

const USERS = {
  admin: { id: 'u-admin', name: 'Admin', role: 'admin', pages: ['bugs'] },
  engineer: { id: 'u-eng', name: 'Engineer', role: 'engineer', pages: ['bugs', 'assets'] },
  ani: { id: 'u-ani', name: 'Ani Login', role: 'qa', pages: ['bugs', 'assets'] },
  viewer: { id: 'u-view', name: 'Viewer', role: 'reviewer', pages: ['bugs', 'assets'] },
  outsider: { id: 'u-out', name: 'No Access', role: 'qa', pages: ['bugs'] },
};

async function boot() {
  process.env.ASSETS_ENABLED = 'true';
  process.env.ASSET_AGENT_ENABLED = 'true';
  const prisma = await createTestDb();
  setPrisma(prisma);
  for (const u of Object.values(USERS)) {
    await prisma.$executeRawUnsafe(`INSERT INTO "User" ("id", "name", "role", "pageAccess") VALUES ($1, $2, $3, $4::text[])`, u.id, u.name, u.role, u.pages);
  }
  const seeded = await seedBasics(prisma);
  await prisma.$executeRawUnsafe(`UPDATE "AssetDev" SET "userId" = 'u-ani' WHERE id = $1`, seeded.ani.id);

  const app = express();
  app.use(express.json());
  app.use('/api/bot/assets', require('../../src/routes/bot-assets'));
  app.use('/api/assets', require('../../src/routes/assets'));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (who, method, path, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (who === 'bot') headers['x-bot-secret'] = 'bot-secret';
    else if (who) headers.Authorization = `Bearer ${jwt.sign({ id: USERS[who].id, name: USERS[who].name, role: USERS[who].role }, 'test-secret')}`;
    const prefix = who === 'bot' || path.startsWith('/bot') ? '/api/bot/assets' : '/api/assets';
    const res = await fetch(`${base}${prefix}${path.replace(/^\/bot/, '')}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const tasks = await q.listTasksDetailed(prisma, { contentItemId: seeded.aizen.id });
  return { prisma, call, ...seeded, tasks, close: () => server.close() };
}

test('feature flags: everything is 404 until ASSETS_ENABLED, and the agent routes need their own flag', async () => {
  const t = await boot();
  process.env.ASSETS_ENABLED = 'false';
  assert.equal((await t.call('admin', 'GET', '/bootstrap')).status, 404);
  assert.equal((await t.call('bot', 'GET', '/agent/config')).status, 404);
  process.env.ASSETS_ENABLED = 'true';
  assert.equal((await t.call('admin', 'GET', '/bootstrap')).status, 200);

  process.env.ASSET_AGENT_ENABLED = 'false';
  assert.deepEqual((await t.call('bot', 'GET', '/agent/config')).body, { enabled: false, channelIds: [], selfTestToken: null, assistant: { enabled: false, admins: [], channels: [] }, payouts: { enabled: false, adminChannelId: '', managerRoleId: '' } });
  assert.equal((await t.call('bot', 'POST', '/messages', { messages: [] })).status, 404);
  assert.equal((await t.call('bot', 'POST', '/agent/tick', {})).status, 404);
  assert.equal((await t.call('admin', 'GET', '/bootstrap')).body.flags.agentEnabled, false);
  t.close();
});

test('auth: no token, no page access, and a wrong bot secret are all turned away', async () => {
  const t = await boot();
  assert.equal((await t.call(null, 'GET', '/bootstrap')).status, 401);
  assert.equal((await t.call('outsider', 'GET', '/bootstrap')).status, 403);
  assert.equal((await t.call(null, 'GET', '/bot/agent/config')).status, 401);
  // Admins get in without the checkbox; others need it.
  assert.equal((await t.call('admin', 'GET', '/bootstrap')).body.access.level, 'admin');
  assert.equal((await t.call('engineer', 'GET', '/bootstrap')).body.access.level, 'manager');
  assert.equal((await t.call('ani', 'GET', '/bootstrap')).body.access.level, 'dev');
  assert.equal((await t.call('viewer', 'GET', '/bootstrap')).body.access.level, 'viewer');
  t.close();
});

test('role permissions are enforced by the API', async () => {
  const t = await boot();
  const [design, animation] = t.tasks;
  await t.call('engineer', 'PATCH', `/tasks/${animation.id}`, { assigneeDevId: t.ani.id });

  // viewer: read only
  assert.equal((await t.call('viewer', 'GET', `/tasks?updateId=${t.update.id}`)).body.length, 3);
  assert.equal((await t.call('viewer', 'PATCH', `/tasks/${animation.id}`, { status: 'Done' })).status, 403);
  // dev: own tasks, limited fields
  assert.equal((await t.call('ani', 'PATCH', `/tasks/${animation.id}`, { status: 'In Progress', notes: 'wip' })).body.status, 'In Progress');
  assert.equal((await t.call('ani', 'PATCH', `/tasks/${animation.id}`, { assigneeDevId: null })).status, 403);
  assert.equal((await t.call('ani', 'PATCH', `/tasks/${design.id}`, { status: 'Done' })).status, 403);
  assert.equal((await t.call('ani', 'POST', '/tasks/bulk', { ids: [animation.id, design.id], patch: { status: 'Done' } })).status, 403);
  assert.equal((await t.call('ani', 'POST', '/items', { updateId: t.update.id, contentTypeId: t.unit.id, internalName: 'X' })).status, 403);
  // manager: everything except templates and agent settings
  assert.equal((await t.call('engineer', 'POST', '/items', { updateId: t.update.id, contentTypeId: t.unit.id, internalName: 'Ichigo' })).status, 201);
  assert.equal((await t.call('engineer', 'POST', '/tasks/bulk', { ids: [animation.id, design.id], patch: { dueDate: '2026-12-01' } })).body.tasks.length, 2);
  assert.equal((await t.call('engineer', 'POST', '/templates', { contentTypeId: t.unit.id, discipline: 'QA', deliverable: 'QA pass' })).status, 403);
  assert.equal((await t.call('engineer', 'GET', '/agent/settings')).status, 403);
  // admin: templates and agent settings
  const created = await t.call('admin', 'POST', '/templates', { contentTypeId: t.unit.id, discipline: 'QA', deliverable: 'QA pass' });
  assert.equal(created.status, 201);
  assert.equal(created.body.tasksAdded, 2, 'backfilled onto Aizen and Ichigo');
  assert.equal((await t.call('admin', 'GET', '/agent/settings')).status, 200);
  // validation errors come back as 400 with a message
  const bad = await t.call('engineer', 'PATCH', `/tasks/${design.id}`, { status: 'Shipped' });
  assert.deepEqual([bad.status, bad.body.error], [400, 'Invalid status "Shipped"']);
  t.close();
});

test('saved views belong to the user who made them', async () => {
  const t = await boot();
  const view = (await t.call('engineer', 'POST', '/views', { name: 'Blocked VFX', config: { filters: { status: ['Blocked'] } } })).body;
  assert.equal((await t.call('engineer', 'GET', '/bootstrap')).body.views.length, 1);
  assert.equal((await t.call('ani', 'GET', '/bootstrap')).body.views.length, 0);
  assert.equal((await t.call('ani', 'PATCH', `/views/${view.id}`, { name: 'stolen' })).status, 404);
  await t.call('engineer', 'DELETE', `/views/${view.id}`);
  assert.equal((await t.call('engineer', 'GET', '/bootstrap')).body.views.length, 0);
  t.close();
});

test('agent over HTTP: allowlist, ingest, tick, then accept from the web and from Discord', async () => {
  const t = await boot();
  const [design, animation, vfx] = t.tasks;
  // Stand in for the two Claude calls.
  const model = require('../../src/assets/agent/model');
  const real = { filter: model.filter, extract: model.extract };
  const usage = { input_tokens: 100, output_tokens: 10 };
  model.filter = async () => ({ relevant: true, model: 'claude-haiku-4-5-20251001', usage });
  model.extract = async () => ({
    model: 'claude-sonnet-5-5', usage,
    actions: [vfx, animation].map(task => ({
      type: 'update_task_status', task_ref: String(task.ref), status: 'Review', assignee: '', due_date: '', note: '', blocker_reason: '',
      item_internal_name: '', display_name: '', content_type: '', update_number: '', confidence: 0.9, reason: 'said so', evidence: ['m1'],
    })),
  });

  // Admin allowlists a channel; a bad id is rejected with a helpful message.
  assert.equal((await t.call('admin', 'POST', '/agent/channels', { channelId: 'general' })).status, 400);
  assert.equal((await t.call('admin', 'POST', '/agent/channels', { channelId: '500000000000000001', label: 'dev-chat' })).status, 201);
  assert.deepEqual((await t.call('bot', 'GET', '/agent/config')).body, { enabled: true, channelIds: ['500000000000000001'], selfTestToken: null, assistant: { enabled: true, admins: [], channels: [] }, payouts: { enabled: true, adminChannelId: '', managerRoleId: '' } });

  const message = (id, channelId) => ({ id, channelId, guildId: '900', authorDiscordId: '222222222222222222', authorName: 'ani', content: 'vfx and anims done', postedAt: new Date(Date.now() - 10 * 60000).toISOString() });
  const ingest = await t.call('bot', 'POST', '/messages', { messages: [message('700000000000000001', '500000000000000001'), message('700000000000000002', '599999999999999999')] });
  assert.equal(ingest.body.stored, 1, 'the message from a channel off the allowlist is discarded');

  const tick = await t.call('bot', 'POST', '/agent/tick', {});
  assert.equal(tick.body.state, 'ok');
  assert.equal(tick.body.toPost.length, 2);
  const [first, second] = tick.body.toPost;
  await t.call('bot', 'POST', `/suggestions/${first.id}/posted`, { channelId: '1', messageId: '2' });

  // Web inbox: viewers and plain devs cannot resolve; a manager can.
  const inbox = await t.call('ani', 'GET', '/suggestions');
  assert.equal(inbox.body.pending, 2);
  assert.equal(inbox.body.suggestions[0].canResolve, false);
  assert.equal((await t.call('ani', 'POST', `/suggestions/${first.id}/accept`, {})).status, 403);
  const accepted = await t.call('engineer', 'POST', `/suggestions/${first.id}/accept`, {});
  assert.deepEqual([accepted.status, accepted.body.status, accepted.body.resolvedVia], [200, 'accepted', 'web']);
  assert.equal((await t.call('engineer', 'POST', `/suggestions/${first.id}/reject`, {})).status, 409);

  // Discord button: a dev is refused, someone off the roster is refused, a Manager-discipline dev is allowed.
  const asAni = await t.call('bot', 'POST', `/suggestions/${second.id}/resolve`, { decision: 'accept', discordUserId: '222222222222222222' });
  assert.deepEqual([asAni.status, asAni.body.error], [403, 'Only leads and managers can accept or reject suggestions.']);
  assert.equal((await t.call('bot', 'POST', `/suggestions/${second.id}/resolve`, { decision: 'accept', discordUserId: '123456789012345678' })).status, 403);
  const asBee = await t.call('bot', 'POST', `/suggestions/${second.id}/resolve`, { decision: 'accept', discordUserId: '111111111111111111' });
  assert.deepEqual([asBee.status, asBee.body.status, asBee.body.resolvedVia, asBee.body.resolvedByName], [200, 'accepted', 'discord', 'MrBee']);

  // Both changes landed, attributed to the agent and the person who accepted.
  const after = await q.listTasks(t.prisma, { ids: [vfx.id, animation.id] });
  assert.deepEqual(after.map(x => x.status), ['Review', 'Review']);
  const log = await q.listActivity(t.prisma, { taskId: animation.id });
  assert.deepEqual([log[0].source, log[0].actorName], ['agent', 'MrBee']);

  const settings = await t.call('admin', 'GET', '/agent/settings');
  assert.equal(settings.body.usage.daily[0].extractCalls, 1);
  assert.equal(settings.body.settings.autoApply.update_task_status.enabled, false);
  assert.deepEqual(settings.body.neverAutoApply, ['create_content_item', 'flag_unknown']);
  const saved = await t.call('admin', 'PUT', '/agent/settings', { dailyBudgetUsd: 5, autoApply: { add_task_note: { enabled: true, threshold: 0.95 } } });
  assert.deepEqual([saved.body.settings.dailyBudgetUsd, saved.body.settings.autoApply.add_task_note], [5, { enabled: true, threshold: 0.95 }]);

  Object.assign(model, real);
  void design;
  t.close();
});

test('/assets slash command data: update summary, my tasks, item checklist, and updating my own task', async () => {
  const t = await boot();
  const [design, animation] = t.tasks;
  await t.call('engineer', 'PATCH', `/tasks/${animation.id}`, { assigneeDevId: t.ani.id, dueDate: '2026-11-01' });

  const summary = await t.call('bot', 'GET', '/update');
  assert.equal(summary.body.update.number, 4, 'defaults to the update in development');
  assert.equal(summary.body.attention.noOwner, 1);
  assert.equal((await t.call('bot', 'GET', '/update?number=99')).status, 404);

  const mine = await t.call('bot', 'GET', '/mine?discordUserId=222222222222222222');
  assert.deepEqual(mine.body.tasks.map(x => x.ref), [animation.ref]);
  assert.equal((await t.call('bot', 'GET', '/mine?discordUserId=1')).status, 404);

  const item = await t.call('bot', 'GET', '/item?name=aiz');
  assert.equal(item.body.item.internalName, 'Aizen');
  assert.equal(item.body.tasks.length, 3);

  const ok = await t.call('bot', 'POST', '/task-status', { ref: animation.ref, status: 'review', discordUserId: '222222222222222222' });
  assert.deepEqual([ok.status, ok.body.previousStatus, ok.body.task.status], [200, 'Not Started', 'Review']);
  const notMine = await t.call('bot', 'POST', '/task-status', { ref: design.ref, status: 'Done', discordUserId: '222222222222222222' });
  assert.deepEqual([notMine.status, notMine.body.error], [403, `Task #${design.ref} is not assigned to you.`]);
  assert.equal((await t.call('bot', 'POST', '/task-status', { ref: animation.ref, status: 'Shipped', discordUserId: '222222222222222222' })).status, 400);
  // A Manager-discipline dev can update anyone's task from Discord.
  assert.equal((await t.call('bot', 'POST', '/task-status', { ref: design.ref, status: 'Done', discordUserId: '111111111111111111' })).status, 200);
  const [log] = await q.listActivity(t.prisma, { taskId: animation.id });
  assert.deepEqual([log.source, log.actorName], ['human', 'Ani (Discord)']);
  t.close();
});
