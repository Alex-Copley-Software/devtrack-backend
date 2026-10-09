#!/usr/bin/env node
// Loads a Revenue Ops backup into the Revenue page's tables, replacing what
// is there. Does the same thing as Revenue, Data & Backup, Import, from the
// command line.
//
//   node scripts/import-revenue-backup.js <revenue_ops_YYYY-MM-DD.db | export.json> [--dry-run]
//   node scripts/import-revenue-backup.js --latest [--dry-run]
//
// --latest downloads the newest daily backup from the db-backups release of
// the revenue repo with the GitHub CLI (`gh`, signed in to an account that
// can see that repo). Reading a .db needs Node 22.5 or newer.
//
// Env: DATABASE_URL (the database to load into). REVENUE_BACKUP_REPO
// overrides the repo (default Alex-Copley-Software/revenue_ops).

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.env.REVENUE_BACKUP_REPO || 'Alex-Copley-Software/revenue_ops';

function latestBackup() {
  const assets = JSON.parse(execFileSync('gh', ['release', 'view', 'db-backups', '--repo', REPO, '--json', 'assets'], { encoding: 'utf8' })).assets;
  const newest = assets.filter(a => /^revenue_ops_\d{4}-\d{2}-\d{2}\.db$/.test(a.name)).sort((a, b) => a.name.localeCompare(b.name)).pop();
  if (!newest) throw new Error(`No revenue_ops_YYYY-MM-DD.db backups on the db-backups release of ${REPO}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revenue-backup-'));
  execFileSync('gh', ['release', 'download', 'db-backups', '--repo', REPO, '--pattern', newest.name, '--dir', dir], { stdio: 'inherit' });
  return path.join(dir, newest.name);
}

function readDump(file) {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  if (!head.toString('utf8').startsWith('SQLite format 3')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = {};
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()) {
    tables[name] = db.prepare(`SELECT * FROM "${name}"`).all().map(row => ({ ...row }));
  }
  db.close();
  return { format: 'revenue-ops-sqlite', tables };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.includes('--latest') ? latestBackup() : args.find(a => !a.startsWith('--'));
  if (!file) throw new Error('Give a backup file, or --latest');
  const dump = readDump(file);

  const { getPrisma } = require('../src/assets/db');
  const { ensureRevenueSchema } = require('../src/revenue/schema');
  const transfer = require('../src/revenue/transfer');
  const prisma = getPrisma();
  await ensureRevenueSchema(prisma);
  const found = transfer.describe(dump).tables;
  const before = await transfer.counts(prisma);
  const show = counts => Object.entries(counts).filter(([, n]) => n).map(([name, n]) => `${name} ${n}`).join(', ') || 'nothing';
  console.log(`Backup:   ${path.basename(file)}\nHolds:    ${show(found)}\nIn place: ${show(before)}`);
  if (dryRun) { console.log('Dry run: nothing was changed.'); return; }
  await transfer.importDump(prisma, dump, { actorName: `import script (${path.basename(file)})` });
  console.log(`Now:      ${show(await transfer.counts(prisma))}\nImported. The Revenue page now shows this backup.`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(`Import failed: ${err.message}`);
  process.exit(1);
});
