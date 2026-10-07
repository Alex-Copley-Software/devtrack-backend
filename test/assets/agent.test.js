const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, seedBasics, ctxFor } = require('./helpers');
const service = require('../../src/assets/service');
const q = require('../../src/assets/queries');
const context = require('../../src/assets/agent/context');
const { validateActions } = require('../../src/assets/agent/validate');
const pipeline = require('../../src/assets/agent/pipeline');
const suggestions = require('../../src/assets/agent/suggestions');
const settingsStore = require('../../src/assets/agent/settings');

process.env.ASSET_AGENT_ENABLED = 'true';

const CHANNEL = '500000000000000001';
const BEE = '111111111111111111';
const ANI = '222222222222222222';
let nextMessageId = 700000000000000000n;

// A complete action as the model would return it (every field present).
const action = fields => ({
  type: 'update_task_status', task_ref: '', status: '', assignee: '', due_date: '', note: '', blocker_reason: '',
  item_internal_name: '', display_name: '', content_type: '', update_number: '', confidence: 0.9, reason: 'because', evidence: ['m1'], ...fields,
});

// Stands in for the two Claude calls.
function fakeModel({ relevant = true, actions = [] } = {}) {
  const calls = { filter: 0, extract: 0, lastExtract: null };
  return {
    calls,
    filter: async () => { calls.filter++; return { relevant, model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 2000, output_tokens: 4 } }; },
    extract: async input => {
      calls.extract++; calls.lastExtract = input;
      return { actions: typeof actions === 'function' ? actions(input) : actions, model: 'claude-sonnet-5-5', usage: { input_tokens: 10000, output_tokens: 1000 } };
    },
  };
}

async function setup() {
  const prisma = await createTestDb();
  const seeded = await seedBasics(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO "AssetAgentChannel" ("channelId", "label") VALUES ($1, 'dev-chat')`, CHANNEL);
  const tasks = await q.listTasksDetailed(prisma, { contentItemId: seeded.aizen.id });
  const byDiscipline = Object.fromEntries(tasks.map(t => [t.discipline, t]));
  return { prisma, ...seeded, tasks, byDiscipline };
}

// minutesAgo defaults to 10 so the conversation counts as "gone quiet".
const say = (authorDiscordId, content, { minutesAgo = 10, channelId = CHANNEL, parentChannelId, categoryId } = {}) => ({
  id: String(nextMessageId++), channelId, parentChannelId, categoryId, guildId: '900', authorDiscordId, authorName: 'someone', content,
  postedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(),
});

test('validation drops anything that does not resolve against the tracker and the enums', async () => {
  const { prisma, byDiscipline } = await setup();
  const snapshot = await context.buildSnapshot(prisma);
  const labels = new Map([['m1', {}], ['m2', {}]]);
  const vfx = String(byDiscipline.VFX.ref);
  const { accepted, dropped } = validateActions([
    action({ task_ref: vfx, status: 'review' }),                                   // ok, case-insensitive
    action({ task_ref: `#${vfx}`, status: 'Review' }),                             // duplicate within the batch
    action({ task_ref: '99999', status: 'Done' }),                                 // unknown task ref
    action({ task_ref: vfx, status: 'Shipped' }),                                  // status outside the enum
    action({ task_ref: vfx, status: 'Not Started' }),                              // already true
    action({ type: 'assign_task', task_ref: vfx, assignee: 'Nobody' }),            // not on the roster
    action({ type: 'assign_task', task_ref: vfx, assignee: 'ani' }),               // ok
    action({ type: 'set_due_date', task_ref: vfx, due_date: 'next friday' }),      // not a date
    action({ type: 'set_due_date', task_ref: vfx, due_date: '2026-11-20' }),       // ok
    action({ type: 'mark_blocked', task_ref: vfx, blocker_reason: '' }),           // no reason
    action({ type: 'add_task_note', task_ref: vfx, note: 'rbxassetid://42' }),     // ok
    action({ type: 'update_task_status', task_ref: vfx, status: 'Done', evidence: ['m9'] }), // evidence not in the batch
    action({ type: 'update_task_status', task_ref: vfx, status: 'Done', confidence: 'high' }), // bad confidence
    action({ type: 'delete_everything', task_ref: vfx }),                          // unknown type
    action({ type: 'create_content_item', item_internal_name: 'Ichigo', content_type: 'unit', update_number: '4' }), // ok
    action({ type: 'create_content_item', item_internal_name: 'AIZEN', content_type: 'Unit', update_number: '4' }),  // already exists
    action({ type: 'create_content_item', item_internal_name: 'Car', content_type: 'Vehicle', update_number: '4' }), // unknown type
    action({ type: 'create_content_item', item_internal_name: 'Gojo', content_type: 'Unit', update_number: '77' }),  // unknown update
    action({ type: 'flag_unknown', note: 'someone mentioned a new relic system' }),                                  // ok
    'not even an object',
  ], { snapshot, labels });

  assert.deepEqual(accepted.map(a => a.type), ['update_task_status', 'assign_task', 'set_due_date', 'add_task_note', 'create_content_item', 'flag_unknown']);
  assert.equal(dropped.length, 14);
  const status = accepted[0];
  assert.deepEqual(status.payload, { status: 'Review' });
  assert.deepEqual([status.before, status.after], [{ status: 'Not Started' }, { status: 'Review' }]);
  assert.equal(status.summary, 'Aizen · Ability VFX: Not Started → Review');
  assert.equal(status.taskId, byDiscipline.VFX.id);
  assert.equal(accepted[1].after.assignee, 'Ani');
  assert.equal(accepted[4].after.contentType, 'Unit');
});

