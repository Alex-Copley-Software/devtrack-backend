#!/usr/bin/env node
// One-time import of the AE_Update_Asset_Tracker Google Sheet.
//
//   node scripts/import-asset-sheet.js --dry-run     read the sheet, print counts and unmapped rows, write nothing
//   node scripts/import-asset-sheet.js               import (safe to re-run)
//   node scripts/import-asset-sheet.js --export      push the current tracker to the "DevTrack Export" tab now
//
// Env: GOOGLE_SERVICE_ACCOUNT_JSON, ASSET_SHEET_ID, and DATABASE_URL for a
// real import (a dry run does not touch the database).

require('dotenv').config();
const client = require('../src/assets/sheets/client');
const { buildImportPlan, formatReport } = require('../src/assets/sheets/parse');
const { resolveTabs, applyImportPlan } = require('../src/assets/sheets/importer');

async function readSheet() {
  const sheetId = process.env.ASSET_SHEET_ID;
  if (!sheetId) throw new Error('ASSET_SHEET_ID is not set');
  const { token, email } = await client.getAccessToken({ readOnly: true });
  console.log(`Reading sheet as ${email}`);
  const titles = (await client.listTabs(token, sheetId)).map(t => t.title);
  const { found, missing } = resolveTabs(titles);
  if (missing.length) console.log(`Tabs not found (skipped): ${missing.join(', ')}\nTabs in the sheet: ${titles.join(', ')}`);
  const keys = Object.keys(found);
  const values = await client.readTabs(token, sheetId, keys.map(k => found[k]));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--export')) {
    const { getPrisma } = require('../src/assets/db');
    const { ensureAssetSchema } = require('../src/assets/schema');
    const prisma = getPrisma();
    await ensureAssetSchema(prisma);
    const count = await require('../src/assets/sheets/exporter').exportToSheet(prisma);
    console.log(`Exported ${count} tasks.`);
    return;
  }

  const plan = buildImportPlan(await readSheet());
  console.log(`\n${formatReport(plan)}\n`);
  if (args.has('--dry-run')) {
    console.log('Dry run: nothing was written.');
    return;
  }

  const { getPrisma } = require('../src/assets/db');
  const { ensureAssetSchema } = require('../src/assets/schema');
  const prisma = getPrisma();
  await ensureAssetSchema(prisma);
  const stats = await applyImportPlan(prisma, plan);
  console.log('Created:', stats.created);
  console.log('Updated:', stats.updated);
  if (stats.unmatchedTaskRows) console.log(`Task rows with no generated task: ${stats.unmatchedTaskRows}`);
  console.log('Import complete. DevTrack is now the source of truth.');
}

main().then(() => process.exit(0)).catch(err => {
  console.error(`Import failed: ${err.message}`);
  process.exit(1);
});
