const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, ctxFor, seedBasics } = require('./helpers');
const service = require('../../src/assets/service');
const q = require('../../src/assets/queries');
const payouts = require('../../src/assets/payouts');
const assistant = require('../../src/assets/agent/assistant');

const FORUM = '600000000000000001';
const POST = '600000000000000002';
const ANI = '222222222222222222';
const ADMIN = '700000000000000001';

let nextId = 810000000000000000n;
const msg = (content, extra = {}) => ({
  id: String(nextId++), channelId: POST, parentChannelId: FORUM, guildId: '900', authorDiscordId: ANI, authorName: 'Ani', content, attachments: [],
  postedAt: new Date().toISOString(), ...extra,
});
// Stands in for the model: returns whatever the test says it read.
const reads = result => async input => ({ result: typeof result === 'function' ? result(input) : result, model: 'claude-sonnet-5-5', usage: { input_tokens: 2000, output_tokens: 80 } });
const blank = { amount_text: '', amount_number: 0, description: '', item: '', task_refs: [], roblox_account: '', question: '' };

async function setup({ roblox = 'AniBuilds' } = {}) {
  const prisma = await createTestDb();
  const seeded = await seedBasics(prisma);
  await service.updateDev(ctxFor(prisma), seeded.ani.id, { discordThreadId: FORUM, robloxAccount: roblox });
  await assistant.saveSettings(prisma, { admins: [{ id: ADMIN, label: 'Alex' }] });
  const tasks = await q.listTasksDetailed(prisma, { contentItemId: seeded.aizen.id });
  const anim = tasks.find(t => t.discipline === 'Animation');
  const vfx = tasks.find(t => t.discipline === 'VFX');
  await service.updateTask(ctxFor(prisma), anim.id, { assigneeDevId: seeded.ani.id, status: 'Done' });
  return { prisma, ...seeded, anim, vfx };
}