test('confidence is clamped to 0..1', async () => {
  const { prisma, byDiscipline } = await setup();
  const snapshot = await context.buildSnapshot(prisma);
  const { accepted } = validateActions([action({ task_ref: String(byDiscipline.VFX.ref), status: 'Done', confidence: 7 })], { snapshot, labels: new Map([['m1', {}]]) });
  assert.equal(accepted[0].confidence, 1);
});

test('only allowlisted channels (or threads under them) are stored', async () => {
  const { prisma } = await setup();
  const stored = await pipeline.ingestMessages(prisma, [
    say(ANI, 'in the allowlisted channel'),
    say(ANI, 'in a thread under it', { channelId: '500000000000000099', parentChannelId: CHANNEL }),
    say(ANI, 'a forum post in an allowlisted category', { channelId: '500000000000000098', parentChannelId: '500000000000000097', categoryId: CHANNEL }),
    say(ANI, 'somewhere else entirely', { channelId: '500000000000000002', categoryId: '500000000000000003' }),
    say(ANI, '   '),
  ]);
  assert.equal(stored, 3);
  const again = say(ANI, 'same id twice');
  assert.equal(await pipeline.ingestMessages(prisma, [again, again]), 1);
});

test('a conversation is batched after going quiet, or once enough messages pile up', async () => {
  const { prisma } = await setup();
  await pipeline.ingestMessages(prisma, [say(ANI, 'fresh', { minutesAgo: 0 }), say(BEE, 'also fresh', { minutesAgo: 1 })]);
  assert.equal((await pipeline.claimBatches(prisma, { quietMinutes: 3, maxBatchMessages: 25 })).length, 0, 'still active: not claimed');

  const many = Array.from({ length: 30 }, (_, i) => say(ANI, `message ${i}`, { minutesAgo: 0 }));
  await pipeline.ingestMessages(prisma, many);
  const [batch] = await pipeline.claimBatches(prisma, { quietMinutes: 3, maxBatchMessages: 25 });
  assert.equal(batch.messages.length, 25, 'capped at the batch size');
  assert.ok(new Date(batch.messages[0].postedAt) <= new Date(batch.messages[24].postedAt), 'oldest first');
  // The 7 left over are below the cap and not quiet yet, and nothing is claimed twice.
  assert.equal((await pipeline.claimBatches(prisma, { quietMinutes: 3, maxBatchMessages: 25 })).length, 0);
});

