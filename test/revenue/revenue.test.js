// The Revenue page is a port of a standalone app (FastAPI + SQLite). These
// tests hold the port to the original's answers.
//
// fixtures/dump.json    an invented dataset, built by posting made-up people
//                       and amounts to a fresh copy of the original app
// fixtures/golden.json  what the original app answered for every read
//                       endpoint on that dataset
//
// The port must give the same answers. (Before shipping, the same comparison
// was run against a real backup, reads and writes; that data is not here.)

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { PGlite } = require('@electric-sql/pglite');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { setPrisma } = require('../../src/assets/db');
const { ensureRevenueSchema } = require('../../src/revenue/schema');
const { buildRouter } = require('../../src/revenue/api');
const transfer = require('../../src/revenue/transfer');
const R = require('../../src/revenue/resolver');
const dump = require('./fixtures/dump.json');
const golden = require('./fixtures/golden.json');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  const make = runner => ({
    $queryRawUnsafe: async (sql, ...values) => (await runner.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await runner.query(sql, values)).affectedRows ?? 0,
  });
  const prisma = { ...make(pg), $transaction: fn => pg.transaction(tx => fn(make(tx))) };
  await pg.exec(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "name" TEXT, "role" TEXT, "pageAccess" TEXT[])`);
  await ensureRevenueSchema(prisma);
  return prisma;
}

async function serve(app) {
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => server.close() };
}

async function portWithFixture() {
  const prisma = await createDb();
  await transfer.importDump(prisma, dump);
  const app = express();
  app.use(express.json());
  app.use('/api', buildRouter(() => prisma));
  return { prisma, ...(await serve(app)) };
}

// Numbers to a relative tolerance (the two databases add floats in a
// different order); everything else exactly. created_at is when a row was
// written, and source / source_ref are columns only the port has.
function assertSame(actual, expected, where) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    assert.ok(Math.abs(actual - expected) <= 1e-7 * Math.max(1, Math.abs(expected)), `${where}: ${actual} != ${expected}`);
    return;
  }
  if (expected === null || typeof expected !== 'object') { assert.equal(actual ?? null, expected ?? null, where); return; }
  assert.equal(Array.isArray(actual), Array.isArray(expected), `${where}: array or not`);
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${where}: length`);
    expected.forEach((e, i) => assertSame(actual[i], e, `${where}[${i}]`));
    return;
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (['created_at', 'source', 'source_ref'].includes(key)) continue;
    if (key === 'cost_share_person_ids' && typeof expected[key] === 'string') { assert.deepEqual(JSON.parse(actual[key]), JSON.parse(expected[key]), `${where}.${key}`); continue; }
    assertSame(actual[key], expected[key], `${where}.${key}`);
  }
}

test('every read endpoint answers exactly as the original app does', async () => {
  const { call, close } = await portWithFixture();
  try {
    const urls = Object.keys(golden);
    assert.ok(urls.length >= 80);
    for (const url of urls) {
      const res = await call('GET', `/api${url}`);
      assert.equal(res.status, 200, url);
      const expected = golden[url];
      // The original lists who owes cost-share in SQLite's arbitrary order; the port sorts by person.
      if (url.startsWith('/cost-share-owed/')) for (const list of [res.body, expected]) list.sort((a, b) => a.person_id - b.person_id);
      assertSame(res.body, expected, url);
    }
  } finally { close(); }
});

