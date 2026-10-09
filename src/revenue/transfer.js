// Moving the whole revenue dataset in and out as one JSON document.
//
//   importDump   replaces everything with a dump: the tables of a Revenue Ops
//                SQLite backup (read in the browser, see the Revenue page) or
//                an earlier export from here. Ids are kept, so every link
//                between rows survives.
//   exportDump   everything, in the same shape. This is the backup.

const { TABLES, COLUMNS } = require('./schema');
const { RevenueError, transaction, coerce } = require('./store');

const TABLE_NAMES = Object.keys(TABLES);

async function counts(prisma) {
  const out = {};
  for (const name of TABLE_NAMES) {
    out[name] = (await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM rev_${name}`))[0].n;
  }
  return out;
}

async function exportDump(prisma) {
  const tables = {};
  for (const name of TABLE_NAMES) tables[name] = await prisma.$queryRawUnsafe(`SELECT * FROM rev_${name} ORDER BY id`);
  tables.settings = await prisma.$queryRawUnsafe(`SELECT key, value FROM rev_settings ORDER BY key`);
  tables.sqlite_sequence = [];
  for (const name of TABLE_NAMES) {
    const [row] = await prisma.$queryRawUnsafe(`SELECT last_value::int AS seq, is_called FROM rev_${name}_id_seq`);
    if (row && row.is_called) tables.sqlite_sequence.push({ name, seq: row.seq });
  }
  return { format: 'devtrack-revenue', version: 1, exported_at: new Date().toISOString(), tables };
}

// What a dump holds, without writing anything.
function describe(dump) {
  const tables = dump && typeof dump === 'object' ? dump.tables : null;
  if (!tables || typeof tables !== 'object') throw new RevenueError(400, 'That file is not a revenue backup.');
  if (!Array.isArray(tables.people) || !Array.isArray(tables.share_terms)) {
    throw new RevenueError(400, 'That backup has no roster in it (no people or share terms), so it was not imported.');
  }
  const found = {};
  for (const name of TABLE_NAMES) found[name] = Array.isArray(tables[name]) ? tables[name].length : 0;
  return { tables: found, unknown: Object.keys(tables).filter(t => !TABLE_NAMES.includes(t) && !['settings', 'schema_migrations', 'sqlite_sequence'].includes(t)) };
}

async function importDump(prisma, dump, { actorName } = {}) {
  const summary = describe(dump);
  const sequences = Array.isArray(dump.tables.sqlite_sequence) ? dump.tables.sqlite_sequence : [];
  await transaction(prisma, async d => {
    for (const name of TABLE_NAMES) {
      await d.run(`DELETE FROM rev_${name}`);
      const known = COLUMNS[name];
      for (const row of Array.isArray(dump.tables[name]) ? dump.tables[name] : []) {
        const id = parseInt(row.id, 10);
        if (!Number.isInteger(id)) throw new RevenueError(400, `A row in ${name} has no id.`);
        // Only columns this table has; a column the backup lacks keeps its default.
        const cols = Object.keys(row).filter(c => c !== 'id' && known[c] && row[c] !== null && row[c] !== undefined);
        const casts = cols.map((c, i) => `$${i + 2}::${known[c] === 'int' ? 'int' : known[c] === 'real' ? 'double precision' : 'text'}`);
        await d.run(
          `INSERT INTO rev_${name} (id${cols.map(c => `, ${c}`).join('')}) VALUES ($1::int${casts.map(c => `, ${c}`).join('')})`,
          id, ...cols.map(c => coerce(name, c, row[c])));
      }
      // New rows must not reuse an id: not one that was imported, and not
      // one the original had already handed out to a row since deleted (it
      // keeps that high-water mark in sqlite_sequence).
      const highWater = Math.max(0, ...sequences.filter(q => q && q.name === name).map(q => parseInt(q.seq, 10) || 0));
      await d.run(
        `SELECT setval(pg_get_serial_sequence('rev_${name}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM rev_${name}), 0), $1::int, 1),
           GREATEST(COALESCE((SELECT MAX(id) FROM rev_${name}), 0), $1::int) > 0)`, highWater);
    }
    await d.run(`DELETE FROM rev_settings`);
    for (const s of Array.isArray(dump.tables.settings) ? dump.tables.settings : []) {
      if (s && s.key && s.value !== null && s.value !== undefined) {
        await d.run(`INSERT INTO rev_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, String(s.key), String(s.value));
      }
    }
    const marks = { seeded_salary_categories: '1', imported_at: new Date().toISOString(), imported_by: actorName || '' };
    for (const [key, value] of Object.entries(marks)) {
      await d.run(`INSERT INTO rev_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, key, value);
    }
    await d.run(`INSERT INTO rev_settings (key, value) VALUES ('robux_usd_rate', '0.0038') ON CONFLICT (key) DO NOTHING`);
  });
  return { imported: summary.tables, ignored_tables: summary.unknown };
}

module.exports = { TABLE_NAMES, counts, describe, importDump, exportDump };
