// Resolver: the one place that turns dated facts into "what's true this
// month". A port of the resolver in the original Revenue Ops app.py, kept
// in the same order and with the same arithmetic so its results match the
// original's to the last decimal. Comments explaining the money rules are
// carried over from the original; they are the owner's rules, not ours.
//
// Every function takes `db`, a reader with all(sql, ...params) and
// one(sql, ...params). Readers made by store.reader() remember identical
// queries for the length of one request, since resolving a month asks the
// same questions (the month's expenses, who the owner is) once per person.

// Studio restructured starting this month: cost-share moved from individual
// per-person rules to an even split across every active shareholder. Months
// before this are untouched and keep using cost_share_rules as before.
const EVEN_SPLIT_COST_SHARE_FROM = '2026-08-01';

const DAY = 86400000;

// 'YYYY-MM-DD' (anything after the tenth character is ignored) -> UTC
// midnight in ms, or null when it is not a real date.
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').slice(0, 10));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}
const isoDate = t => new Date(t).toISOString().slice(0, 10);

// { first, last, days } for a 'YYYY-MM-01' month bucket string.
function monthBounds(month) {
  const y = parseInt(String(month).slice(0, 4), 10);
  const m = parseInt(String(month).slice(5, 7), 10);
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
    const err = new Error('month must be a YYYY-MM-01 date');
    err.status = 400;
    throw err;
  }
  const first = Date.UTC(y, m - 1, 1);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first, last: Date.UTC(y, m - 1, days), days };
}

const parseDateOr = (s, fallback) => (s ? parseDate(s) ?? fallback : fallback);

function resolveShareTerm(db, personId, month) {
  return db.one(
    `SELECT * FROM rev_share_terms
     WHERE person_id = $1 AND effective_from <= $2
       AND (effective_until IS NULL OR effective_until >= $2)
     ORDER BY effective_from DESC LIMIT 1`, personId, month);
}

// Every share_terms row for this person whose date range overlaps this month
// at all, each paired with how many of the month's days it covers. A term
// active for the whole month gets full weight; one that starts or ends
// mid-month is weighted by its actual day-overlap.
async function resolveShareTermsOverlapping(db, personId, month) {
  const { first, last, days } = monthBounds(month);
  const rows = await db.all(`SELECT * FROM rev_share_terms WHERE person_id = $1 ORDER BY effective_from, id`, personId);
  const out = [];
  for (const r of rows) {
    const from = parseDateOr(r.effective_from, first);
    const until = parseDateOr(r.effective_until, last);
    const start = Math.max(from, first);
    const end = Math.min(until, last);
    if (end < start) continue;
    out.push([r, Math.round((end - start) / DAY) + 1]);
  }
  return { overlaps: out, daysInMonth: days };
}

// 1.0 if the trigger already fully applied before this month started; 0 if
// it's still ahead; otherwise the fraction of this month's days from the
// trigger date through month-end.
function monthWeightFrom(triggerDate, month) {
  const { first, last, days } = monthBounds(month);
  const trigger = parseDateOr(triggerDate, null);
  if (trigger === null || trigger > last) return 0.0;
  if (trigger < first) return 1.0;
  return (Math.round((last - trigger) / DAY) + 1) / days;
}

async function resolveAdjustments(db, personId, month) {
  const rows = await db.all(`SELECT * FROM rev_adjustment_rules WHERE person_id = $1 ORDER BY id`, personId);
  const active = [];
  for (const r of rows) {
    let weight = 0.0;
    if (r.status === 'active') {
      weight = !r.effective_from ? 1.0 : monthWeightFrom(r.effective_from, month);
    } else if (r.trigger_type === 'date' && r.trigger_date) {
      weight = monthWeightFrom(r.trigger_date, month);
    }
    if (weight > 0) active.push({ ...r, weighted_delta_pct: r.delta_pct * weight });
  }
  return active;
}

async function resolveCostSharePct(db, personId, month) {
  if (month >= EVEN_SPLIT_COST_SHARE_FROM) {
    // Even split across active Manual-payout shareholders only - Standard
    // people are auto-paid by Roblox and don't owe toward update costs at
    // all. Recalculates automatically as Manual headcount changes.
    const term = await resolveShareTerm(db, personId, month);
    if (!term || term.payout_method !== 'manual') return 0.0;
    const row = await db.one(
      `SELECT COUNT(DISTINCT person_id)::int AS n FROM rev_share_terms
       WHERE effective_from <= $1 AND (effective_until IS NULL OR effective_until >= $1)
         AND payout_method = 'manual'`, month);
    return row.n ? 1.0 / row.n : 0.0;
  }
  const rows = await db.all(
    `SELECT * FROM rev_cost_share_rules
     WHERE person_id = $1 AND effective_from <= $2
       AND (effective_until IS NULL OR effective_until >= $2)
     ORDER BY id`, personId, month);
  return rows.reduce((sum, r) => sum + r.pct, 0);
}