test('the rules behind the numbers: day-weighted shares, the August cost-share change, who fronts a dev payout', async () => {
  const { prisma, call, close } = await portWithFixture();
  try {
    const roster = async month => Object.fromEntries((await call('GET', `/api/roster/${month}`)).body.map(r => [r.name, r]));
    // A share that changes on the 13th of a 30-day month counts 12 days at the old rate and 18 at the new.
    const sept = await roster('2026-09-01');
    assert.ok(Math.abs(sept['Dev Dana'].base_share_pct - (0.12 * 12 + 0.10 * 18) / 30) < 1e-12);
    // A dated stepdown is prorated the same way.
    assert.ok(Math.abs(sept['Dev Eli'].adjustment_delta_pct - (-0.01 * 18) / 30) < 1e-12);

    // Before August a person owes their rule's % of all update costs; from August, costs are split
    // evenly across manual-payout people unless a line item names its own audience.
    assert.ok(Math.abs((await roster('2026-07-01'))['Dev Eli'].cost_share_pct - 0.1) < 1e-12);
    const owed = (await call('GET', '/api/cost-share-owed/2026-09-01')).body;
    assert.ok(owed.every(o => o.payout_method === 'manual'), 'standard-payout people owe nothing from August');
    const total = owed.reduce((sum, o) => sum + o.amount_owed, 0);
    assert.ok(Math.abs(total - owed[0].total_expenses) < 1e-6, 'the shares add up to the month\'s costs');

    // A dev payout with no split comes off the owner alone; one with a split is divided among those named.
    assert.ok(Math.abs(sept['Owner Olive'].dev_payouts_fronted - (1500000 + 900000 / 3)) < 1e-6);
    assert.ok(Math.abs(sept['Dev Dana'].dev_payouts_fronted - 900000 / 3) < 1e-6);
    assert.equal(sept['Standard Sam'].dev_payouts_fronted, 0);

    // Someone fired from October is listed, struck out, from October on and resolves normally before.
    const oct = await roster('2026-10-01');
    assert.deepEqual([oct['Dev Gus'].fired, oct['Dev Gus'].effective_share_pct, sept['Dev Gus'].fired], [true, 0, undefined]);
    assert.equal((await call('GET', '/api/payouts/2026-10-01')).body.some(r => r.name === 'Dev Gus'), false);

    // Dates that are not dates fall back rather than throw, as in the original.
    assert.equal(R.parseDate('2026-02-30'), null);
    assert.equal(R.parseDate(''), null);
    assert.equal(R.monthBounds('2028-02-01').days, 29);
    assert.equal((await call('GET', '/api/roster/garbage')).status, 400);
    assert.ok(prisma);
  } finally { close(); }
});

test('edits behave like the original: only the fields sent change, errors come back as { detail }', async () => {
  const { call, close } = await portWithFixture();
  try {
    const expenses = (await call('GET', '/api/expenses')).body;
    const e = expenses.find(x => x.description === 'Thumbnail');
    assert.deepEqual(e.cost_share_person_ids.length, 2);
    await call('PATCH', `/api/expenses/${e.id}`, { amount: 31000 });
    let after = (await call('GET', '/api/expenses')).body.find(x => x.id === e.id);
    assert.deepEqual([after.amount, after.description, after.cost_share_person_ids.length, after.payee_id], [31000, 'Thumbnail', 2, e.payee_id]);
    // An explicit null clears a field; an empty audience means "back to the default split".
    await call('PATCH', `/api/expenses/${e.id}`, { payee_id: null, cost_share_person_ids: [], date_incurred: '2026-10-15' });
    after = (await call('GET', '/api/expenses')).body.find(x => x.id === e.id);
    assert.deepEqual([after.payee_id, after.cost_share_person_ids, after.month], [null, null, '2026-10-01']);

    assert.deepEqual(await call('PATCH', '/api/expenses/99999', { amount: 1 }), { status: 404, body: { detail: 'Expense not found' } });
    assert.deepEqual(await call('POST', '/api/expenses', { description: 'no date' }), { status: 422, body: { detail: 'date_incurred is required' } });
    assert.equal((await call('POST', '/api/payees', { display_name: '  ' })).body.detail, "Display name can't be empty");
    // A Roblox user id sent as a number is still stored as text.
    const payee = (await call('POST', '/api/payees', { display_name: 'Numeric Nia', roblox_user_id: 7654321 })).body.id;
    assert.equal((await call('GET', '/api/payees?search=nia')).body[0].roblox_user_id, '7654321');
    assert.equal((await call('POST', '/api/payees', { display_name: 'Numeric Nia' })).body.id, payee, 'the same name is the same payee');

    // Splitting a term at a month boundary is all-or-nothing.
    const people = (await call('GET', '/api/people')).body;
    const dana = people.find(p => p.name === 'Dev Dana');
    const before = (await call('GET', `/api/people/${dana.id}/share-terms`)).body;
    const refused = await call('POST', `/api/people/${dana.id}/share-terms-from-month`, { month: '2025-01-01', share_pct: 0.5 });
    assert.deepEqual([refused.status, refused.body.detail], [400, 'No share terms in effect for this person that month']);
    assert.deepEqual((await call('GET', `/api/people/${dana.id}/share-terms`)).body, before, 'nothing was half-applied');

    const owner = (await call('GET', '/api/owner-config')).body.person_id;
    assert.equal((await call('DELETE', `/api/people/${owner}`)).status, 400, 'the owner cannot be deleted');
  } finally { close(); }
});

