// Where the rest of DevTrack meets the Revenue page.
//
// The studio logs every payment to an asset dev as an expense on the Revenue
// page: who was paid (a payee from the directory, with their Roblox user id),
// how many Robux, what for, and a link to the Discord message as the receipt.
// Dev payout requests in Discord carry exactly those facts, so:
//
//   paid      -> the payout is logged as an expense, once, linked both ways
//   reopened  -> that expense is taken back out
//   a request -> shows what the dev was paid recently, straight from the
//                expense log, so a repeat is easy to spot
//   a new dev -> if the payee directory already has their Roblox id, they
//                are not asked for it
//
// Everything here is best-effort from the caller's side: a problem logging
// to Revenue must never stop a payout being marked paid.

const { isEnabled } = require('../assets/constants');
const { ensureRevenueSchema } = require('./schema');

const enabled = () => isEnabled('REVENUE_ENABLED');
const CATEGORY = () => process.env.REVENUE_ASSET_PAYOUT_CATEGORY || 'Art/Assets';

// The numeric Roblox user id in an account as a dev gave it (a profile link
// or a bare id). A username has none.
function robloxUserId(account) {
  const v = String(account || '').trim();
  const fromLink = /roblox\.com\/users\/(\d+)/i.exec(v);
  if (fromLink) return fromLink[1];
  return /^\d{3,15}$/.test(v) ? v : null;
}

// The payee for a dev: by Roblox user id first (the one thing that cannot be
// a namesake), then by name. Directory names are sometimes "Name | handle".
async function findPayee(prisma, { name, roblox }) {
  const id = robloxUserId(roblox);
  if (id) {
    const [byId] = await prisma.$queryRawUnsafe(`SELECT * FROM rev_payees WHERE roblox_user_id = $1 ORDER BY id LIMIT 1`, id);
    if (byId) return byId;
  }
  const n = String(name || '').trim();
  if (!n) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM rev_payees WHERE lower(display_name) = lower($1) OR lower(display_name) LIKE lower($1) || ' |%' ORDER BY (lower(display_name) = lower($1)) DESC, id`, n);
  // Two different people with the same name: do not guess.
  return rows.length === 1 || (rows[0] && rows[0].display_name.toLowerCase() === n.toLowerCase()) ? rows[0] : null;
}

// The Roblox user id the payee directory has on file under a dev's name, if
// any. Only ever used to point out a difference from what the dev asked for:
// the account a payout goes to always comes from the dev.
async function robloxFor(prisma, dev) {
  if (!enabled()) return null;
  await ensureRevenueSchema(prisma);
  const payee = await findPayee(prisma, { name: dev.name });
  return payee && payee.roblox_user_id ? String(payee.roblox_user_id) : null;
}

// What this dev was paid most recently, from the expense log.
async function recentPayments(prisma, { name, roblox }, limit = 5) {
  if (!enabled()) return [];
  await ensureRevenueSchema(prisma);
  const payee = await findPayee(prisma, { name, roblox });
  if (!payee) return [];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, date_incurred, description, amount, receipt_url FROM rev_expenses WHERE payee_id = $1 ORDER BY date_incurred DESC, id DESC LIMIT ${Math.min(20, Math.max(1, Number(limit) || 5))}`, payee.id);
  return rows.map(r => ({ id: r.id, date: r.date_incurred, description: r.description, amount: r.amount, url: r.receipt_url || null }));
}

// Who can be chosen to split a cost: this month's manual-payout shareholders,
// which is also who splits it when nobody is chosen.
async function audienceOptions(prisma) {
  if (!enabled()) return [];
  await ensureRevenueSchema(prisma);
  const { resolveCostSharePersonIds } = require('./resolver');
  const { reader } = require('./store');
  const month = `${new Date().toISOString().slice(0, 8)}01`;
  const ids = await resolveCostSharePersonIds(reader(prisma), month);
  if (!ids.length) return [];
  const people = await prisma.$queryRawUnsafe(`SELECT id, name FROM rev_people WHERE id = ANY($1::int[]) ORDER BY name`, ids);
  return people.map(p => ({ id: p.id, name: p.name }));
}

// The ids that are real roster people, as the JSON text an expense stores (null: default split).
async function audienceJson(prisma, ids) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger))];
  if (!wanted.length) return null;
  const real = (await prisma.$queryRawUnsafe(`SELECT id FROM rev_people WHERE id = ANY($1::int[]) ORDER BY id`, wanted)).map(p => p.id);
  return real.length ? JSON.stringify(real) : null;
}