test('a clear request is logged against the item and task and is ready to forward', async () => {
  const { prisma, anim, aizen, ani } = await setup();
  let seen;
  const out = await payouts.handleRequest(prisma, msg('30k payout for aizens attack anims'), {
    read: reads(input => { seen = input; return { ...blank, kind: 'request', amount_text: '30k', amount_number: 30000, description: 'Aizen attack animations', item: 'aizen', task_refs: [String(anim.ref)] }; }),
  });
  assert.match(seen.context, /DEV: Ani \(Animation, VFX\)/);
  assert.match(seen.context, new RegExp(`#${anim.ref} \\| Aizen \\| Attack animations \\| Animation \\| Done`));
  assert.match(seen.context, /UNASSIGNED TASKS IN THEIR DISCIPLINES:\n#\d+ \| Aizen \| Ability VFX/);
  assert.match(seen.text, /Ani wrote in their Payments post:\n30k payout for aizens attack anims/);

  assert.equal(out.action, 'logged');
  assert.match(out.reply, /Logged \*\*30k\*\* for \*\*Aizen attack animations\*\*/);
  const p = out.payout;
  assert.deepEqual([p.status, p.amount, p.amountText, p.devName, p.itemName, p.contentItemId === aizen.id, p.devId === ani.id], ['pending', 30000, '30k', 'Ani', 'Aizen', true, true]);
  assert.deepEqual(p.tasks.map(t => [t.ref, t.deliverable, t.item]), [[anim.ref, 'Attack animations', 'Aizen']]);
  assert.match(p.requestUrl, /^https:\/\/discord\.com\/channels\/900\/600000000000000002\/\d+$/);
  assert.deepEqual(p.duplicates, []);

  // The task now shows the request on the Assets page.
  const [task] = await q.listTasks(prisma, { ids: [anim.id] });
  assert.deepEqual([task.payout.status, task.payout.amount, task.payout.url], ['pending', '30k', p.requestUrl]);
});

test('a vague request is asked about, and the answer completes it', async () => {
  const { prisma, anim } = await setup();
  const asked = await payouts.handleRequest(prisma, msg('payout pls'), { read: reads({ ...blank, kind: 'needs_info', question: 'Which item is this for, and what did you make?' }) });
  assert.deepEqual([asked.action, asked.reply], ['ask', 'Which item is this for, and what did you make?']);
  assert.equal((await payouts.listPayouts(prisma, {})).length, 0, 'not shown to admins yet');

  let seen;
  const done = await payouts.handleRequest(prisma, msg('aizen attack anims, 30k'), {
    read: reads(input => { seen = input; return { ...blank, kind: 'request', amount_text: '30k', amount_number: 30000, description: 'Aizen attack animations', item: 'Aizen', task_refs: [`#${anim.ref}`] }; }),
  });
  assert.match(seen.text, /payout pls\naizen attack anims, 30k/, 'both lines are read as one request');
  assert.equal(done.action, 'logged');
  assert.equal(done.payout.id, asked.payoutId, 'the same request, now complete');
  assert.equal((await payouts.listPayouts(prisma, {})).length, 1);

  // No question from the model still gets the dev a useful prompt.
  const fallback = await payouts.handleRequest(prisma, msg('20k'), { read: reads({ ...blank, kind: 'needs_info' }) });
  assert.match(fallback.reply, /What is this payout for\?/);
});

test('chat, other people and other channels are ignored', async () => {
  const { prisma } = await setup();
  const never = async () => { throw new Error('the model should not be asked'); };
  assert.equal((await payouts.handleRequest(prisma, msg('thanks!'), { read: reads({ ...blank, kind: 'not_a_request' }) })).action, 'ignore');
  assert.equal((await payouts.handleRequest(prisma, msg('paid you for aizen', { authorDiscordId: ADMIN }), { read: never })).why, 'not the dev');
  assert.equal((await payouts.handleRequest(prisma, msg('30k for aizen', { parentChannelId: '600000000000000009' }), { read: never })).why, 'not a dev forum');
  assert.equal((await payouts.handleRequest(prisma, msg('   '), { read: never })).why, 'empty');
  await payouts.saveSettings(prisma, { enabled: false });
  assert.equal((await payouts.handleRequest(prisma, msg('30k for aizen'), { read: never })).why, 'off');
  assert.equal((await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetPayout"`))[0].n, 0);
});

test('a second request for the same task is flagged as a duplicate, whether the first is pending or paid', async () => {
  const { prisma, anim } = await setup();
  const read = reads({ ...blank, kind: 'request', amount_text: '30k', amount_number: 30000, description: 'Aizen attack animations', item: 'Aizen', task_refs: [String(anim.ref)] });
  const first = (await payouts.handleRequest(prisma, msg('30k for aizen anims'), { read })).payout;
  const second = (await payouts.handleRequest(prisma, msg('30k for aizen anims again'), { read })).payout;
  assert.deepEqual(second.duplicates.map(d => [d.id, d.status, d.amountText]), [[first.id, 'pending', '30k']]);

  await payouts.resolve(prisma, first.id, { decision: 'paid', actorName: 'Alex', via: 'discord' });
  const third = (await payouts.handleRequest(prisma, msg('aizen anims payout'), { read })).payout;
  assert.deepEqual(third.duplicates.map(d => d.status).sort(), ['paid', 'pending']);

  // With no task matched, the same dev asking about the same item still raises the flag.
  const loose = reads({ ...blank, kind: 'request', amount_text: '5k', amount_number: 5000, description: 'Aizen extra polish', item: 'Aizen', task_refs: [] });
  await payouts.handleRequest(prisma, msg('5k aizen polish'), { read: loose });
  const again = (await payouts.handleRequest(prisma, msg('5k aizen polish pls'), { read: loose })).payout;
  assert.equal(again.duplicates.length, 1);
  assert.equal(again.duplicates[0].description, 'Aizen extra polish');
});

test('paying marks the task paid, logs who did it, and queues Discord only when done on the web', async () => {
  const { prisma, anim } = await setup();
  const read = reads({ ...blank, kind: 'request', amount_text: '30k', amount_number: 30000, description: 'Aizen attack animations', item: 'Aizen', task_refs: [String(anim.ref)] });
  const p = (await payouts.handleRequest(prisma, msg('30k for aizen anims'), { read })).payout;
  await payouts.markPosted(prisma, p.id, { adminChannelId: '1', adminMessageId: '2' });

  await assert.rejects(payouts.resolve(prisma, p.id, { decision: 'declined', actorName: 'Alex' }), /Say why/);
  const paid = await payouts.resolve(prisma, p.id, { decision: 'paid', actorName: 'Alex', via: 'web' });
  assert.deepEqual([paid.status, paid.resolvedByName, !!paid.paidAt, paid.adminMessageId], ['paid', 'Alex', true, '2']);
  assert.equal((await q.listTasks(prisma, { ids: [anim.id] }))[0].payout.status, 'paid');
  await assert.rejects(payouts.resolve(prisma, p.id, { decision: 'paid', actorName: 'Sam' }), /Already paid by Alex/);

  assert.deepEqual((await payouts.claimDiscordSync(prisma)).map(x => x.id), [p.id], 'a web change is handed to the bot once');
  assert.deepEqual(await payouts.claimDiscordSync(prisma), []);

  const reopened = await payouts.resolve(prisma, p.id, { decision: 'reopen', actorName: 'Alex', via: 'discord' });
  assert.deepEqual([reopened.status, reopened.paidAt, reopened.resolvedByName], ['pending', null, null]);
  assert.deepEqual(await payouts.claimDiscordSync(prisma), [], 'a Discord change is applied by the bot itself');
  const declined = await payouts.resolve(prisma, p.id, { decision: 'declined', actorName: 'Alex', reason: 'already covered by the unit payout' });
  assert.deepEqual([declined.status, declined.declineReason], ['declined', 'already covered by the unit payout']);
  assert.equal((await q.listTasks(prisma, { ids: [anim.id] }))[0].payout, null, 'a declined request leaves the task unpaid');

  const log = await prisma.$queryRawUnsafe(`SELECT label FROM "AssetActivity" WHERE "entityType" = 'payout' ORDER BY "createdAt"`);
  assert.equal(log[0].label, 'Payout requested: 30k for Aizen attack animations');
  assert.match(log.at(-1).label, /^Payout declined: 30k to Ani for Aizen attack animations \(already covered/);
});

test('a request is held until we know the Roblox account to pay, and the account is remembered', async () => {
  const { prisma, anim, ani } = await setup({ roblox: null });
  const request = { ...blank, kind: 'request', amount_text: '30k', amount_number: 30000, description: 'Aizen attack animations', item: 'Aizen', task_refs: [String(anim.ref)] };

  const held = await payouts.handleRequest(prisma, msg('30k payout for aizens attack anims'), { read: reads(request) });
  assert.equal(held.action, 'ask');
  assert.match(held.reply, /^Got it: \*\*30k\*\* for \*\*Aizen attack animations\*\*\. Before I pass this to the admins, what is your Roblox profile link, username or user ID\?/);
  assert.equal((await payouts.listPayouts(prisma, {})).length, 0, 'nothing reaches the admins yet');
  assert.equal((await q.listTasks(prisma, { ids: [anim.id] }))[0].payout, null);

  // Their answer is a bare username. The model is told the bot asked; even if it misses it, the answer is taken.
  let seen;
  const done = await payouts.handleRequest(prisma, msg('AniRBX_22'), { read: reads(input => { seen = input; return request; }) });
  assert.match(seen.text, /The bot had asked for their Roblox profile link, username or user ID/);
  assert.equal(done.action, 'logged');
  assert.deepEqual([done.payout.id, done.payout.robloxAccount, done.payout.status], [held.payoutId, 'AniRBX_22', 'pending']);
  assert.equal((await q.listDevs(prisma)).find(d => d.id === ani.id).robloxAccount, 'AniRBX_22', 'saved on the roster');

  // Next time they are not asked again.
  const next = await payouts.handleRequest(prisma, msg('10k for aizen polish'), { read: reads({ ...request, amount_text: '10k', description: 'Aizen polish', task_refs: [] }) });
  assert.deepEqual([next.action, next.payout.robloxAccount], ['logged', 'AniRBX_22']);
});

test('an account given with the request goes straight through; vague requests are asked for both things at once', async () => {
  const { prisma, ani } = await setup({ roblox: null });
  const vague = await payouts.handleRequest(prisma, msg('payout pls'), { read: reads({ ...blank, kind: 'needs_info', question: 'Which item is this for?' }) });
  assert.equal(vague.reply, 'Which item is this for?' + String.fromCharCode(10) + 'Please also include your Roblox profile link, username or user ID, so we know where to send it.');

  const done = await payouts.handleRequest(prisma, msg('30k for aizen attack anims https://www.roblox.com/users/123456789/profile'), {
    read: reads({ ...blank, kind: 'request', amount_text: '30k', amount_number: 30000, description: 'Aizen attack animations', item: 'Aizen', roblox_account: 'https://www.roblox.com/users/123456789/profile' }),
  });
  assert.deepEqual([done.action, done.payout.robloxAccount], ['logged', 'https://www.roblox.com/users/123456789/profile']);
  assert.equal((await q.listDevs(prisma)).find(d => d.id === ani.id).robloxAccount, 'https://www.roblox.com/users/123456789/profile');

  assert.equal(payouts.robloxFrom('@Builder_Man.'), 'Builder_Man');
  assert.equal(payouts.robloxFrom('my roblox is cool'), null, 'a sentence is not an account');
  assert.equal(payouts.robloxUrl('123456'), 'https://www.roblox.com/users/123456/profile');
  assert.equal(payouts.robloxUrl('Builder_Man'), 'https://www.roblox.com/search/users?keyword=Builder_Man');
});