test('the filter pass skips off-topic chatter without running extraction', async () => {
  const { prisma } = await setup();
  await pipeline.ingestMessages(prisma, [say(ANI, 'anyone want pizza')]);
  const model = fakeModel({ relevant: false });
  const result = await pipeline.tick(prisma, { model });
  assert.equal(model.calls.filter, 1);
  assert.equal(model.calls.extract, 0);
  assert.equal(result.processed[0].relevant, false);
  const [batch] = await prisma.$queryRawUnsafe(`SELECT status, relevant FROM "AssetAgentBatch"`);
  assert.deepEqual([batch.status, batch.relevant], ['filtered_out', false]);
});

test('extraction sees the tracker state and authors resolved to roster devs; suggestions are stored pending', async () => {
  const { prisma, byDiscipline } = await setup();
  await pipeline.ingestMessages(prisma, [say(ANI, 'aizen vfx is done, sending for review'), say(BEE, 'nice')]);
  const model = fakeModel({ actions: [action({ task_ref: String(byDiscipline.VFX.ref), status: 'Review', evidence: ['m1'] })] });
  const result = await pipeline.tick(prisma, { model });

  assert.match(model.calls.lastExtract.trackerState, /ITEM "Aizen" \(display name "Mythic"\) \| Unit \| update 4/);
  assert.match(model.calls.lastExtract.trackerState, new RegExp(`#${byDiscipline.VFX.ref} \\| VFX \\| Ability VFX \\| Not Started \\| unassigned`));
  assert.match(model.calls.lastExtract.batchText, /\[m1\] .* \| Ani \(Animation, VFX\): aizen vfx is done/);
  assert.match(model.calls.lastExtract.batchText, /\[m2\] .* \| MrBee \(Manager\): nice/);

  assert.equal(result.processed[0].suggestions, 1);
  const [s] = await suggestions.listSuggestions(prisma, { status: 'pending' });
  assert.equal(s.type, 'update_task_status');
  assert.equal(s.status, 'pending');
  assert.equal(s.evidence[0].url, `https://discord.com/channels/900/${CHANNEL}/${s.evidence[0].messageId}`);
  assert.equal(result.toPost.length, 1, 'handed to the bot to post in the review channel');
  assert.equal((await pipeline.tick(prisma, { model })).toPost.length, 0, 'and only once');
  // Nothing was applied: the task is unchanged until someone accepts.
  assert.equal((await q.listTasks(prisma, { ids: [byDiscipline.VFX.id] }))[0].status, 'Not Started');
});

test('the same change is not proposed twice while pending, nor right after being rejected', async () => {
  const { prisma, byDiscipline } = await setup();
  const model = fakeModel({ actions: [action({ task_ref: String(byDiscipline.VFX.ref), status: 'Review' })] });
  await pipeline.ingestMessages(prisma, [say(ANI, 'vfx done')]);
  await pipeline.tick(prisma, { model });
  await pipeline.ingestMessages(prisma, [say(ANI, 'like i said, vfx done')]);
  await pipeline.tick(prisma, { model });
  assert.equal(await suggestions.countPending(prisma), 1);

  const [s] = await suggestions.listSuggestions(prisma, { status: 'pending' });
  await suggestions.resolveSuggestion(prisma, s.id, { decision: 'reject', actor: { userId: 'u', name: 'Lead' } });
  await pipeline.ingestMessages(prisma, [say(ANI, 'vfx done!!')]);
  await pipeline.tick(prisma, { model });
  assert.equal(await suggestions.countPending(prisma), 0);
});

test('a field a person edited after the message was posted is not overwritten', async () => {
  const { prisma, ctx, byDiscipline } = await setup();
  await pipeline.ingestMessages(prisma, [say(ANI, 'vfx is in review now', { minutesAgo: 30 })]);
  // A person sets the status after that message...
  await service.updateTask(ctx, byDiscipline.VFX.id, { status: 'In Progress' });
  const model = fakeModel({ actions: [
    action({ task_ref: String(byDiscipline.VFX.ref), status: 'Review' }),
    action({ type: 'add_task_note', task_ref: String(byDiscipline.VFX.ref), note: 'rbxassetid://77' }),
  ] });
  await pipeline.tick(prisma, { model });
  // ...so the status change is withheld, but the note (which overwrites nothing) still goes through.
  assert.deepEqual((await suggestions.listSuggestions(prisma, { status: 'pending' })).map(s => s.type), ['add_task_note']);
});

