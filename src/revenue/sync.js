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

// A Roblox account for a dev who has never given one, when the payee
// directory already knows it.
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
    `INSERT INTO rev_expenses (date_incurred, month, description, category, amount, receipt_url, payee_id, source, source_ref)
     VALUES ($1, $2, $3, $4, $5::double precision, $6, $7::int, 'asset_payout', $8) RETURNING id`,
    date, `${date.slice(0, 8)}01`, String(payout.description || 'Asset payout').slice(0, 500), CATEGORY(), Number(payout.amount),
    payout.requestUrl || null, payee.id, payout.id);
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

module.exports = { enabled, robloxUserId, findPayee, robloxFor, recentPayments, logAssetPayout, unlogAssetPayout, paymentsTo, looksLikeDollars };