test('a backup goes in and comes back out unchanged, and new rows never reuse an id', async () => {
  const prisma = await createDb();
  await assert.rejects(transfer.importDump(prisma, { tables: { expenses: [] } }), /no roster/);
  await assert.rejects(transfer.importDump(prisma, { nope: true }), /not a revenue backup/);
  assert.equal((await transfer.counts(prisma)).people, 0, 'a refused import changes nothing');

  const first = await transfer.importDump(prisma, dump, { actorName: 'Owner' });
  assert.deepEqual([first.imported.people, first.imported.expenses, first.imported.share_terms], [7, 7, 9]);
  const exported = await transfer.exportDump(prisma);
  for (const name of transfer.TABLE_NAMES) assertSame(exported.tables[name], dump.tables[name] || [], name);

  // Importing the export again changes nothing, and the next id is past the original's high-water mark.
  await transfer.importDump(prisma, JSON.parse(JSON.stringify(exported)));
  assertSame((await transfer.exportDump(prisma)).tables.people, dump.tables.people, 'people after a round trip');
  const mark = dump.tables.sqlite_sequence.find(q => q.name === 'share_terms').seq;
  const [{ id }] = await prisma.$queryRawUnsafe(
    `INSERT INTO rev_share_terms (person_id, share_pct, effective_from) VALUES (1, 0.01, '2027-01-01') RETURNING id`);
  assert.equal(id, mark + 1);
  const settings = Object.fromEntries((await prisma.$queryRawUnsafe(`SELECT key, value FROM rev_settings`)).map(s => [s.key, s.value]));
  assert.deepEqual([settings.robux_usd_rate, settings.imported_by, settings.seeded_salary_categories], ['0.0035', '', '1']);
});

test('the page is off by default, needs a sign-in, and only the owner or people granted it get in', async () => {
  const prisma = await createDb();
  setPrisma(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO "User" VALUES ('u-owner', 'Owner', 'owner', NULL), ('u-admin', 'Admin', 'admin', ARRAY['bugs','admin']), ('u-fin', 'Finance', 'engineer', ARRAY['bugs','revenue'])`);
  const token = (id, role) => jwt.sign({ id, role, name: id }, process.env.JWT_SECRET);
  const app = express();
  app.use('/api/revenue/admin/import', express.json({ limit: '25mb' }));
  app.use(express.json());
  app.use('/api/revenue', require('../../src/routes/revenue'));
  const { call, close } = await serve(app);
  try {
    delete process.env.REVENUE_ENABLED;
    assert.equal((await call('GET', '/api/revenue/people', undefined, token('u-owner', 'owner'))).status, 404);
    process.env.REVENUE_ENABLED = 'true';
    assert.equal((await call('GET', '/api/revenue/people')).status, 401);
    assert.equal((await call('GET', '/api/revenue/people', undefined, token('u-admin', 'admin'))).status, 403, 'being an admin is not enough');
    assert.equal((await call('GET', '/api/revenue/people', undefined, token('u-fin', 'engineer'))).status, 200);
    assert.equal((await call('GET', '/api/revenue/people', undefined, token('u-owner', 'owner'))).status, 200);

    // Replacing everything is the owner's alone; a dry run reports and changes nothing.
    assert.equal((await call('POST', '/api/revenue/admin/import', { dump }, token('u-fin', 'engineer'))).status, 403, 'not for an engineer, even with the page');
    const dry = await call('POST', '/api/revenue/admin/import', { dump, dry_run: true }, token('u-owner', 'owner'));
    assert.deepEqual([dry.body.dry_run, dry.body.tables.people, dry.body.current.people], [true, 7, 0]);
    const done = await call('POST', '/api/revenue/admin/import', { dump }, token('u-owner', 'owner'));
    assert.equal(done.body.imported.people, 7);
    const status = await call('GET', '/api/revenue/admin/status', undefined, token('u-fin', 'engineer'));
    assert.deepEqual([status.body.counts.people, status.body.imported_by, status.body.is_owner], [7, 'u-owner', false]);
    assert.equal((await call('GET', '/api/revenue/admin/export', undefined, token('u-fin', 'engineer'))).status, 403);
    assert.equal((await call('GET', '/api/revenue/admin/export', undefined, token('u-owner', 'owner'))).body.tables.people.length, 7);
    assert.equal((await call('GET', '/api/revenue/overview/2026-09-01', undefined, token('u-fin', 'engineer'))).body.month, '2026-09-01');
  } finally { close(); delete process.env.REVENUE_ENABLED; }
});
