// "Revenue (new)": pay split from what the group has left at the end of the
// month, instead of from the month's revenue.
//
// The rule, as the owner set it:
//   - Standard-payout people (Ricky) are paid their % by Roblox before any
//     Robux reach the group, so the group only ever holds the rest - the
//     Manual people's %, plus any % nobody holds, which goes to the owner.
//   - A cost charged to "everyone" has already left the group, so it comes
//     out of everyone's share by their %. Nobody's payout names it.
//   - A cost pushed onto specific people also already left the group, but
//     only they carry it: it is added back to the pot before the split and
//     taken off their payout after. So the more the owner takes on, the
//     more everyone else gets.
// Payouts always add up to exactly what the group has left.
//
// It reads the same expense log, Salary Pay and dev payouts as the Revenue
// page, and their "who pays" field means the same thing there: nobody named
// is everyone, one or more people named carry it evenly between them. Dev
// payouts with nobody named stay the owner's, as on the Revenue page.

const R = require('./resolver');
const { RevenueError } = require('./store');

const MONTH = /^\d{4}-\d{2}-01$/;

// Every cost paid out of the group for the month, with who carries it.
async function costLines(d, month) {
  const lines = [];
  for (const r of await d.all(
    `SELECT id, date_incurred, description, category, amount, cost_share_person_ids FROM rev_expenses WHERE month = $1 ORDER BY date_incurred, id`, month)) {
    lines.push({ kind: 'expense', id: r.id, date: r.date_incurred, description: r.description, category: r.category, amount: r.amount, audience: R.deserializePersonIds(r.cost_share_person_ids) });
  }
  for (const r of await d.all(
    `SELECT tp.id, tp.date_paid, tp.description, tp.amount, tp.cost_share_person_ids, tm.name
     FROM rev_team_payments tp JOIN rev_team_members tm ON tm.id = tp.member_id
     WHERE substr(tp.date_paid, 1, 7) = substr($1, 1, 7) ORDER BY tp.date_paid, tp.id`, month)) {
    lines.push({ kind: 'team_payment', id: r.id, date: r.date_paid, description: r.description || `Salary Pay: ${r.name}`, category: 'Salary Pay', amount: r.amount, audience: R.deserializePersonIds(r.cost_share_person_ids) });
  }
  for (const r of await d.all(
    `SELECT id, name, category, monthly_amount, cost_share_person_ids FROM rev_team_members WHERE status = 'active' ORDER BY name, id`)) {
    lines.push({ kind: 'team_member', id: r.id, date: null, description: `Salary Pay: ${r.name}`, category: r.category, amount: r.monthly_amount, audience: R.deserializePersonIds(r.cost_share_person_ids) });
  }
  const ownerId = await R.getOwnerPersonId(d);
  for (const r of await d.all(
    `SELECT id, scripter_name, description, amount, date_paid, cost_share_person_ids FROM rev_dev_payouts WHERE substr(date_paid, 1, 7) = substr($1, 1, 7) ORDER BY date_paid, id`, month)) {
    const named = R.deserializePersonIds(r.cost_share_person_ids);
    lines.push({ kind: 'dev_payout', id: r.id, date: r.date_paid, description: `Dev payout: ${r.scripter_name}${r.description ? ` (${r.description})` : ''}`, category: 'Dev payout', amount: r.amount, audience: named || (ownerId ? [ownerId] : null) });
  }
  return lines;
}