// Who owes cost-share this month. From the even-split month on, that's
// active Manual-payout shareholders only (Standard people owe nothing);
// before it, only people with an explicit rule.
async function resolveCostSharePersonIds(db, month) {
  const rows = month >= EVEN_SPLIT_COST_SHARE_FROM
    ? await db.all(
      `SELECT DISTINCT person_id FROM rev_share_terms
       WHERE effective_from <= $1 AND (effective_until IS NULL OR effective_until >= $1)
         AND payout_method = 'manual' ORDER BY person_id`, month)
    : await db.all(
      `SELECT DISTINCT person_id FROM rev_cost_share_rules
       WHERE effective_from <= $1 AND (effective_until IS NULL OR effective_until >= $1) ORDER BY person_id`, month);
  return rows.map(r => r.person_id);
}

// None/empty means "no override" - falls back to the default even-split
// pool. Only a non-empty list is worth storing as an explicit override.
const serializePersonIds = ids => (Array.isArray(ids) && ids.length ? JSON.stringify(ids.map(Number)) : null);
function deserializePersonIds(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch { return null; }
}
// A row with cost_share_person_ids turned back into a list (or null).
const withCostShareIds = row => ({ ...row, cost_share_person_ids: deserializePersonIds(row.cost_share_person_ids) });

// Who splits one line item's cost: its own explicit override if it has one,
// otherwise the default even-split pool. Returns a Set.
function lineAudience(rawPersonIds, defaultAudience) {
  const override = deserializePersonIds(rawPersonIds);
  return override ? new Set(override) : defaultAudience;
}

// Update costs for the month: the expense log plus Team Payments (every
// active member's recurring monthly due, plus any one-time payouts logged
// that month). This is the base that cost-share rules are calculated against.
async function monthTotalExpenses(db, month) {
  let total = (await db.one(`SELECT COALESCE(SUM(amount), 0) AS total FROM rev_expenses WHERE month = $1`, month)).total;
  total += (await db.one(`SELECT COALESCE(SUM(monthly_amount), 0) AS total FROM rev_team_members WHERE status = 'active'`)).total;
  total += (await db.one(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM rev_team_payments WHERE substr(date_paid, 1, 7) = substr($1, 1, 7)`, month)).total;
  return total;
}

// Amount of update costs this person owes for the month. Each expense,
// one-time Team Payment, and recurring Team due can name its own list of
// people to split its cost across - defaulting to every active Manual-payout
// shareholder when left unset.
async function resolveCostShareDeduction(db, personId, month) {
  if (month < EVEN_SPLIT_COST_SHARE_FROM) {
    // Pre-restructure months keep the old per-person pct-of-total rule.
    return (await resolveCostSharePct(db, personId, month)) * (await monthTotalExpenses(db, month));
  }
  const term = await resolveShareTerm(db, personId, month);
  if (!term || term.payout_method !== 'manual') return 0.0;

  const defaultAudience = new Set(await resolveCostSharePersonIds(db, month));
  let total = 0.0;
  const lineItems = [
    await db.all(`SELECT amount, cost_share_person_ids FROM rev_expenses WHERE month = $1 ORDER BY id`, month),
    await db.all(`SELECT amount, cost_share_person_ids FROM rev_team_payments WHERE substr(date_paid, 1, 7) = substr($1, 1, 7) ORDER BY id`, month),
    await db.all(`SELECT monthly_amount AS amount, cost_share_person_ids FROM rev_team_members WHERE status = 'active' ORDER BY id`),
  ];
  for (const rows of lineItems) {
    for (const row of rows) {
      const audience = lineAudience(row.cost_share_person_ids, defaultAudience);
      if (audience.size && audience.has(personId)) total += row.amount / audience.size;
    }
  }
  return total;
}

async function monthNetRevenue(db, month) {
  const row = await db.one(`SELECT * FROM rev_monthly_revenue WHERE month = $1`, month);
  if (!row) return { gross: 0.0, net: 0.0 };
  return { gross: row.gross_revenue, net: row.gross_revenue * (1 - row.platform_fee_pct) };
}

// Which person row (if any) represents the studio owner. Everything
// downstream treats that person as a normal roster row EXCEPT they also
// collect everyone else's "owed to me" contribution repayments.
async function getOwnerPersonId(db) {
  const row = await db.one(`SELECT value FROM rev_settings WHERE key = 'owner_person_id'`);
  return row ? parseInt(row.value, 10) : null;
}

// Every "owed to me" contribution logged against anyone this month. A
// straight transfer within the fixed revenue pool: the payer's own payout is
// already reduced by this same amount, so adding it to the owner's payout
// doesn't create money.
async function resolveOwnerRepayments(db, month) {
  return (await db.one(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM rev_contributions WHERE effective_month = $1 AND benefit_type = 'owner'`, month)).total;
}