// An amount the dev wrote in dollars is not a Robux figure, and expenses are
// kept in Robux, so it is not logged on its own.
const looksLikeDollars = text => /\$|usd|dollar/i.test(String(text || ''));

// Logs a paid payout as an expense. Returns { expenseId } or { skipped: why }.
async function logAssetPayout(prisma, payout) {
  if (!enabled()) return { skipped: 'Revenue is not switched on' };
  await ensureRevenueSchema(prisma);
  const [existing] = await prisma.$queryRawUnsafe(`SELECT id FROM rev_expenses WHERE source = 'asset_payout' AND source_ref = $1 LIMIT 1`, payout.id);
  if (existing) return { expenseId: existing.id };
  // Until the page has been set up (a backup imported, or months created),
  // anything logged here would only be wiped by that first import.
  const [{ n: months }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM rev_monthly_revenue`);
  if (!months) return { skipped: 'the Revenue page has no data yet (import your backup first), so log this one there by hand afterwards' };
  if (!(payout.amount > 0)) return { skipped: 'no amount was given, so log this one on the Revenue page by hand' };
  if (looksLikeDollars(payout.amountText)) return { skipped: `the amount was written in dollars (${payout.amountText}), and expenses are kept in Robux: log it on the Revenue page by hand` };

  let payee = await findPayee(prisma, { name: payout.devName, roblox: payout.robloxAccount });
  if (!payee) {
    const [created] = await prisma.$queryRawUnsafe(
      `INSERT INTO rev_payees (display_name, roblox_user_id) VALUES ($1, $2) ON CONFLICT (display_name) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING *`,
      String(payout.devName || 'Unknown dev'), robloxUserId(payout.robloxAccount));
    payee = created;
  } else if (!payee.roblox_user_id && robloxUserId(payout.robloxAccount)) {
    // The directory knew the name but not the id; now it does.
    await prisma.$executeRawUnsafe(`UPDATE rev_payees SET roblox_user_id = $1 WHERE id = $2`, robloxUserId(payout.robloxAccount), payee.id);
  }

  const date = new Date(payout.paidAt || Date.now()).toISOString().slice(0, 10);
  const [row] = await prisma.$queryRawUnsafe(
    `INSERT INTO rev_expenses (date_incurred, month, description, category, amount, receipt_url, payee_id, source, source_ref, cost_share_person_ids)
     VALUES ($1, $2, $3, $4, $5::double precision, $6, $7::int, 'asset_payout', $8, $9) RETURNING id`,
    date, `${date.slice(0, 8)}01`, String(payout.description || 'Asset payout').slice(0, 500), CATEGORY(), Number(payout.amount),
    payout.requestUrl || null, payee.id, payout.id, await audienceJson(prisma, payout.costSharePersonIds));
  return { expenseId: row.id, payee: payee.display_name };
}

// Takes a payout's expense back out (the payout was reopened or declined after being paid).
async function unlogAssetPayout(prisma, payoutId) {
  if (!enabled()) return 0;
  await ensureRevenueSchema(prisma);
  return prisma.$executeRawUnsafe(`DELETE FROM rev_expenses WHERE source = 'asset_payout' AND source_ref = $1`, payoutId);
}

// For the assistant: payments to someone, newest first, with a total.
async function paymentsTo(prisma, { name, text, limit = 15 } = {}) {
  if (!enabled()) return { error: 'The Revenue page is not switched on, so there is no payment history to read.' };
  await ensureRevenueSchema(prisma);
  const where = [];
  const values = [];
  let payee = null;
  if (name) {
    payee = await findPayee(prisma, { name });
    if (!payee) {
      const close = await prisma.$queryRawUnsafe(`SELECT display_name FROM rev_payees WHERE display_name ILIKE '%' || $1 || '%' ORDER BY display_name LIMIT 8`, String(name));
      return { error: `Nobody called "${name}" is in the payee directory.`, similar_names: close.map(c => c.display_name) };
    }
    values.push(payee.id); where.push(`e.payee_id = $${values.length}`);
  }
  if (text) { values.push(String(text)); where.push(`e.description ILIKE '%' || $${values.length} || '%'`); }
  const cap = Math.min(40, Math.max(1, Number(limit) || 15));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT e.date_incurred, e.description, e.amount, e.category, e.receipt_url, p.display_name
     FROM rev_expenses e LEFT JOIN rev_payees p ON p.id = e.payee_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.date_incurred DESC, e.id DESC LIMIT ${cap}`, ...values);
  const [sum] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(e.amount), 0) AS total FROM rev_expenses e ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...values);
  return {
    payee: payee ? payee.display_name : null, payments_found: sum.n, total_robux: sum.total,
    payments: rows.map(r => ({ date: r.date_incurred, to: r.display_name, robux: r.amount, for: r.description, category: r.category, receipt: r.receipt_url || undefined })),
  };
}

