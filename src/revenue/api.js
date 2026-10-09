// The Revenue page's API: a port of the original Revenue Ops app.py routes.
// Paths, request bodies and response shapes are the original's, so the
// original front end runs against this unchanged; errors come back as
// { detail } like the original's. Mounted at /api/revenue by routes/revenue.js,
// which also does the sign-in and access checks the original never had.

const express = require('express');
const R = require('./resolver');
const { RevenueError, handle, reader, transaction, insert, patch, remove, sent, required, coerce } = require('./store');

// SQLite's date(x, '-1 day'): the day before, or null when x is not a date.
const dayBefore = s => { const t = R.parseDate(s); return t === null ? null : R.isoDate(t - R.DAY); };
const monthOf = dateIncurred => `${String(dateIncurred).slice(0, 8)}01`;

function buildRouter(getPrisma) {
  const router = express.Router();
  const db = () => handle(getPrisma());
  const rd = () => reader(getPrisma());
  const tx = fn => transaction(getPrisma(), fn);

  const h = fn => async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent) res.json(result === undefined ? { ok: true } : result);
    } catch (err) {
      if (err instanceof RevenueError || err.status === 400) return res.status(err.status).json({ detail: err.detail || err.message });
      console.error(`[Revenue ${req.method} ${req.path}]`, err.message);
      res.status(500).json({ detail: 'Internal Server Error' });
    }
  };
  const get = (path, fn) => router.get(path, h(fn));
  const post = (path, fn) => router.post(path, h(fn));
  const patchRoute = (path, fn) => router.patch(path, h(fn));
  const del = (path, fn) => router.delete(path, h(fn));
  const id = req => Number(req.params.id);
  const people = d => d.all(`SELECT * FROM rev_people ORDER BY id`);

  // ── payees: everyone ever paid (display name + Roblox user id) ────────────

  get('/payees', req => (req.query.search
    ? db().all(`SELECT * FROM rev_payees WHERE display_name ILIKE $1 ORDER BY display_name`, `%${req.query.search}%`)
    : db().all(`SELECT * FROM rev_payees ORDER BY display_name`)));

  post('/payees', async req => {
    required(req.body, ['display_name']);
    const name = String(req.body.display_name).trim();
    if (!name) throw new RevenueError(400, "Display name can't be empty");
    const d = db();
    const existing = await d.one(`SELECT * FROM rev_payees WHERE display_name = $1`, name);
    if (existing) return { id: existing.id };
    return { id: await insert(d, 'payees', { display_name: name, roblox_user_id: req.body.roblox_user_id ?? null }) };
  });

  patchRoute('/payees/:id', async req => {
    await patch(db(), 'payees', id(req), sent(req.body, ['display_name', 'roblox_user_id']), ['display_name', 'roblox_user_id'], 'Payee not found');
  });

  // Every event tied to this payee - expenses, Salary Pay, dev payouts, and,
  // if linked to a roster person, their resolved revenue-share payout per month.
  get('/payees/:id/history', async req => {
    const d = rd();
    const payee = await d.one(`SELECT * FROM rev_payees WHERE id = $1`, id(req));
    if (!payee) throw new RevenueError(404, 'Payee not found');
    const expenses = await d.all(`SELECT * FROM rev_expenses WHERE payee_id = $1 ORDER BY date_incurred, id`, payee.id);
    const members = await d.all(`SELECT * FROM rev_team_members WHERE payee_id = $1 ORDER BY id`, payee.id);
    const salaryPayments = [];
    for (const m of members) salaryPayments.push(...await d.all(`SELECT * FROM rev_team_payments WHERE member_id = $1 ORDER BY date_paid, id`, m.id));
    const devPayouts = await d.all(`SELECT * FROM rev_dev_payouts WHERE payee_id = $1 ORDER BY date_paid, id`, payee.id);
    const rosterPerson = await d.one(`SELECT * FROM rev_people WHERE payee_id = $1 ORDER BY id LIMIT 1`, payee.id);
    const rosterPayouts = [];
    if (rosterPerson) {
      for (const m of await d.all(`SELECT month FROM rev_monthly_revenue ORDER BY month`)) {
        const resolved = await R.resolvePersonMonth(d, rosterPerson, m.month);
        if (resolved) rosterPayouts.push({ ...resolved, month: m.month });
      }
    }
    return {
      payee, roster_person: rosterPerson, expenses, salary_recurring: members, salary_payments: salaryPayments,
      dev_payouts: devPayouts, roster_payouts: rosterPayouts,
    };
  });

  // ── people ────────────────────────────────────────────────────────────────

  get('/people', () => people(db()));

  post('/people', async req => {
    required(req.body, ['name']);
    return { id: await insert(db(), 'people', {
      name: req.body.name, roblox_handle: req.body.roblox_handle ?? null, discord_id: req.body.discord_id ?? null, category: req.body.category ?? 'Developer',
    }) };
  });

  patchRoute('/people/:id', async req => {
    const fields = ['name', 'roblox_handle', 'discord_id', 'category'];
    await patch(db(), 'people', id(req), sent(req.body, fields), fields, 'Person not found');
  });

  // Takes someone off the roster from a given month forward without touching
  // anything before it. Always lands on the 1st of the month it's given.
  post('/people/:id/fire', async req => {
    required(req.body, ['effective_from']);
    const t = R.parseDate(req.body.effective_from);
    if (t === null) throw new RevenueError(400, 'effective_from must be a YYYY-MM-DD date');
    const fireDate = `${R.isoDate(t).slice(0, 8)}01`;
    return tx(async d => {
      const existing = await d.one(`SELECT * FROM rev_people WHERE id = $1`, id(req));
      if (!existing) throw new RevenueError(404, 'Person not found');
      if (existing.fired_from) throw new RevenueError(400, `Already fired from ${existing.fired_from} - reinstate first to change the date`);
      await d.run(
        `UPDATE rev_share_terms SET effective_until = $1 WHERE person_id = $2 AND (effective_until IS NULL OR effective_until >= $3)`,
        dayBefore(fireDate), existing.id, fireDate);
      await d.run(`UPDATE rev_people SET fired_from = $1 WHERE id = $2`, fireDate, existing.id);
      return { ok: true, fired_from: fireDate };
    });
  });

  // Undoes fire: clears fired_from and reopens their most recent share_terms row.
  post('/people/:id/reinstate', req => tx(async d => {
    const existing = await d.one(`SELECT * FROM rev_people WHERE id = $1`, id(req));
    if (!existing) throw new RevenueError(404, 'Person not found');
    if (!existing.fired_from) throw new RevenueError(400, "Person isn't fired");
    await d.run(
      `UPDATE rev_share_terms SET effective_until = NULL
       WHERE id = (SELECT id FROM rev_share_terms WHERE person_id = $1 ORDER BY effective_from DESC, id DESC LIMIT 1)`, existing.id);
    await d.run(`UPDATE rev_people SET fired_from = NULL WHERE id = $1`, existing.id);
    return { ok: true };
  }));

  // Permanently removes someone and everything logged against them, from
  // every month. Their payee directory entry is left alone.
  del('/people/:id', req => tx(async d => {
    const existing = await d.one(`SELECT * FROM rev_people WHERE id = $1`, id(req));
    if (!existing) throw new RevenueError(404, 'Person not found');
    if ((await R.getOwnerPersonId(d)) === existing.id) {
      throw new RevenueError(400, 'This person is set as the owner - point /api/owner-config at someone else first');
    }
    for (const table of ['share_terms', 'adjustment_rules', 'contributions', 'cost_share_rules', 'payment_status', 'cost_share_collections']) {
      await d.run(`DELETE FROM rev_${table} WHERE person_id = $1`, existing.id);
    }
    await d.run(`DELETE FROM rev_notes WHERE entity_type = 'person' AND entity_id = $1`, existing.id);
    // Drop them from any line item's explicit cost-share audience too, so the
    // people left on it split the whole amount.
    for (const table of ['expenses', 'team_payments', 'team_members', 'dev_payouts']) {
      for (const row of await d.all(`SELECT id, cost_share_person_ids FROM rev_${table} WHERE cost_share_person_ids IS NOT NULL`)) {
        const ids = R.deserializePersonIds(row.cost_share_person_ids);
        if (ids && ids.includes(existing.id)) {
          await d.run(`UPDATE rev_${table} SET cost_share_person_ids = $1 WHERE id = $2`, R.serializePersonIds(ids.filter(i => i !== existing.id)), row.id);
        }
      }
    }
    await d.run(`DELETE FROM rev_people WHERE id = $1`, existing.id);
    return { ok: true };
  }));

  // ── share terms (versioned % / payout method / contract status) ───────────

  get('/people/:id/share-terms', req => db().all(`SELECT * FROM rev_share_terms WHERE person_id = $1 ORDER BY effective_from, id`, id(req)));

  post('/share-terms', req => {
    required(req.body, ['person_id', 'share_pct', 'effective_from']);
    return tx(async d => {
      // Close out whatever term was open before this one starts.
      await d.run(`UPDATE rev_share_terms SET effective_until = $1 WHERE person_id = $2 AND effective_until IS NULL`,
        dayBefore(req.body.effective_from), Number(req.body.person_id));
      return { id: await insert(d, 'share_terms', {
        person_id: req.body.person_id, share_pct: req.body.share_pct, payout_method: req.body.payout_method ?? 'standard',
        contract_status: req.body.contract_status ?? 'active', effective_from: req.body.effective_from, effective_until: null,
      }) };
    });
  });

  // What the Roster tab's Edit panel and payout-method toggle save through:
  // changes someone's %, payout method, and/or contract status from the given
  // month forward, leaving every earlier month exactly as it was.
  post('/people/:id/share-terms-from-month', req => {
    required(req.body, ['month']);
    const bounds = R.monthBounds(req.body.month);
    const first = R.isoDate(bounds.first);
    const last = R.isoDate(bounds.last);
    const personId = id(req);
    return tx(async d => {
      if (!await d.one(`SELECT 1 AS x FROM rev_people WHERE id = $1`, personId)) throw new RevenueError(404, 'Person not found');

      // A term that started before the month and is still running gets split
      // at the month's 1st first, so the change never reaches back.
      const running = await d.all(
        `SELECT * FROM rev_share_terms WHERE person_id = $1 AND effective_from < $2
           AND (effective_until IS NULL OR effective_until >= $2) ORDER BY id`, personId, first);
      for (const t of running) {
        await d.run(`UPDATE rev_share_terms SET effective_until = $1 WHERE id = $2`, dayBefore(first), t.id);
        await insert(d, 'share_terms', {
          person_id: personId, share_pct: t.share_pct, payout_method: t.payout_method, contract_status: t.contract_status,
          effective_from: first, effective_until: t.effective_until,
        });
      }

      const inMonth = await d.all(
        `SELECT * FROM rev_share_terms WHERE person_id = $1 AND effective_from >= $2 AND effective_from <= $3 ORDER BY effective_from, id`,
        personId, first, last);
      // Throwing here rolls back the split above.
      if (!inMonth.length) throw new RevenueError(400, 'No share terms in effect for this person that month');

      if (req.body.payout_method !== undefined && req.body.payout_method !== null) {
        await d.run(`UPDATE rev_share_terms SET payout_method = $1 WHERE person_id = $2 AND effective_from >= $3`, String(req.body.payout_method), personId, first);
      }
      if (req.body.contract_status !== undefined && req.body.contract_status !== null) {
        await d.run(`UPDATE rev_share_terms SET contract_status = $1 WHERE person_id = $2 AND effective_from >= $3`, String(req.body.contract_status), personId, first);
      }
      if (req.body.share_pct !== undefined && req.body.share_pct !== null) {
        // The month's latest term is the one that carries on afterward - it
        // takes over the whole month at the new %, and anything else that
        // started within the month is folded into it.
        const keep = inMonth[inMonth.length - 1];
        await d.run(`UPDATE rev_share_terms SET share_pct = $1::double precision, effective_from = $2 WHERE id = $3`,
          coerce('share_terms', 'share_pct', req.body.share_pct), first, keep.id);
        for (const t of inMonth.slice(0, -1)) await d.run(`DELETE FROM rev_share_terms WHERE id = $1`, t.id);
      }
      return { ok: true };
    });
  });

  patchRoute('/share-terms/:id', async req => {
    const fields = ['share_pct', 'payout_method', 'contract_status', 'effective_from', 'effective_until'];
    await patch(db(), 'share_terms', id(req), sent(req.body, fields), fields, 'Share term not found');
  });

  // ── adjustment rules ──────────────────────────────────────────────────────

  get('/adjustment-rules', () => db().all(
    `SELECT ar.*, p.name AS person_name FROM rev_adjustment_rules ar JOIN rev_people p ON p.id = ar.person_id ORDER BY ar.id`));

  const RULE_FIELDS = ['person_id', 'rule_type', 'delta_pct', 'trigger_type', 'trigger_date', 'trigger_threshold', 'effective_from', 'description'];
  post('/adjustment-rules', async req => {
    required(req.body, ['person_id', 'rule_type', 'delta_pct', 'trigger_type']);
    const values = Object.fromEntries(RULE_FIELDS.map(f => [f, req.body[f] ?? null]));
    return { id: await insert(db(), 'adjustment_rules', { ...values, status: 'pending' }) };
  });

  patchRoute('/adjustment-rules/:id', async req => {
    const d = db();
    const existing = await d.one(`SELECT * FROM rev_adjustment_rules WHERE id = $1`, id(req));
    if (!existing) throw new RevenueError(404, 'Rule not found');
    // Unlike the other PATCHes, a null here means "leave it", as in the original.
    await d.run(`UPDATE rev_adjustment_rules SET status = $1, effective_from = $2 WHERE id = $3`,
      req.body.status ?? existing.status, req.body.effective_from ?? existing.effective_from, existing.id);
  });

  router.put('/adjustment-rules/:id', h(async req => {
    required(req.body, ['person_id', 'rule_type', 'delta_pct', 'trigger_type']);
    const d = db();
    const existing = await d.one(`SELECT * FROM rev_adjustment_rules WHERE id = $1`, id(req));
    if (!existing) throw new RevenueError(404, 'Rule not found');
    const values = Object.fromEntries(RULE_FIELDS.map(f => [f, req.body[f] ?? null]));
    await patch(d, 'adjustment_rules', existing.id, { ...values, status: req.body.status ?? existing.status }, [...RULE_FIELDS, 'status'], 'Rule not found');
  }));

  del('/adjustment-rules/:id', async req => { await remove(db(), 'adjustment_rules', id(req), 'Rule not found'); });

  // ── contributions ─────────────────────────────────────────────────────────

  get('/contributions', req => (req.query.month
    ? db().all(`SELECT c.*, p.name AS person_name FROM rev_contributions c JOIN rev_people p ON p.id = c.person_id
                WHERE c.effective_month = $1 ORDER BY c.date_logged, c.id`, req.query.month)
    : db().all(`SELECT c.*, p.name AS person_name FROM rev_contributions c JOIN rev_people p ON p.id = c.person_id ORDER BY c.date_logged, c.id`)));

  post('/contributions', async req => {
    required(req.body, ['person_id', 'amount', 'date_logged', 'effective_month']);
    return { id: await insert(db(), 'contributions', {
      person_id: req.body.person_id, amount: req.body.amount, date_logged: req.body.date_logged, effective_month: req.body.effective_month,
      purpose: req.body.purpose ?? null, benefit_type: req.body.benefit_type ?? 'owner', link_url: req.body.link_url ?? null,
    }) };
  });

  patchRoute('/contributions/:id', async req => {
    const fields = ['person_id', 'amount', 'date_logged', 'effective_month', 'purpose', 'status', 'benefit_type', 'link_url'];
    await patch(db(), 'contributions', id(req), sent(req.body, fields), fields, 'Contribution not found');
  });

  del('/contributions/:id', async req => { await remove(db(), 'contributions', id(req), 'Contribution not found'); });

  // ── cost-share rules ──────────────────────────────────────────────────────

  get('/cost-share-rules', () => db().all(
    `SELECT csr.*, p.name AS person_name FROM rev_cost_share_rules csr JOIN rev_people p ON p.id = csr.person_id ORDER BY csr.id`));

  post('/cost-share-rules', async req => {
    required(req.body, ['person_id', 'pct', 'effective_from']);
    return { id: await insert(db(), 'cost_share_rules', {
      person_id: req.body.person_id, pct: req.body.pct, linked_item: req.body.linked_item ?? null,
      effective_from: req.body.effective_from, effective_until: req.body.effective_until ?? null,
    }) };
  });

  patchRoute('/cost-share-rules/:id', async req => {
    const fields = ['pct', 'linked_item', 'effective_from', 'effective_until'];
    await patch(db(), 'cost_share_rules', id(req), sent(req.body, fields), fields, 'Cost-share rule not found');
  });

  // ── expenses ──────────────────────────────────────────────────────────────

  get('/expenses', async req => (req.query.month
    ? await db().all(`SELECT * FROM rev_expenses WHERE month = $1 ORDER BY date_incurred, id`, req.query.month)
    : await db().all(`SELECT * FROM rev_expenses ORDER BY date_incurred, id`)).map(R.withCostShareIds));

  post('/expenses', async req => {
    required(req.body, ['date_incurred', 'description', 'amount']);
    return { id: await insert(db(), 'expenses', {
      date_incurred: req.body.date_incurred, month: monthOf(req.body.date_incurred), description: req.body.description,
      category: req.body.category ?? 'Other', amount: req.body.amount, receipt_url: req.body.receipt_url ?? null,
      cost_share_person_ids: R.serializePersonIds(req.body.cost_share_person_ids), payee_id: req.body.payee_id ?? null,
    }) };
  });

  // Rows that carry a cost-share audience store it as JSON text.
  const withAudience = updates => ('cost_share_person_ids' in updates
    ? { ...updates, cost_share_person_ids: R.serializePersonIds(updates.cost_share_person_ids) } : updates);

  patchRoute('/expenses/:id', async req => {
    const fields = ['date_incurred', 'description', 'category', 'amount', 'receipt_url', 'cost_share_person_ids', 'payee_id'];
    const d = db();
    const existing = await d.one(`SELECT * FROM rev_expenses WHERE id = $1`, id(req));
    if (!existing) throw new RevenueError(404, 'Expense not found');
    const updates = withAudience(sent(req.body, fields));
    const merged = { ...existing, ...updates };
    await patch(d, 'expenses', existing.id, { ...updates, month: monthOf(merged.date_incurred) }, [...fields, 'month'], 'Expense not found');
  });

  // Not in the original (an expense could only be edited, never removed).
  del('/expenses/:id', async req => { await remove(db(), 'expenses', id(req), 'Expense not found'); });

  // ── monthly revenue ───────────────────────────────────────────────────────

  get('/monthly-revenue', () => db().all(`SELECT * FROM rev_monthly_revenue ORDER BY month`));

  post('/monthly-revenue', async req => {
    required(req.body, ['month', 'gross_revenue']);
    const month = String(req.body.month);
    const gross = coerce('monthly_revenue', 'gross_revenue', req.body.gross_revenue);
    const fee = coerce('monthly_revenue', 'platform_fee_pct', req.body.platform_fee_pct ?? 0);
    // A plain upsert, as in the original (SQLite also uses up an id when it updates).
    await db().run(
      `INSERT INTO rev_monthly_revenue (month, gross_revenue, platform_fee_pct) VALUES ($1, $2::double precision, $3::double precision)
       ON CONFLICT (month) DO UPDATE SET gross_revenue = EXCLUDED.gross_revenue, platform_fee_pct = EXCLUDED.platform_fee_pct`, month, gross, fee);
  });

  // ── notes (attach to anything) ────────────────────────────────────────────

  get('/notes', req => (req.query.entity_type && req.query.entity_id !== undefined
    ? db().all(`SELECT * FROM rev_notes WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC, id`, req.query.entity_type, Number(req.query.entity_id))
    : db().all(`SELECT * FROM rev_notes ORDER BY created_at DESC, id`)));

  post('/notes', async req => {
    required(req.body, ['entity_type', 'entity_id', 'body']);
    return { id: await insert(db(), 'notes', { entity_type: req.body.entity_type, entity_id: req.body.entity_id, body: req.body.body }) };
  });

  // ── paid / collected flags ────────────────────────────────────────────────

  const flag = (path, table, key) => post(path, async req => {
    required(req.body, [key, 'month', 'status']);
    const d = db();
    const who = coerce(table, key, req.body[key]);
    const updated = await d.run(`UPDATE rev_${table} SET status = $3 WHERE ${key} = $1::int AND month = $2`, who, String(req.body.month), String(req.body.status));
    if (!updated) {
      await d.run(
        `INSERT INTO rev_${table} (${key}, month, status) VALUES ($1::int, $2, $3)
         ON CONFLICT (${key}, month) DO UPDATE SET status = EXCLUDED.status`, who, String(req.body.month), String(req.body.status));
    }
  });
  flag('/payment-status', 'payment_status', 'person_id');
  flag('/team-payment-status', 'team_payment_status', 'member_id');
  flag('/cost-share-collections', 'cost_share_collections', 'person_id');

  // ── Salary Pay: flat monthly rates and one-off payouts, by category ───────

  get('/salary-categories', () => db().all(`SELECT * FROM rev_salary_categories ORDER BY name`));

  post('/salary-categories', async req => {
    required(req.body, ['name']);
    const name = String(req.body.name).trim();
    if (!name) throw new RevenueError(400, "Category name can't be empty");
    const d = db();
    const existing = await d.one(`SELECT * FROM rev_salary_categories WHERE name = $1`, name);
    return { id: existing ? existing.id : await insert(d, 'salary_categories', { name }) };
  });

  del('/salary-categories/:id', async req => {
    const d = db();
    const existing = await d.one(`SELECT * FROM rev_salary_categories WHERE id = $1`, id(req));
    if (!existing) throw new RevenueError(404, 'Category not found');
    const { n } = await d.one(`SELECT COUNT(*)::int AS n FROM rev_team_members WHERE category = $1`, existing.name);
    if (n) throw new RevenueError(400, `Can't delete '${existing.name}' - ${n} people are still in it. Move or remove them first.`);
    await d.run(`DELETE FROM rev_salary_categories WHERE id = $1`, existing.id);
  });

  get('/team-members', async req => (req.query.category
    ? await db().all(`SELECT * FROM rev_team_members WHERE category = $1 ORDER BY name, id`, req.query.category)
    : await db().all(`SELECT * FROM rev_team_members ORDER BY category, name, id`)).map(R.withCostShareIds));

  post('/team-members', async req => {
    required(req.body, ['name', 'category']);
    return { id: await insert(db(), 'team_members', {
      name: req.body.name, category: req.body.category, monthly_amount: req.body.monthly_amount ?? 0,
      cost_share_person_ids: R.serializePersonIds(req.body.cost_share_person_ids), payee_id: req.body.payee_id ?? null,
    }) };
  });

  patchRoute('/team-members/:id', async req => {
    const fields = ['name', 'category', 'monthly_amount', 'status', 'cost_share_person_ids', 'payee_id'];
    await patch(db(), 'team_members', id(req), withAudience(sent(req.body, fields)), fields, 'Team member not found');
  });

  del('/team-members/:id', req => tx(async d => {
    const existing = await d.one(`SELECT * FROM rev_team_members WHERE id = $1`, id(req));
    if (!existing) throw new RevenueError(404, 'Team member not found');
    for (const table of ['team_payment_status', 'team_payments', 'salary_repayments']) await d.run(`DELETE FROM rev_${table} WHERE member_id = $1`, existing.id);
    await d.run(`DELETE FROM rev_team_members WHERE id = $1`, existing.id);
    return { ok: true };
  }));

  // Each active team member's flat monthly rate plus whether it's been
  // marked paid for this month.
  get('/team-recurring/:month', async req => {
    const d = rd();
    const members = req.query.category
      ? await d.all(`SELECT * FROM rev_team_members WHERE status = 'active' AND category = $1 ORDER BY name, id`, req.query.category)
      : await d.all(`SELECT * FROM rev_team_members WHERE status = 'active' ORDER BY name, id`);
    const out = [];
    for (const m of members) {
      const status = await d.one(`SELECT status FROM rev_team_payment_status WHERE member_id = $1 AND month = $2`, m.id, req.params.month);
      const repaid = (await d.one(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM rev_salary_repayments WHERE member_id = $1 AND month = $2 AND status = 'paid'`, m.id, req.params.month)).total;
      out.push({
        member_id: m.id, name: m.name, category: m.category, monthly_amount: m.monthly_amount,
        paid_status: status ? status.status : 'unpaid', repaid_total: repaid, remaining_owed: m.monthly_amount - repaid,
      });
    }
    return out;
  });

  // The one-time-payout side of Salary Pay.
  get('/team-payments', async req => {
    const where = [];
    const params = [];
    if (req.query.category) { params.push(req.query.category); where.push(`tm.category = $${params.length}`); }
    if (req.query.month) { params.push(req.query.month); where.push(`substr(tp.date_paid, 1, 7) = substr($${params.length}, 1, 7)`); }
    return (await db().all(
      `SELECT tp.*, tm.name AS member_name, tm.category AS category
       FROM rev_team_payments tp JOIN rev_team_members tm ON tm.id = tp.member_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY tp.date_paid, tp.id`, ...params)).map(R.withCostShareIds);
  });

  post('/team-payments', async req => {
    required(req.body, ['member_id', 'date_paid', 'amount']);
    return { id: await insert(db(), 'team_payments', {
      member_id: req.body.member_id, date_paid: req.body.date_paid, amount: req.body.amount, description: req.body.description ?? null,
      cost_share_person_ids: R.serializePersonIds(req.body.cost_share_person_ids),
    }) };
  });

  patchRoute('/team-payments/:id', async req => {
    const fields = ['member_id', 'date_paid', 'amount', 'description', 'cost_share_person_ids'];
    await patch(db(), 'team_payments', id(req), withAudience(sent(req.body, fields)), fields, 'Team payment not found');
  });

  del('/team-payments/:id', async req => { await remove(db(), 'team_payments', id(req), 'Team payment not found'); });

  // ── owner payouts (a record of what the owner actually paid themselves) ───

  get('/owner-payouts', req => (req.query.month
    ? db().all(`SELECT * FROM rev_owner_payouts WHERE substr(date_paid, 1, 7) = substr($1, 1, 7) ORDER BY date_paid, id`, req.query.month)
    : db().all(`SELECT * FROM rev_owner_payouts ORDER BY date_paid, id`)));

  post('/owner-payouts', async req => {
    required(req.body, ['date_paid', 'amount']);
    return { id: await insert(db(), 'owner_payouts', { date_paid: req.body.date_paid, amount: req.body.amount, description: req.body.description ?? null }) };
  });

  patchRoute('/owner-payouts/:id', async req => {
    const fields = ['date_paid', 'amount', 'description'];
    await patch(db(), 'owner_payouts', id(req), sent(req.body, fields), fields, 'Owner payout not found');
  });

  del('/owner-payouts/:id', async req => { await remove(db(), 'owner_payouts', id(req), 'Owner payout not found'); });

  // ── dev payouts (one-time dev salary fronted personally) ──────────────────

  get('/dev-payouts', async req => {
    const d = rd();
    const rows = req.query.month
      ? await d.all(`SELECT * FROM rev_dev_payouts WHERE substr(date_paid, 1, 7) = substr($1, 1, 7) ORDER BY date_paid, id`, req.query.month)
      : await d.all(`SELECT * FROM rev_dev_payouts ORDER BY date_paid, id`);
    const out = [];
    for (const r of rows) {
      const repaid = (await d.one(`SELECT COALESCE(SUM(amount), 0) AS total FROM rev_dev_payout_repayments WHERE dev_payout_id = $1 AND status = 'paid'`, r.id)).total;
      out.push(R.withCostShareIds({ ...r, repaid_total: repaid, remaining_owed: r.amount - repaid }));
    }
    return out;
  });

  post('/dev-payouts', async req => {
    required(req.body, ['scripter_name', 'amount', 'date_paid']);
    return { id: await insert(db(), 'dev_payouts', {
      scripter_name: req.body.scripter_name, amount: req.body.amount, date_paid: req.body.date_paid, description: req.body.description ?? null,
      cost_share_person_ids: R.serializePersonIds(req.body.cost_share_person_ids), payee_id: req.body.payee_id ?? null,
    }) };
  });

  patchRoute('/dev-payouts/:id', async req => {
    const fields = ['scripter_name', 'amount', 'date_paid', 'description', 'cost_share_person_ids', 'payee_id'];
    await patch(db(), 'dev_payouts', id(req), withAudience(sent(req.body, fields)), fields, 'Dev payout not found');
  });

  del('/dev-payouts/:id', req => tx(async d => {
    const existing = await d.one(`SELECT * FROM rev_dev_payouts WHERE id = $1`, id(req));
    if (!existing) throw new RevenueError(404, 'Dev payout not found');
    await d.run(`DELETE FROM rev_dev_payout_repayments WHERE dev_payout_id = $1`, existing.id);
    await d.run(`DELETE FROM rev_dev_payouts WHERE id = $1`, existing.id);
    return { ok: true };
  }));

  // ── repayment ledgers (dev payouts, and recurring salaries per month) ─────

  get('/dev-payout-repayments', req => db().all(
    `SELECT * FROM rev_dev_payout_repayments WHERE dev_payout_id = $1 ORDER BY date_paid, id`, Number(req.query.dev_payout_id)));

  post('/dev-payout-repayments', async req => {
    required(req.body, ['dev_payout_id', 'contributor_name', 'amount']);
    const d = db();
    if (!await d.one(`SELECT id FROM rev_dev_payouts WHERE id = $1`, Number(req.body.dev_payout_id))) throw new RevenueError(404, 'Dev payout not found');
    return { id: await insert(d, 'dev_payout_repayments', {
      dev_payout_id: req.body.dev_payout_id, contributor_name: req.body.contributor_name, amount: req.body.amount, date_paid: '',
    }) };
  });

  get('/salary-repayments', req => db().all(
    `SELECT * FROM rev_salary_repayments WHERE member_id = $1 AND month = $2 ORDER BY id`, Number(req.query.member_id), String(req.query.month)));

  post('/salary-repayments', async req => {
    required(req.body, ['member_id', 'month', 'contributor_name', 'amount']);
    const d = db();
    if (!await d.one(`SELECT id FROM rev_team_members WHERE id = $1`, Number(req.body.member_id))) throw new RevenueError(404, 'Team member not found');
    return { id: await insert(d, 'salary_repayments', {
      member_id: req.body.member_id, month: req.body.month, contributor_name: req.body.contributor_name, amount: req.body.amount, date_paid: '',
    }) };
  });

  for (const [path, table] of [['/dev-payout-repayments', 'dev_payout_repayments'], ['/salary-repayments', 'salary_repayments']]) {
    const fields = ['contributor_name', 'amount', 'date_paid', 'status'];
    patchRoute(`${path}/:id`, async req => { await patch(db(), table, id(req), sent(req.body, fields), fields, 'Repayment not found'); });
    del(`${path}/:id`, async req => { await remove(db(), table, id(req), 'Repayment not found'); });
  }

  // ── balance checkpoints (the real Roblox group balance, logged by hand) ───

  get('/balance-checkpoints', () => db().all(`SELECT * FROM rev_balance_checkpoints ORDER BY date_checked DESC, id DESC`));

  post('/balance-checkpoints', async req => {
    required(req.body, ['date_checked', 'community_funds']);
    return { id: await insert(db(), 'balance_checkpoints', {
      date_checked: req.body.date_checked, community_funds: req.body.community_funds, pending_robux: req.body.pending_robux ?? 0, note: req.body.note ?? null,
    }) };
  });

  patchRoute('/balance-checkpoints/:id', async req => {
    const fields = ['date_checked', 'community_funds', 'pending_robux', 'note'];
    await patch(db(), 'balance_checkpoints', id(req), sent(req.body, fields), fields, 'Checkpoint not found');
  });

  del('/balance-checkpoints/:id', async req => { await remove(db(), 'balance_checkpoints', id(req), 'Checkpoint not found'); });

  // ── settings ──────────────────────────────────────────────────────────────

  const setting = (key, value) => db().run(
    `INSERT INTO rev_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, key, String(value));

  get('/exchange-rate', async () => {
    const row = await db().one(`SELECT value FROM rev_settings WHERE key = 'robux_usd_rate'`);
    return { rate: row ? parseFloat(row.value) : 0.0 };
  });
  post('/exchange-rate', async req => {
    required(req.body, ['rate']);
    await setting('robux_usd_rate', coerce('monthly_revenue', 'gross_revenue', req.body.rate));
  });

  get('/owner-config', async () => ({ person_id: await R.getOwnerPersonId(db()) }));
  post('/owner-config', async req => {
    required(req.body, ['person_id']);
    if (!await db().one(`SELECT id FROM rev_people WHERE id = $1`, Number(req.body.person_id))) throw new RevenueError(404, 'Person not found');
    await setting('owner_person_id', parseInt(req.body.person_id, 10));
  });

  // ── computed views ────────────────────────────────────────────────────────

  get('/roster/:month', async req => {
    const d = rd();
    const month = req.params.month;
    const lastDay = R.isoDate(R.monthBounds(month).last);
    const out = [];
    for (const p of await people(d)) {
      const resolved = await R.resolvePersonMonth(d, p, month);
      if (resolved) out.push(resolved);
      else if (p.fired_from && p.fired_from <= lastDay) {
        // Fired as of this month - nothing resolves for them anymore, but
        // the Roster tab still lists them (struck out, at 0%).
        out.push({
          person_id: p.id, name: p.name, roblox_handle: p.roblox_handle, category: p.category, fired_from: p.fired_from, fired: true,
          base_share_pct: 0.0, adjustment_delta_pct: 0.0, effective_share_pct: 0.0,
        });
      }
    }
    return out;
  });

  const byMethod = method => async req => {
    const d = rd();
    const out = [];
    for (const p of await people(d)) {
      const resolved = await R.resolvePersonMonth(d, p, req.params.month);
      if (resolved && resolved.payout_method === method) out.push(resolved);
    }
    return out;
  };
  get('/payouts/:month', byMethod('manual'));
  // Standard-payout people's resolved earnings. Informational only - Roblox's
  // group % split pays these out automatically, outside this system.
  get('/auto-payouts/:month', byMethod('standard'));

  get('/overview/:month', async req => overview(rd(), req.params.month));

  // Everyone with an active cost-share rule this month, and what they owe.
  get('/cost-share-owed/:month', async req => {
    const d = rd();
    const month = req.params.month;
    const totalExpenses = await R.monthTotalExpenses(d, month);
    const out = [];
    for (const personId of await R.resolveCostSharePersonIds(d, month)) {
      const person = await d.one(`SELECT * FROM rev_people WHERE id = $1`, personId);
      if (!person) continue;
      const term = await R.resolveShareTerm(d, person.id, month);
      const amountOwed = await R.resolveCostShareDeduction(d, person.id, month);
      const collection = await d.one(`SELECT status FROM rev_cost_share_collections WHERE person_id = $1 AND month = $2`, person.id, month);
      out.push({
        person_id: person.id, name: person.name, payout_method: term ? term.payout_method : 'unknown',
        cost_share_pct: totalExpenses ? amountOwed / totalExpenses : 0.0, total_expenses: totalExpenses, amount_owed: amountOwed,
        needs_manual_collection: !term || term.payout_method !== 'manual',
        collection_status: collection ? collection.status : 'not_collected',
      });
    }
    return out;
  });

  get('/expense-report/:month', async req => {
    const raw = req.query.person_ids;
    const personIds = (Array.isArray(raw) ? raw : raw !== undefined ? [raw] : []).map(Number).filter(Number.isInteger);
    return expenseReport(rd(), req.params.month, personIds);
  });

  return router;
}

// The month's headline numbers. See the original for why each total is
// built the way it is; the comments that matter are kept.
async function overview(d, month) {
  const { gross, net } = await R.monthNetRevenue(d, month);
  const ownerPersonId = await R.getOwnerPersonId(d);
  let totalPayouts = 0.0;
  let totalManualPayouts = 0.0;
  let totalContrib = 0.0;
  let totalCostShare = 0.0;
  let totalEffectivePctExclOwner = 0.0;
  let ownerPayout = null;
  let ownerPct = null;
  const noContract = [];
  let unpaidManual = 0;
  const methodCounts = { standard: 0, manual: 0 };
  for (const p of await d.all(`SELECT * FROM rev_people ORDER BY id`)) {
    const r = await R.resolvePersonMonth(d, p, month);
    if (!r) continue;
    if (ownerPersonId !== null && r.person_id === ownerPersonId) {
      // The owner's own real take-home.
      ownerPayout = r.final_payout;
      ownerPct = r.effective_share_pct;
    } else {
      totalEffectivePctExclOwner += r.effective_share_pct;
    }
    // Standard people: Roblox auto-pays their full gross_share regardless of
    // anything tracked here, and their "owed to owner" contributions and
    // cost-share are still owed. Manual people: for cut-math purposes
    // final_payout_for_cut is used, which excludes "self" contributions.
    if (r.payout_method === 'manual') {
      totalPayouts += r.final_payout_for_cut;
      // The real cash total that needs to leave via a Roblox group payment.
      totalManualPayouts += r.final_payout;
    } else {
      totalPayouts += r.gross_share;
      totalContrib += r.owner_contribution_deduction;
      totalCostShare += r.cost_share_deduction;
    }
    if (r.contract_status === 'no_contract') noContract.push(r.name);
    methodCounts[r.payout_method] = (methodCounts[r.payout_method] || 0) + 1;
    if (r.payout_method === 'manual' && r.paid_status === 'unpaid') unpaidManual += 1;
  }
  const totalExpenses = await R.monthTotalExpenses(d, month);
  const totalDevPayouts = (await d.one(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM rev_dev_payouts WHERE substr(date_paid, 1, 7) = substr($1, 1, 7)`, month)).total;
  // "Unallocated": revenue nobody's percentage covers. Should sit near zero.
  const unallocated = net - totalPayouts - totalExpenses;
  // How the real Roblox balance compares against what is owed in Manual payouts.
  const checkpoint = await d.one(`SELECT * FROM rev_balance_checkpoints ORDER BY date_checked DESC, id DESC LIMIT 1`);
  const checkpointTotal = checkpoint ? checkpoint.community_funds + checkpoint.pending_robux : null;
  return {
    month,
    gross_revenue: gross,
    net_revenue: net,
    total_revenue_share_payouts: totalPayouts,
    remaining_earnings: net - totalPayouts,
    total_expenses: totalExpenses,
    total_dev_payouts: totalDevPayouts,
    final_cut: unallocated,
    owner_payout: ownerPayout,
    owner_pct: ownerPct,
    owner_effective_pct: 1.0 - totalEffectivePctExclOwner,
    cut_before_payback: (ownerPayout !== null ? ownerPayout : unallocated) - totalContrib - totalCostShare,
    total_contributions: totalContrib,
    total_cost_share_owed: totalCostShare,
    total_manual_payouts: totalManualPayouts,
    checkpoint_total: checkpointTotal,
    checkpoint_date: checkpoint ? checkpoint.date_checked : null,
    payout_obligation_gap: checkpoint ? checkpointTotal - totalManualPayouts : null,
    no_contract_people: noContract,
    unpaid_manual_count: unpaidManual,
    method_counts: methodCounts,
  };
}

// Per-person cost-share and contribution breakdown for the month: for each
// requested person, only the line items they are actually on the hook for,
// with their exact share of each. Backs the printable per-person reports.
async function expenseReport(d, month, personIds) {
  const defaultAudience = new Set(await R.resolveCostSharePersonIds(d, month));
  const targetIds = personIds.length ? personIds : [...defaultAudience].sort((a, b) => a - b);
  const legacyMode = month < R.EVEN_SPLIT_COST_SHARE_FROM;
  const SALARY = 'Contractor Salary for update costs';

  const lineItems = [];
  if (!legacyMode) {
    for (const row of await d.all(
      `SELECT date_incurred AS date, description, category, amount, cost_share_person_ids FROM rev_expenses WHERE month = $1 ORDER BY date_incurred, id`, month)) {
      lineItems.push(['Expense', row]);
    }
    for (const row of await d.all(
      `SELECT tp.date_paid AS date, tp.description AS description, tm.category AS category, tp.amount, tp.cost_share_person_ids
       FROM rev_team_payments tp JOIN rev_team_members tm ON tm.id = tp.member_id
       WHERE substr(tp.date_paid, 1, 7) = substr($1, 1, 7) ORDER BY tp.date_paid, tp.id`, month)) {
      lineItems.push(['Team Payment', { ...row, description: row.description || 'Team payment', category: SALARY }]);
    }
    for (const row of await d.all(
      `SELECT name AS description, category, monthly_amount AS amount, cost_share_person_ids FROM rev_team_members WHERE status = 'active' ORDER BY name, id`)) {
      lineItems.push(['Recurring Team Due', { ...row, date: null, category: SALARY }]);
    }
  }
  const totalExpenses = legacyMode ? await R.monthTotalExpenses(d, month) : null;
  const devPayouts = await d.all(
    `SELECT scripter_name, amount, date_paid, cost_share_person_ids FROM rev_dev_payouts WHERE substr(date_paid, 1, 7) = substr($1, 1, 7) ORDER BY id`, month);
  const ownerId = await R.getOwnerPersonId(d);

  const out = [];
  for (const pid of targetIds) {
    const person = await d.one(`SELECT * FROM rev_people WHERE id = $1`, pid);
    if (!person) continue;
    const items = [];
    let totalOwed = 0.0;
    if (legacyMode) {
      const rulePct = await R.resolveCostSharePct(d, pid, month);
      if (rulePct) {
        totalOwed = rulePct * totalExpenses;
        items.push({
          date: null, source: 'Cost-share rule', description: 'General update costs', category: null,
          total_amount: totalExpenses, split_note: `${(rulePct * 100).toFixed(1)}%`, share_amount: totalOwed,
        });
      }
    } else {
      for (const [source, row] of lineItems) {
        const audience = R.lineAudience(row.cost_share_person_ids, defaultAudience);
        if (audience.size && audience.has(pid)) {
          const share = row.amount / audience.size;
          items.push({
            date: row.date, source, description: row.description, category: row.category,
            total_amount: row.amount, split_note: `÷${audience.size}`, share_amount: share,
          });
          totalOwed += share;
        }
      }
    }
    // Dev payouts run on their own audience logic regardless of month.
    for (const dp of devPayouts) {
      const audience = R.deserializePersonIds(dp.cost_share_person_ids);
      let share;
      let splitNote;
      if (audience) {
        if (!audience.includes(pid)) continue;
        share = dp.amount / audience.length;
        splitNote = `÷${audience.length}`;
      } else if (pid === ownerId) {
        share = dp.amount;
        splitNote = 'You (no split set)';
      } else continue;
      items.push({
        date: dp.date_paid, source: 'Dev Payout', description: dp.scripter_name, category: SALARY,
        total_amount: dp.amount, split_note: splitNote, share_amount: share,
      });
      totalOwed += share;
    }
    const contributions = await d.all(
      `SELECT amount, date_logged, purpose, benefit_type, status, link_url FROM rev_contributions
       WHERE person_id = $1 AND effective_month = $2 ORDER BY date_logged, id`, pid, month);
    out.push({
      person_id: pid, name: person.name, items, total_owed: totalOwed, contributions,
      total_contributions: contributions.reduce((sum, c) => sum + c.amount, 0),
    });
  }
  return out;
}

module.exports = { buildRouter, overview, expenseReport };