// This specific person's share of dev payouts fronted this month. Each dev
// payout can name its own list of people responsible for it; with no
// override it defaults to 100% the owner - Robux already withdrawn from
// group funds, comes straight off that person's own resolved payout, and
// deliberately stays out of total_expenses/cost-share.
async function resolveDevPayoutsOwed(db, personId, month) {
  const ownerId = await getOwnerPersonId(db);
  let total = 0.0;
  const rows = await db.all(
    `SELECT amount, cost_share_person_ids FROM rev_dev_payouts WHERE substr(date_paid, 1, 7) = substr($1, 1, 7) ORDER BY id`, month);
  for (const row of rows) {
    const audience = deserializePersonIds(row.cost_share_person_ids);
    if (audience) {
      if (audience.includes(personId)) total += row.amount / audience.length;
    } else if (personId === ownerId) {
      total += row.amount;
    }
  }
  return total;
}

// Full resolution for one person in one month: share %, method, deductions, final payout.
async function resolvePersonMonth(db, person, month) {
  const { overlaps, daysInMonth } = await resolveShareTermsOverlapping(db, person.id, month);
  if (!overlaps.length) return null;
  // "Current state" fields (payout method, contract status, which term to
  // cite) come from whichever overlapping term started most recently.
  let term = overlaps[0][0];
  for (const [r] of overlaps) if (r.effective_from > term.effective_from) term = r;
  const weightedBasePct = overlaps.reduce((sum, [r, days]) => sum + r.share_pct * days, 0) / daysInMonth;
  const adjustments = await resolveAdjustments(db, person.id, month);
  const delta = adjustments.reduce((sum, a) => sum + a.weighted_delta_pct, 0);
  const effectivePct = weightedBasePct + delta;

  const { net } = await monthNetRevenue(db, month);
  const grossShare = net * effectivePct;

  const contributionDeduction = (await db.one(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM rev_contributions WHERE person_id = $1 AND effective_month = $2`, person.id, month)).total;
  // "owner" contributions are debts they owe the owner personally -
  // deducting it is how the owner gets repaid, so it counts toward the final
  // cut. "self" contributions never touch the owner at all.
  const ownerContributionDeduction = (await db.one(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM rev_contributions
     WHERE person_id = $1 AND effective_month = $2 AND benefit_type = 'owner'`, person.id, month)).total;

  const totalExpenses = await monthTotalExpenses(db, month);
  const costShareDeduction = await resolveCostShareDeduction(db, person.id, month);
  // Blended effective % purely for display.
  const costSharePct = totalExpenses ? costShareDeduction / totalExpenses : 0.0;

  let finalPayout = grossShare - contributionDeduction - costShareDeduction;
  // What to use instead of final_payout when computing the final cut - only
  // "owner" contributions reduce this.
  let finalPayoutForCut = grossShare - ownerContributionDeduction - costShareDeduction;

  // If this row is the owner, add back every "owed to me" contribution
  // logged against anyone this month.
  let ownerRepaymentsReceived = 0.0;
  if ((await getOwnerPersonId(db)) === person.id) {
    ownerRepaymentsReceived = await resolveOwnerRepayments(db, month);
    finalPayout += ownerRepaymentsReceived;
    finalPayoutForCut += ownerRepaymentsReceived;
  }

  // Dev payouts this person is personally on the hook for - already-withdrawn
  // Robux, comes off final_payout only.
  const devPayoutsFronted = await resolveDevPayoutsOwed(db, person.id, month);
  finalPayout -= devPayoutsFronted;

  const statusRow = await db.one(`SELECT status FROM rev_payment_status WHERE person_id = $1 AND month = $2`, person.id, month);

  return {
    person_id: person.id,
    name: person.name,
    roblox_handle: person.roblox_handle,
    category: person.category,
    fired_from: person.fired_from,
    share_term_id: term.id,
    base_share_pct: weightedBasePct,
    adjustment_delta_pct: delta,
    effective_share_pct: effectivePct,
    payout_method: term.payout_method,
    contract_status: term.contract_status,
    gross_share: grossShare,
    contribution_deduction: contributionDeduction,
    owner_contribution_deduction: ownerContributionDeduction,
    cost_share_pct: costSharePct,
    cost_share_deduction: costShareDeduction,
    final_payout: finalPayout,
    final_payout_for_cut: finalPayoutForCut,
    owner_repayments_received: ownerRepaymentsReceived,
    dev_payouts_fronted: devPayoutsFronted,
    paid_status: statusRow ? statusRow.status : 'unpaid',
    applied_adjustments: adjustments,
  };
}

module.exports = {
  EVEN_SPLIT_COST_SHARE_FROM, parseDate, isoDate, monthBounds, DAY,
  resolveShareTerm, resolveShareTermsOverlapping, resolveAdjustments, resolveCostSharePct, resolveCostSharePersonIds,
  serializePersonIds, deserializePersonIds, withCostShareIds, lineAudience,
  monthTotalExpenses, resolveCostShareDeduction, monthNetRevenue, getOwnerPersonId, resolveOwnerRepayments,
  resolveDevPayoutsOwed, resolvePersonMonth,
};