// ── expenses logged by instruction (the assistant) ───────────────────────────
// A manager lists payments in Discord; nothing is written until an approved
// admin accepts the card. prepareExpenses checks the list and works out who
// each payment is to; logExpenses writes it once accepted.

const MAX_EXPENSES_PER_CARD = 20;

// "100k", "1.5m", "100,000", 100000 -> whole Robux. null when it is not an amount.
function parseRobux(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  const m = /^([\d,]*\.?\d+)\s*([km])?(?:\s*(?:r\$|robux))?$/i.exec(String(value || '').trim().replace(/^r\$\s*/i, ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] || 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

async function expenseCategories(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT category FROM rev_expenses WHERE category IS NOT NULL GROUP BY category ORDER BY COUNT(*) DESC`);
  return [...new Set([...rows.map(r => r.category), 'Other'])];
}

const robux = n => Number(n).toLocaleString('en-US');

// Returns { payload, summary, after } ready to store as a proposal, or { error, ... } saying what to fix.
async function prepareExpenses(prisma, { description, category, date, entries, splitBetween } = {}) {
  if (!enabled()) return { error: 'The Revenue page is not switched on, so expenses cannot be logged.' };
  await ensureRevenueSchema(prisma);
  const [{ n: months }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM rev_monthly_revenue`);
  if (!months) return { error: 'The Revenue page has no data yet. Import the backup first.' };

  const what = String(description || '').trim().slice(0, 500);
  if (!what) return { error: 'Say what the payments are for (the description on the expense).' };
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return { error: 'No payments were given.' };
  if (list.length > MAX_EXPENSES_PER_CARD) return { error: `At most ${MAX_EXPENSES_PER_CARD} payments per card. Split the list into several calls.` };

  const categories = await expenseCategories(prisma);
  const cat = categories.find(c => c.toLowerCase() === String(category || '').trim().toLowerCase());
  if (!cat) return { error: category ? `"${category}" is not a category in use.` : 'A category is needed.', categories };

  const day = String(date || '').trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) return { error: `"${date}" is not a date. Use YYYY-MM-DD.` };

  // Who splits the cost. Nobody named: the default, an even split across this month's manual-payout shareholders.
  let costSharePersonIds = null;
  let audience = 'Everyone on the roster (the default split)';
  const named = (Array.isArray(splitBetween) ? splitBetween : []).map(n => String(n || '').trim()).filter(Boolean);
  if (named.length) {
    const options = await audienceOptions(prisma);
    const chosen = [];
    for (const name of named) {
      const hit = options.find(o => o.name.toLowerCase() === name.toLowerCase())
        || options.filter(o => o.name.toLowerCase().includes(name.toLowerCase())).find((o, i, all) => all.length === 1);
      if (!hit) return { error: `"${name}" is not one of the people who can split a cost this month.`, people: options.map(o => o.name) };
      if (!chosen.some(c => c.id === hit.id)) chosen.push(hit);
    }
    costSharePersonIds = chosen.map(c => c.id).sort((a, b) => a - b);
    audience = chosen.map(c => c.name).join(', ');
  }

  const problems = [];
  const out = [];
  for (const [i, e] of list.entries()) {
    const name = String(e?.name || '').trim().slice(0, 120);
    const label = name || `payment ${i + 1}`;
    if (!name) { problems.push(`${label}: no name`); continue; }
    if (looksLikeDollars(e.amount)) { problems.push(`${label}: ${e.amount} is in dollars, and expenses are kept in Robux`); continue; }
    const amount = parseRobux(e.amount);
    if (!amount) { problems.push(`${label}: "${e.amount}" is not an amount`); continue; }
    const given = String(e.roblox_id || '').trim();
    const id = given ? robloxUserId(given) : null;
    if (given && !id) { problems.push(`${label}: "${given}" is not a Roblox user id or profile link`); continue; }
    if (out.some(o => o.name.toLowerCase() === name.toLowerCase() && o.amount === amount)) { problems.push(`${label}: listed twice with the same amount`); continue; }

    const payee = await findPayee(prisma, { name, roblox: id });
    if (payee && id && payee.roblox_user_id && String(payee.roblox_user_id) !== id) {
      problems.push(`${label}: the payee directory has Roblox ID ${payee.roblox_user_id} for ${payee.display_name}, not ${id}. Check which is right`);
      continue;
    }
    const [repeat] = payee ? await prisma.$queryRawUnsafe(
      `SELECT id, date_incurred FROM rev_expenses WHERE payee_id = $1 AND amount = $2::double precision AND lower(description) = lower($3) ORDER BY id DESC LIMIT 1`,
      payee.id, amount, what) : [];
    out.push({
      name, robloxUserId: id, amount, payeeId: payee ? payee.id : null, payeeName: payee ? payee.display_name : name,
      note: [!payee ? 'new payee' : payee.display_name.toLowerCase() !== name.toLowerCase() ? `on file as ${payee.display_name}` : '',
        repeat ? `same payment already logged ${repeat.date_incurred}` : ''].filter(Boolean).join('; ') || null,
    });
  }
  if (problems.length) return { error: 'Some payments could not be read. Nothing was proposed.', problems };

  const total = out.reduce((sum, e) => sum + e.amount, 0);
  const lines = out.map(e => `${e.payeeName}${e.robloxUserId ? ` (${e.robloxUserId})` : ''}: ${robux(e.amount)}${e.note ? ` [${e.note}]` : ''}`);
  return {
    payload: { description: what, category: cat, date: day, costSharePersonIds, audience, entries: out, total },
    summary: `Log ${out.length} expense${out.length === 1 ? '' : 's'}, ${robux(total)} Robux in all: ${what}`.slice(0, 300),
    after: { description: what, category: cat, date: day, 'split between': audience, payments: `\n${lines.join('\n')}`, total: `${robux(total)} Robux` },
    notes: out.filter(e => e.note).map(e => `${e.name}: ${e.note}`),
  };
}

