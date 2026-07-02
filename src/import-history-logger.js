// import-history-logger.js
// Logs actions to the ImportHistory table — mirrors history-logger.js
// (ReportHistory) but as raw SQL since ImportRequest itself is a runtime
// table, not a Prisma model.

let tableReady;

async function ensureImportHistoryTable(prisma) {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "ImportHistory" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "importRequestId" TEXT NOT NULL,
          "action" TEXT NOT NULL,
          "detail" TEXT,
          "actorName" TEXT NOT NULL,
          "actorId" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "ImportHistory_importRequestId_fkey"
            FOREIGN KEY ("importRequestId") REFERENCES "ImportRequest"("id")
            ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ImportHistory_importRequestId_idx" ON "ImportHistory"("importRequestId")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ImportHistory_createdAt_idx" ON "ImportHistory"("createdAt")`);
    })();
  }
  await tableReady;
}

const ACTION_LABELS = {
  queued: 'Import queued from Discord',
  ready: 'Accepted as ready',
  imported: 'Marked as imported',
  assigned: 'Assigned to engineer',
  updated: 'Details updated',
};

async function log(prisma, { importRequestId, action, detail, actorName, actorId }) {
  if (!importRequestId) return;
  try {
    await ensureImportHistoryTable(prisma);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ImportHistory" ("id", "importRequestId", "action", "detail", "actorName", "actorId")
      VALUES ($1,$2,$3,$4,$5,$6)
    `, require('crypto').randomUUID(), importRequestId, ACTION_LABELS[action] || action, detail || null, actorName || 'System', actorId || null);
  } catch (err) {
    // Non-fatal, do not break the request if history logging fails.
    console.error('[ImportHistory] Failed to log:', err.message);
  }
}

module.exports = { ensureImportHistoryTable, log };