async function splitMonth(d, month) {
  if (!MONTH.test(month)) throw new RevenueError(422, 'month must be YYYY-MM-01');
  const balance = await d.one(`SELECT * FROM rev_group_balances WHERE month = $1`, month);
  const ownerId = await R.getOwnerPersonId(d);

  const pool = [];
  const autoPaid = [];
  for (const person of await d.all(`SELECT * FROM rev_people ORDER BY id`)) {
    const r = await R.resolvePersonMonth(d, person, month);
    if (!r || !(r.effective_share_pct > 0)) continue;
    (r.payout_method === 'manual' ? pool : autoPaid).push({ person_id: r.person_id, name: r.name, share_pct: r.effective_share_pct });
  }
  const groupPct = Math.max(0, 1 - autoPaid.reduce((s, p) => s + p.share_pct, 0));
  const unheldPct = Math.max(0, groupPct - pool.reduce((s, p) => s + p.share_pct, 0));
  const owner = pool.find(p => p.person_id === ownerId);
  for (const p of pool) p.weight = p.share_pct + (p === owner ? unheldPct : 0);
  const totalWeight = pool.reduce((s, p) => s + p.weight, 0);
  const inPool = new Map(pool.map(p => [p.person_id, p]));

  // Who carries each cost. Anyone named who isn't in this month's split
  // (a Standard person, someone gone) is dropped; nobody left means everyone.
  const shared = [];
  const charges = new Map(pool.map(p => [p.person_id, []]));
  for (const line of await costLines(d, month)) {
    const carriers = (line.audience || []).filter(id => inPool.has(id));
    const { audience, ...item } = line;
    if (!carriers.length) { shared.push({ ...item, who: 'everyone' }); continue; }
    item.who = carriers;
    for (const id of carriers) charges.get(id).push({ ...item, charged: line.amount / carriers.length });
  }
  const sharedTotal = shared.reduce((s, l) => s + l.amount, 0);
  const chargedTotal = [...charges.values()].flat().reduce((s, c) => s + c.charged, 0);

  // The owner enters either what the group has left, or what it made before
  // costs. Entered as made, what's left moves as costs are added or dropped.
  const basis = balance ? balance.basis || 'remaining' : 'remaining';
  const entered = balance ? balance.remaining : null;
  const remaining = entered === null ? null : basis === 'made' ? entered - sharedTotal - chargedTotal : entered;
  const splitBase = remaining === null ? null : remaining + chargedTotal;
  const people = pool.map(p => {
    const fraction = totalWeight ? p.weight / totalWeight : 0;
    const items = charges.get(p.person_id);
    const charged = items.reduce((s, c) => s + c.charged, 0);
    return {
      person_id: p.person_id, name: p.name, share_pct: p.share_pct, unheld_pct: p === owner ? unheldPct : 0,
      split_fraction: fraction, is_owner: p === owner,
      split_amount: splitBase === null ? null : splitBase * fraction,
      shared_costs: sharedTotal * fraction,
      charged, charges: items.map(({ who, ...c }) => c),
      payout: splitBase === null ? null : splitBase * fraction - charged,
    };
  }).sort((a, b) => b.split_fraction - a.split_fraction || a.name.localeCompare(b.name));

  return {
    month, basis, entered, remaining, note: balance ? balance.note : null, updated_at: balance ? balance.updated_at : null,
    group_pct: groupPct, unheld_pct: unheldPct, owner_in_split: !!owner,
    auto_paid: autoPaid, shared_costs: shared, shared_total: sharedTotal,
    charged_lines: [...new Map([...charges.values()].flat().map(c => [`${c.kind}:${c.id}`, { kind: c.kind, id: c.id, date: c.date, description: c.description, category: c.category, amount: c.amount, who: c.who }])).values()],
    charged_total: chargedTotal, split_base: splitBase, people,
  };
}

async function setRemaining(d, month, body) {
  if (!MONTH.test(month)) throw new RevenueError(422, 'month must be YYYY-MM-01');
  if (body.remaining === null || body.remaining === '') {
    await d.run(`DELETE FROM rev_group_balances WHERE month = $1`, month);
    return;
  }
  const remaining = Number(body.remaining);
  if (!Number.isFinite(remaining) || remaining < 0) throw new RevenueError(422, 'remaining must be a number of Robux, 0 or more');
  const basis = body.basis ?? 'remaining';
  if (!['remaining', 'made'].includes(basis)) throw new RevenueError(422, 'basis must be remaining or made');
  await d.run(
    `INSERT INTO rev_group_balances (month, remaining, note, basis) VALUES ($1, $2::double precision, $3, $4)
     ON CONFLICT (month) DO UPDATE SET remaining = EXCLUDED.remaining, note = EXCLUDED.note, basis = EXCLUDED.basis,
       updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`,
    month, remaining, body.note ? String(body.note) : null, basis);
}

module.exports = { splitMonth, setRemaining };
