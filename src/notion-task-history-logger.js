// notion-task-history-logger.js
// Logs status/assignee/priority transitions to NotionTaskHistory. Notion's
// free-text page content/comments are read live from Notion (see the
// /:id/content endpoint) rather than logged here — this table only tracks
// the structured fields DevTrack itself manages, regardless of whether the
// change came from the dashboard (source: 'app') or a Notion edit synced in
// via webhook (source: 'notion').

let tableReady;

async function ensureNotionTaskHistoryTable(prisma) {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "NotionTaskHistory" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "notionTaskId" TEXT NOT NULL,
          "action" TEXT NOT NULL,
          "detail" TEXT,
          "source" TEXT NOT NULL,
          "actorName" TEXT NOT NULL,
          "actorId" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "NotionTaskHistory_notionTaskId_fkey"
            FOREIGN KEY ("notionTaskId") REFERENCES "NotionTask"("id")
            ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "NotionTaskHistory_notionTaskId_idx" ON "NotionTaskHistory"("notionTaskId")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "NotionTaskHistory_createdAt_idx" ON "NotionTaskHistory"("createdAt")`);
    })();
  }
  await tableReady;
}

async function log(prisma, { notionTaskId, action, detail, source, actorName, actorId }) {
  if (!notionTaskId) return;
  try {
    await ensureNotionTaskHistoryTable(prisma);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "NotionTaskHistory" ("id", "notionTaskId", "action", "detail", "source", "actorName", "actorId")
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, require('crypto').randomUUID(), notionTaskId, action, detail || null, source, actorName || 'System', actorId || null);
  } catch (err) {
    console.error('[NotionTaskHistory] Failed to log:', err.message);
  }
}

module.exports = { ensureNotionTaskHistoryTable, log };