test('an edit made before the message does not block the suggestion', async () => {
  const { prisma, ctx, byDiscipline } = await setup();
  await service.updateTask(ctx, byDiscipline.VFX.id, { status: 'In Progress' });
  await prisma.$executeRawUnsafe(`UPDATE "AssetActivity" SET "createdAt" = "createdAt" - INTERVAL '1 hour'`);
  await pipeline.ingestMessages(prisma, [say(ANI, 'vfx done')]);
  await pipeline.tick(prisma, { model: fakeModel({ actions: [action({ task_ref: String(byDiscipline.VFX.ref), status: 'Review' })] }) });
  assert.equal(await suggestions.countPending(prisma), 1);
});

test('accepting applies the change through the normal service, logged as agent with the accepting user and the evidence', async () => {
  const { prisma, byDiscipline } = await setup();
  await pipeline.ingestMessages(prisma, [say(ANI, 'vfx done')]);
  await pipeline.tick(prisma, { model: fakeModel({ actions: [action({ task_ref: String(byDiscipline.VFX.ref), status: 'Review' })] }) });
  const [s] = await suggestions.listSuggestions(prisma, { status: 'pending' });

  const resolved = await suggestions.resolveSuggestion(prisma, s.id, { decision: 'accept', via: 'web', actor: { userId: 'user-9', name: 'Lead Lee' } });
  assert.equal(resolved.status, 'accepted');
  assert.equal(resolved.resolvedByName, 'Lead Lee');
  assert.equal((await q.listTasks(prisma, { ids: [byDiscipline.VFX.id] }))[0].status, 'Review');

  const [log] = await q.listActivity(prisma, { taskId: byDiscipline.VFX.id });
  assert.equal(log.source, 'agent');
  assert.equal(log.actorName, 'Lead Lee');
  assert.equal(log.suggestionId, s.id);
  assert.match(log.evidence[0].url, /discord\.com\/channels/);

  await assert.rejects(
    suggestions.resolveSuggestion(prisma, s.id, { decision: 'reject', actor: { userId: 'x', name: 'Other' } }),
    err => err.status === 409 && /Already accepted by Lead Lee/.test(err.message));
});

test('edit then accept applies the edited value and is recorded as edited', async () => {
  const { prisma, byDiscipline } = await setup();
  await pipeline.ingestMessages(prisma, [say(ANI, 'vfx done')]);
  await pipeline.tick(prisma, { model: fakeModel({ actions: [action({ task_ref: String(byDiscipline.VFX.ref), status: 'Review' })] }) });
  const [s] = await suggestions.listSuggestions(prisma, { status: 'pending' });
  const edits = suggestions.pickEdits(s.type, { status: 'Done', assigneeDevId: 'ignored-for-this-type' });
  assert.deepEqual(edits, { status: 'Done' });
  const resolved = await suggestions.resolveSuggestion(prisma, s.id, { decision: 'accept', actor: { userId: 'u', name: 'Lead' }, edits });
  assert.equal(resolved.status, 'edited');
  assert.deepEqual(resolved.appliedPayload, { status: 'Done' });
  assert.equal((await q.listTasks(prisma, { ids: [byDiscipline.VFX.id] }))[0].status, 'Done');
});

test('a suggestion whose change can no longer be applied goes back to pending', async () => {
  const { prisma, ctx, aizen } = await setup();
  await pipeline.ingestMessages(prisma, [say(BEE, 'we are adding ichigo as a unit')]);
  await pipeline.tick(prisma, { model: fakeModel({ actions: [action({ type: 'create_content_item', item_internal_name: 'Ichigo', content_type: 'Unit', update_number: '4' })] }) });
  const [s] = await suggestions.listSuggestions(prisma, { status: 'pending' });
  // Someone creates it by hand first.
  await service.createContentItem(ctx, { updateId: aizen.updateId, contentTypeId: aizen.contentTypeId, internalName: 'Ichigo' });
  await assert.rejects(suggestions.resolveSuggestion(prisma, s.id, { decision: 'accept', actor: { userId: 'u', name: 'Lead' } }), err => err.status === 409);
  assert.equal((await suggestions.getSuggestion(prisma, s.id)).status, 'pending');
});

