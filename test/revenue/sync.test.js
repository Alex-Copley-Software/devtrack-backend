// Where asset payouts meet the Revenue page: a paid payout becomes an
// expense, the expense log warns about repeats, and the payee directory
// saves asking a dev for a Roblox account it already holds.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.REVENUE_ENABLED = 'true';
const { createTestDb, ctxFor, seedBasics } = require('../assets/helpers');
const service = require('../../src/assets/service');
const q = require('../../src/assets/queries');
const payouts = require('../../src/assets/payouts');
const assistant = require('../../src/assets/agent/assistant');
const revenue = require('../../src/revenue/sync');
const { ensureRevenueSchema } = require('../../src/revenue/schema');

const FORUM = '600000000000000001';
const POST = '600000000000000002';
const ANI = '222222222222222222';
let nextId = 820000000000000000n;
const msg = (content, extra = {}) => ({
  id: String(nextId++), channelId: POST, parentChannelId: FORUM, guildId: '900', authorDiscordId: ANI, authorName: 'Ani', content, attachments: [],
  postedAt: new Date().toISOString(), ...extra,
});
const reads = result => async () => ({ result: { amount_text: '', amount_number: 0, description: '', item: '', task_refs: [], roblox_account: '', question: '', ...result } });

async function setup({ roblox = '5550001' } = {}) {
  const prisma = await createTestDb();
  const seeded = await seedBasics(prisma);
  await ensureRevenueSchema(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO rev_monthly_revenue (month, gross_revenue) VALUES ('2026-10-01', 0)`);
  await service.updateDev(ctxFor(prisma), seeded.ani.id, { discordThreadId: FORUM, robloxAccount: roblox });
  const expenses = () => prisma.$queryRawUnsafe(
    `SELECT e.*, p.display_name, p.roblox_user_id FROM rev_expenses e LEFT JOIN rev_payees p ON p.id = e.payee_id ORDER BY e.id`);
  const request = (text, result) => payouts.handleRequest(prisma, msg(text), { read: reads({ kind: 'request', item: 'Aizen', ...result }) });
  return { prisma, ...seeded, expenses, request };
}

test('a paid payout is logged once as an expense against the right payee, and reopening takes it back out', async () => {
  const { prisma, expenses, request } = await setup();
  // The directory already has this person under their Roblox id, with a different spelling.
  await prisma.$executeRawUnsafe(`INSERT INTO rev_payees (display_name, roblox_user_id) VALUES ('AniBuilds', '5550001'), ('Someone Else', '999')`);
  const p = (await request('30k payout for aizens shiny model', { amount_text: '30k', amount_number: 30000, description: 'Aizen shiny model' })).payout;
  assert.deepEqual(await expenses(), [], 'nothing is logged until it is paid');

  const paid = await payouts.resolve(prisma, p.id, { decision: 'paid', actorName: 'Olive', via: 'discord' });
  const [e] = await expenses();
  assert.deepEqual([e.description, e.category, e.amount, e.display_name, e.receipt_url, e.source, e.source_ref],
    ['Aizen shiny model', 'Art/Assets', 30000, 'AniBuilds', p.requestUrl, 'asset_payout', p.id]);
  assert.match(e.date_incurred, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(e.month, `${e.date_incurred.slice(0, 8)}01`);
  assert.deepEqual([paid.revenueExpenseId, paid.revenueNote], [e.id, null]);

  // Logging the same payout again does not create a second expense.
  assert.equal((await revenue.logAssetPayout(prisma, paid)).expenseId, e.id);
  assert.equal((await expenses()).length, 1);

  const reopened = await payouts.resolve(prisma, p.id, { decision: 'reopen', actorName: 'Olive', via: 'discord' });
  assert.deepEqual([(await expenses()).length, reopened.revenueExpenseId], [0, null]);
  await payouts.resolve(prisma, p.id, { decision: 'paid', actorName: 'Olive', via: 'web' });
  assert.equal((await expenses()).length, 1, 'paid again, logged again');
});

test('a payee is created when the directory has nobody, and amounts that are not Robux are left for a person', async () => {
  const { prisma, expenses, request } = await setup({ roblox: 'https://www.roblox.com/users/7770002/profile' });
  const a = (await request('45k for aizen textures', { amount_text: '45k', amount_number: 45000, description: 'Aizen textures' })).payout;
  await payouts.resolve(prisma, a.id, { decision: 'paid', actorName: 'Olive' });
  let rows = await expenses();
  assert.deepEqual([rows[0].display_name, rows[0].roblox_user_id, rows[0].amount], ['Ani', '7770002', 45000]);

  const dollars = (await request('$200 for the aizen rig', { amount_text: '$200', amount_number: 200, description: 'Aizen rig' })).payout;
  const paidDollars = await payouts.resolve(prisma, dollars.id, { decision: 'paid', actorName: 'Olive' });
  assert.equal(paidDollars.revenueExpenseId, null);
  assert.match(paidDollars.revenueNote, /^Not logged to Revenue: the amount was written in dollars \(\$200\)/);

  const noAmount = (await request('payout for aizen icons', { description: 'Aizen icons' })).payout;
  assert.match((await payouts.resolve(prisma, noAmount.id, { decision: 'paid', actorName: 'Olive' })).revenueNote, /no amount was given/);
  rows = await expenses();
  assert.equal(rows.length, 1, 'only the Robux payout was logged');
  assert.equal((await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM rev_payees`))[0].n, 1, 'the same dev is the same payee');
});

