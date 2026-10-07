// Optional one-way nightly export of the tracker to a "DevTrack Export" tab,
// for anyone who still wants to look at it in the sheet. DevTrack stays the
// source of truth: nothing is ever read back from that tab.
// Enabled with ASSET_SHEET_EXPORT=true (and ASSETS_ENABLED=true).

const q = require('../queries');
const C = require('../constants');
const { getPrisma } = require('../db');
const { ensureAssetSchema } = require('../schema');

const EXPORT_TAB = 'DevTrack Export';
const HEADER = [
  'Update #', 'Update', 'Content Type', 'Display Name', 'Internal Name', 'Item #', 'Task #', 'Discipline', 'Deliverable',
  'Required', 'Assigned To', 'Status', 'Due Date', 'Notes / Asset ID', 'Task ID', 'DevTrack Ref', 'Last Updated',
];

async function buildExportRows(prisma) {
  const [tasks, updates] = await Promise.all([q.listTasksDetailed(prisma), q.listUpdates(prisma)]);
  const updateName = new Map(updates.map(u => [u.id, u.name]));
  const rows = tasks.map(t => [
    t.updateNumber, updateName.get(t.updateId) || '', t.contentType, t.displayName || '', t.internalName, t.itemNumber,
    t.taskNumber, t.discipline, t.deliverable, t.required ? 'Yes' : 'No', t.assigneeName || '', t.status, t.dueDate || '',
    t.notes || '', t.taskCode, t.ref, new Date(t.updatedAt).toISOString(),
  ]);
  return [[`Exported from DevTrack ${new Date().toISOString()}. Read only: edits here are not imported.`], [], HEADER, ...rows];
}

async function exportToSheet(prisma) {
  const sheetId = process.env.ASSET_SHEET_ID;
  if (!sheetId) throw new Error('ASSET_SHEET_ID is not set');
  const client = require('./client');
  const { token } = await client.getAccessToken({ readOnly: false });
  const rows = await buildExportRows(prisma);
  await client.replaceTab(token, sheetId, EXPORT_TAB, rows);
  return rows.length - 3;
}

// Checked hourly; runs once per UTC day at or after ASSET_SHEET_EXPORT_HOUR
// (default 08:00 UTC). The last run date is stored so a redeploy does not
// trigger a second export or skip one.
function startNightlyExport() {
  if (!C.isEnabled('ASSETS_ENABLED') || !C.isEnabled('ASSET_SHEET_EXPORT')) return;
  const hour = Number(process.env.ASSET_SHEET_EXPORT_HOUR ?? 8);
  const tick = async () => {
    try {
      const now = new Date();
      if (now.getUTCHours() < hour) return;
      const today = now.toISOString().slice(0, 10);
      const prisma = getPrisma();
      await ensureAssetSchema(prisma);
      const claimed = await prisma.$queryRawUnsafe(`
        INSERT INTO "AssetSetting" ("key", "value") VALUES ('sheetExport.lastRun', to_jsonb($1::text))
        ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
        WHERE "AssetSetting"."value" <> EXCLUDED."value"
        RETURNING "key"`, today);
      if (!claimed.length) return;
      const count = await exportToSheet(prisma);
      console.log(`[Assets] Exported ${count} tasks to the "${EXPORT_TAB}" tab`);
    } catch (err) {
      console.error('[Assets] Sheet export failed:', err.message);
    }
  };
  setInterval(tick, 60 * 60 * 1000).unref();
  setTimeout(tick, 60 * 1000).unref();
  console.log(`[Assets] Nightly sheet export enabled (${hour}:00 UTC)`);
}

module.exports = { EXPORT_TAB, buildExportRows, exportToSheet, startNightlyExport };