test('mark_blocked sets the status and records the reason; create_content_item spawns template tasks', async () => {
  const { prisma, byDiscipline, update } = await setup();
  await pipeline.ingestMessages(prisma, [say(ANI, 'blocked on the brief, also we are adding ichigo')]);
  await pipeline.tick(prisma, { model: fakeModel({ actions: [
    action({ type: 'mark_blocked', task_ref: String(byDiscipline.Animation.ref), blocker_reason: 'waiting on the design brief' }),
    action({ type: 'create_content_item', item_internal_name: 'Ichigo', display_name: 'Legendary', content_type: 'Unit', update_number: '4' }),
  ] }) });
  for (const s of await suggestions.listSuggestions(prisma, { status: 'pending' })) {
    await suggestions.resolveSuggestion(prisma, s.id, { decision: 'accept', actor: { userId: 'u', name: 'Lead' } });
  }
  const [anim] = await q.listTasks(prisma, { ids: [byDiscipline.Animation.id] });
  assert.equal(anim.status, 'Blocked');
  assert.equal(anim.blockedReason, 'waiting on the design brief');
  const ichigo = (await q.listItems(prisma, { updateId: update.id })).find(i => i.internalName === 'Ichigo');
  assert.equal(ichigo.displayName, 'Legendary');
  assert.equal(ichigo.taskCount, 3);
});

test('auto-apply is off by default, respects the per-type threshold, and never creates content', async () => {
  const { prisma, byDiscipline } = await setup();
  const proposals = [
    action({ task_ref: String(byDiscipline.VFX.ref), status: 'Review', confidence: 0.95 }),
    action({ type: 'set_due_date', task_ref: String(byDiscipline.VFX.ref), due_date: '2026-12-01', confidence: 0.95 }),
    action({ task_ref: String(byDiscipline.Design.ref), status: 'Review', confidence: 0.6 }),
    action({ type: 'create_content_item', item_internal_name: 'Ichigo', content_type: 'Unit', update_number: '4', confidence: 1 }),
  ];
  assert.equal((await settingsStore.getSettings(prisma)).autoApply.update_task_status.enabled, false);

  // Even a saved setting cannot switch auto-apply on for creating items.
  const saved = await settingsStore.saveSettings(prisma, { autoApply: { update_task_status: { enabled: true, threshold: 0.9 }, create_content_item: { enabled: true, threshold: 0.5 } } });
  assert.equal(saved.autoApply.create_content_item, undefined);
  assert.equal(suggestions.shouldAutoApply({ autoApply: { create_content_item: { enabled: true, threshold: 0 } } }, { type: 'create_content_item', confidence: 1 }), false);

  await pipeline.ingestMessages(prisma, [say(ANI, 'vfx done, design nearly, due dec 1, adding ichigo')]);
  await pipeline.tick(prisma, { model: fakeModel({ actions: proposals }) });

  const resolved = await suggestions.listSuggestions(prisma, { status: 'resolved' });
  assert.deepEqual(resolved.map(s => [s.type, s.resolvedVia, s.resolvedByName]), [['update_task_status', 'auto', 'Auto-apply']]);
  assert.equal((await q.listTasks(prisma, { ids: [byDiscipline.VFX.id] }))[0].status, 'Review');
  // Below threshold, a type left off, and content creation all wait for a person.
  assert.deepEqual((await suggestions.listSuggestions(prisma, { status: 'pending' })).map(s => s.type).sort(), ['create_content_item', 'set_due_date', 'update_task_status']);
});