test('a new request shows what the expense log says they were paid lately', async () => {
  const { prisma, request } = await setup();
  const [{ id: payee }] = await prisma.$queryRawUnsafe(`INSERT INTO rev_payees (display_name, roblox_user_id) VALUES ('Ani', '5550001') RETURNING id`);
  for (const [date, description, amount] of [['2026-10-01', 'Aizen shiny model', 30000], ['2026-09-20', 'Starrk guns', 95000]]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO rev_expenses (date_incurred, month, description, category, amount, payee_id) VALUES ($1, $2, $3, 'Art/Assets', $4::double precision, $5::int)`,
      date, `${date.slice(0, 8)}01`, description, amount, payee);
  }
  const p = (await request('30k payout for aizens shiny model', { amount_text: '30k', amount_number: 30000, description: 'Aizen shiny model' })).payout;
  assert.deepEqual(p.paymentHistory.map(h => [h.date, h.description, h.amount]), [['2026-10-01', 'Aizen shiny model', 30000], ['2026-09-20', 'Starrk guns', 95000]]);
});

test('a dev the payee directory already knows is not asked for a Roblox account', async () => {
  const { prisma, ani, request } = await setup({ roblox: null });
  await prisma.$executeRawUnsafe(`INSERT INTO rev_payees (display_name, roblox_user_id) VALUES ('ani', '4440003'), ('Ani | other', NULL)`);
  const out = await request('30k for aizen anims', { amount_text: '30k', amount_number: 30000, description: 'Aizen attack animations' });
  assert.deepEqual([out.action, out.payout.robloxAccount], ['logged', '4440003']);
  assert.equal((await q.listDevs(prisma)).find(d => d.id === ani.id).robloxAccount, '4440003', 'and it is saved on the roster');

  // Two different payees that could be the same name: no guess is made.
  assert.equal(await revenue.findPayee(prisma, { name: 'Nobody' }), null);
  assert.equal(revenue.robloxUserId('https://www.roblox.com/users/123456/profile'), '123456');
  assert.equal(revenue.robloxUserId('Builder_Man'), null);
});

test('the assistant can read payment history, and nothing else about money', async () => {
  const { prisma } = await setup();
  const [{ id: payee }] = await prisma.$queryRawUnsafe(`INSERT INTO rev_payees (display_name, roblox_user_id) VALUES ('Ani', '5550001') RETURNING id`);
  await prisma.$executeRawUnsafe(
    `INSERT INTO rev_expenses (date_incurred, month, description, category, amount, payee_id, receipt_url)
     VALUES ('2026-10-01', '2026-10-01', 'Aizen shiny model', 'Art/Assets', 30000, $1::int, 'https://discord.com/channels/1/2/3'),
            ('2026-09-20', '2026-09-01', 'Starrk guns', 'Art/Assets', 95000, $1::int, NULL)`, payee);
  const all = await revenue.paymentsTo(prisma, { name: 'ani' });
  assert.deepEqual([all.payee, all.payments_found, all.total_robux, all.payments[0].for, all.payments[0].receipt], ['Ani', 2, 125000, 'Aizen shiny model', 'https://discord.com/channels/1/2/3']);
  assert.deepEqual((await revenue.paymentsTo(prisma, { text: 'starrk' })).payments.map(p => p.robux), [95000]);
  assert.match((await revenue.paymentsTo(prisma, { name: 'Zed' })).error, /Nobody called "Zed"/);
  // Before the page is set up, nothing is logged (an import would only wipe it).
  await prisma.$executeRawUnsafe(`DELETE FROM rev_monthly_revenue`);
  assert.match((await revenue.logAssetPayout(prisma, { id: 'x', amount: 5, devName: 'Ani' })).skipped, /has no data yet/);
  const tools = assistant.TOOLS.map(t => t.name);
  assert.ok(tools.includes('get_payments'));
  assert.ok(!tools.some(t => /share|roster|revenue|salary/i.test(t)), 'no tool exposes shares, salaries or revenue');
});