// Writes an accepted batch. ref ties the rows to the card that approved them,
// so accepting twice (or a retry after a failure part way) never doubles one.
async function logExpenses(prisma, payload, ref, receiptUrl) {
  if (!enabled()) throw new Error('The Revenue page is not switched on');
  await ensureRevenueSchema(prisma);
  const audience = await audienceJson(prisma, payload.costSharePersonIds);
  const expenseIds = [];
  for (const [i, e] of payload.entries.entries()) {
    const sourceRef = `${ref}:${i}`;
    const [existing] = await prisma.$queryRawUnsafe(`SELECT id FROM rev_expenses WHERE source = 'assistant' AND source_ref = $1 LIMIT 1`, sourceRef);
    if (existing) { expenseIds.push(existing.id); continue; }
    let payee = await findPayee(prisma, { name: e.payeeName || e.name, roblox: e.robloxUserId });
    if (!payee) {
      [payee] = await prisma.$queryRawUnsafe(
        `INSERT INTO rev_payees (display_name, roblox_user_id) VALUES ($1, $2) ON CONFLICT (display_name) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING *`,
        e.name, e.robloxUserId || null);
    } else if (!payee.roblox_user_id && e.robloxUserId) {
      await prisma.$executeRawUnsafe(`UPDATE rev_payees SET roblox_user_id = $1 WHERE id = $2`, e.robloxUserId, payee.id);
    }
    const [row] = await prisma.$queryRawUnsafe(
      `INSERT INTO rev_expenses (date_incurred, month, description, category, amount, receipt_url, payee_id, source, source_ref, cost_share_person_ids)
       VALUES ($1, $2, $3, $4, $5::double precision, $6, $7::int, 'assistant', $8, $9) RETURNING id`,
      payload.date, `${payload.date.slice(0, 8)}01`, payload.description, payload.category, Number(e.amount), receiptUrl || null, payee.id, sourceRef, audience);
    expenseIds.push(row.id);
  }
  return { expenseIds, total: payload.total };
}

module.exports = {
  enabled, audienceOptions, robloxUserId, findPayee, robloxFor, recentPayments, logAssetPayout, unlogAssetPayout, paymentsTo, looksLikeDollars,
  parseRobux, expenseCategories, prepareExpenses, logExpenses, MAX_EXPENSES_PER_CARD,
};
