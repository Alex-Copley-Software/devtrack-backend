// Tables for the Revenue page: a port of the standalone Revenue Ops app
// (FastAPI + SQLite) into DevTrack. Created on first use, like the rest of
// the codebase.
//
// The port keeps the original's shape on purpose, so its numbers can be
// checked line for line against the original:
//   - same table and column names, with a rev_ prefix on the tables
//   - integer ids (an import keeps the original ids, so links between rows survive)
//   - dates stay TEXT ('YYYY-MM-DD', months as 'YYYY-MM-01'), compared as
//     strings exactly as the original compares them. COLLATE "C" makes that
//     comparison byte-wise, which is what SQLite does.
//   - created_at stays the 'YYYY-MM-DD HH:MM:SS' UTC text the original wrote
//
// The two columns DevTrack adds (source, source_ref on rev_expenses) come
// last and are ignored by everything ported.

const D = 'TEXT COLLATE "C"';
const NOW = `TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

// name -> column definitions, in the original's column order.
const TABLES = {
  people: [
    ['name', 'TEXT NOT NULL UNIQUE'], ['roblox_handle', 'TEXT'], ['discord_id', 'TEXT'], ['category', `TEXT NOT NULL DEFAULT 'Developer'`],
    ['created_at', NOW], ['payee_id', 'INT'], ['fired_from', D],
  ],
  share_terms: [
    ['person_id', 'INT NOT NULL'], ['share_pct', 'DOUBLE PRECISION NOT NULL'], ['payout_method', `TEXT NOT NULL DEFAULT 'standard'`],
    ['contract_status', `TEXT NOT NULL DEFAULT 'active'`], ['effective_from', `${D} NOT NULL`], ['effective_until', D], ['created_at', NOW],
  ],
  adjustment_rules: [
    ['person_id', 'INT NOT NULL'], ['rule_type', 'TEXT NOT NULL'], ['delta_pct', 'DOUBLE PRECISION NOT NULL'], ['trigger_type', 'TEXT NOT NULL'],
    ['trigger_date', D], ['trigger_threshold', 'DOUBLE PRECISION'], ['effective_from', D], ['status', `TEXT NOT NULL DEFAULT 'pending'`],
    ['description', 'TEXT'], ['created_at', NOW],
  ],
  monthly_revenue: [
    ['month', `${D} NOT NULL UNIQUE`], ['gross_revenue', 'DOUBLE PRECISION NOT NULL DEFAULT 0'], ['platform_fee_pct', 'DOUBLE PRECISION NOT NULL DEFAULT 0'],
    ['created_at', NOW],
  ],
  contributions: [
    ['person_id', 'INT NOT NULL'], ['amount', 'DOUBLE PRECISION NOT NULL'], ['date_logged', `${D} NOT NULL`], ['effective_month', `${D} NOT NULL`],
    ['purpose', 'TEXT'], ['created_at', NOW], ['status', `TEXT NOT NULL DEFAULT 'unpaid'`], ['benefit_type', `TEXT NOT NULL DEFAULT 'owner'`], ['link_url', 'TEXT'],
  ],
  cost_share_rules: [
    ['person_id', 'INT NOT NULL'], ['pct', 'DOUBLE PRECISION NOT NULL'], ['linked_item', 'TEXT'], ['effective_from', `${D} NOT NULL`],
    ['effective_until', D], ['created_at', NOW],
  ],
  expenses: [
    ['date_incurred', `${D} NOT NULL`], ['month', `${D} NOT NULL`], ['description', 'TEXT NOT NULL'], ['category', `TEXT NOT NULL DEFAULT 'Other'`],
    ['amount', 'DOUBLE PRECISION NOT NULL'], ['created_at', NOW], ['receipt_url', 'TEXT'], ['cost_share_person_ids', 'TEXT'], ['payee_id', 'INT'],
    // DevTrack additions: where an expense came from when DevTrack logged it (an asset payout, say).
    ['source', 'TEXT'], ['source_ref', 'TEXT'],
  ],
  notes: [['entity_type', 'TEXT NOT NULL'], ['entity_id', 'INT NOT NULL'], ['body', 'TEXT NOT NULL'], ['created_at', NOW]],
  payment_status: [['person_id', 'INT NOT NULL'], ['month', `${D} NOT NULL`], ['status', `TEXT NOT NULL DEFAULT 'unpaid'`]],
  cost_share_collections: [['person_id', 'INT NOT NULL'], ['month', `${D} NOT NULL`], ['status', `TEXT NOT NULL DEFAULT 'not_collected'`]],
  team_members: [
    ['name', 'TEXT NOT NULL'], ['category', 'TEXT NOT NULL'], ['monthly_amount', 'DOUBLE PRECISION NOT NULL DEFAULT 0'],
    ['status', `TEXT NOT NULL DEFAULT 'active'`], ['created_at', NOW], ['cost_share_person_ids', 'TEXT'], ['payee_id', 'INT'],
  ],
  team_payment_status: [['member_id', 'INT NOT NULL'], ['month', `${D} NOT NULL`], ['status', `TEXT NOT NULL DEFAULT 'unpaid'`]],
  team_payments: [
    ['member_id', 'INT NOT NULL'], ['date_paid', `${D} NOT NULL`], ['amount', 'DOUBLE PRECISION NOT NULL'], ['description', 'TEXT'],
    ['created_at', NOW], ['cost_share_person_ids', 'TEXT'],
  ],
  owner_payouts: [['date_paid', `${D} NOT NULL`], ['amount', 'DOUBLE PRECISION NOT NULL'], ['description', 'TEXT'], ['created_at', NOW]],
  dev_payouts: [
    ['scripter_name', 'TEXT NOT NULL'], ['amount', 'DOUBLE PRECISION NOT NULL'], ['date_paid', `${D} NOT NULL`], ['description', 'TEXT'],
    ['created_at', NOW], ['cost_share_person_ids', 'TEXT'], ['payee_id', 'INT'],
  ],
  dev_payout_repayments: [
    ['dev_payout_id', 'INT NOT NULL'], ['contributor_name', 'TEXT NOT NULL'], ['amount', 'DOUBLE PRECISION NOT NULL'], ['date_paid', `${D} NOT NULL`],
    ['created_at', NOW], ['status', `TEXT NOT NULL DEFAULT 'pending'`],
  ],
  salary_categories: [['name', 'TEXT NOT NULL UNIQUE'], ['created_at', NOW]],
  salary_repayments: [
    ['member_id', 'INT NOT NULL'], ['month', `${D} NOT NULL`], ['contributor_name', 'TEXT NOT NULL'], ['amount', 'DOUBLE PRECISION NOT NULL'],
    ['date_paid', D], ['status', `TEXT NOT NULL DEFAULT 'pending'`], ['created_at', NOW],
  ],
  payees: [['display_name', 'TEXT NOT NULL UNIQUE'], ['roblox_user_id', 'TEXT'], ['created_at', NOW]],
  balance_checkpoints: [
    ['date_checked', `${D} NOT NULL`], ['community_funds', 'DOUBLE PRECISION NOT NULL'], ['pending_robux', 'DOUBLE PRECISION NOT NULL DEFAULT 0'],
    ['note', 'TEXT'], ['created_at', NOW],
  ],
};

const UNIQUES = [
  ['payment_status', '(person_id, month)'],
  ['cost_share_collections', '(person_id, month)'],
  ['team_payment_status', '(member_id, month)'],
];

const INDEXES = [
  ['share_terms', '(person_id, effective_from)'],
  ['contributions', '(effective_month)'],
  ['expenses', '(month)'],
  ['expenses', '(payee_id)'],
  ['expenses', '(source, source_ref)'],
  ['team_payments', '(member_id)'],
  ['dev_payouts', '(date_paid)'],
];

// The column type each field is coerced to on the way in.
const kind = def => (def.startsWith('INT') ? 'int' : def.startsWith('DOUBLE') ? 'real' : 'text');
const COLUMNS = Object.fromEntries(Object.entries(TABLES).map(([name, cols]) => [name, Object.fromEntries(cols.map(([c, def]) => [c, kind(def)]))]));

const ready = new WeakSet();
async function ensureRevenueSchema(prisma) {
  if (ready.has(prisma)) return;
  for (const [name, cols] of Object.entries(TABLES)) {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS rev_${name} (id SERIAL PRIMARY KEY, ${cols.map(([c, def]) => `${c} ${def}`).join(', ')})`);
    // Columns added after a table first shipped.
    for (const [c, def] of cols) {
      await prisma.$executeRawUnsafe(`ALTER TABLE rev_${name} ADD COLUMN IF NOT EXISTS ${c} ${def.replace(/ NOT NULL(?! DEFAULT)/, '').replace(' UNIQUE', '')}`);
    }
  }
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS rev_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await prisma.$executeRawUnsafe(`INSERT INTO rev_settings (key, value) VALUES ('robux_usd_rate', '0.0038') ON CONFLICT (key) DO NOTHING`);
  for (const [table, cols] of UNIQUES) {
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS rev_${table}_uniq ON rev_${table} ${cols}`);
  }
  for (const [table, cols] of INDEXES) {
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS rev_${table}_${cols.replace(/\W+/g, '_')}idx ON rev_${table} ${cols}`);
  }
  // The original's starter categories, added once only: deleting one later must stick.
  const seeded = await prisma.$queryRawUnsafe(`SELECT 1 FROM rev_settings WHERE key = 'seeded_salary_categories'`);
  if (!seeded.length) {
    for (const name of ['Planner', 'Tester', 'Bug Hunter']) {
      await prisma.$executeRawUnsafe(`INSERT INTO rev_salary_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, name);
    }
    await prisma.$executeRawUnsafe(`INSERT INTO rev_settings (key, value) VALUES ('seeded_salary_categories', '1') ON CONFLICT (key) DO NOTHING`);
  }
  ready.add(prisma);
}

module.exports = { TABLES, COLUMNS, ensureRevenueSchema };