test('usage is logged with cost per call, and the daily budget pauses the agent', async () => {
  const { prisma, byDiscipline } = await setup();
  assert.equal(settingsStore.costOf('claude-haiku-4-5-20251001', { input_tokens: 2000, output_tokens: 4 }), (2000 * 1 + 4 * 5) / 1e6);
  assert.equal(settingsStore.costOf('claude-sonnet-5-5', { input_tokens: 1000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000, output_tokens: 100 }),
    ((1000 + 1250 + 100) * 2 + 100 * 10) / 1e6);

  await settingsStore.saveSettings(prisma, { dailyBudgetUsd: 0.03 });
  const model = fakeModel({ actions: [action({ task_ref: String(byDiscipline.VFX.ref), status: 'Review' })] });
  await pipeline.ingestMessages(prisma, [say(ANI, 'vfx done')]);
  const first = await pipeline.tick(prisma, { model });
  // filter 0.00202 + extract (10000*2 + 1000*10)/1e6 = 0.03 -> over the 0.03 cap
  assert.equal(first.state, 'over_budget');
  const usage = await settingsStore.usageSummary(prisma);
  assert.equal(usage.overBudget, true);
  assert.ok(Math.abs(usage.today - 0.03202) < 1e-9);
  assert.deepEqual([usage.daily[0].filterCalls, usage.daily[0].extractCalls], [1, 1]);

  await pipeline.ingestMessages(prisma, [say(BEE, 'more asset talk')]);
  const second = await pipeline.tick(prisma, { model });
  assert.equal(second.state, 'over_budget');
  assert.equal(second.processed.length, 0);
  assert.equal(model.calls.filter, 1, 'no model calls while over budget');
  const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetAgentMessage" WHERE "batchId" IS NULL`);
  assert.equal(n, 1, 'the message waits for the next budget day');
});

test('a failed model call marks the batch failed and does not take the agent down', async () => {
  const { prisma } = await setup();
  await pipeline.ingestMessages(prisma, [say(ANI, 'vfx done')]);
  const model = { filter: async () => { throw new Error('upstream 529'); }, extract: async () => ({}) };
  const result = await pipeline.tick(prisma, { model });
  assert.equal(result.state, 'ok');
  assert.equal(result.processed[0].error, 'upstream 529');
  const [batch] = await prisma.$queryRawUnsafe(`SELECT status, error FROM "AssetAgentBatch"`);
  assert.deepEqual([batch.status, batch.error], ['failed', 'upstream 529']);
});

test('paused and disabled states make no model calls; old messages are pruned', async () => {
  const { prisma } = await setup();
  await pipeline.ingestMessages(prisma, [say(ANI, 'ancient history', { minutesAgo: 60 * 24 * 45 }), say(ANI, 'vfx done')]);
  await settingsStore.saveSettings(prisma, { paused: true });
  const model = fakeModel();
  assert.equal((await pipeline.tick(prisma, { model })).state, 'paused');
  assert.equal(model.calls.filter, 0);
  const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetAgentMessage"`);
  assert.equal(n, 1, 'the 45-day-old message is past the 30-day retention');

  process.env.ASSET_AGENT_ENABLED = 'false';
  assert.equal((await pipeline.tick(prisma, { model })).state, 'disabled');
  process.env.ASSET_AGENT_ENABLED = 'true';
});

test('the self-test dry run reports what would be proposed and stores nothing', async () => {
  const { prisma, byDiscipline } = await setup();
  const model = fakeModel({ actions: [action({ task_ref: String(byDiscipline.VFX.ref), status: 'Review', evidence: ['m1'] })] });
  const result = await pipeline.dryRun(prisma, [say(ANI, 'aizen vfx is done, sending for review')], { model });
  assert.equal(result.relevant, true);
  assert.deepEqual(result.proposals.map(p => p.summary), ['Aizen · Ability VFX: Not Started → Review']);
  const count = async table => (await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${table}"`))[0].n;
  assert.deepEqual([await count('AssetAgentSuggestion'), await count('AssetAgentMessage'), await count('AssetAgentBatch')], [0, 0, 0]);
  assert.equal((await prisma.$queryRawUnsafe(`SELECT status FROM "AssetTask" WHERE id = $1`, byDiscipline.VFX.id))[0].status, 'Not Started');
});
