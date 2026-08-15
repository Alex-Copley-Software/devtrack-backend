// board-task-history-logger.js
// Logs title/status/assignee/tag changes to BoardTaskHistory. Everything
// here is app-originated (no external sync source anymore), unlike the old
// NotionTaskHistory which tracked a 'source' of 'app' vs 'notion'.

const ACTION_LABELS = {
  created: 'Card created',
  title: 'Title changed',
  status: 'Status changed',
  assigned: 'Assigned',
  tags: 'Tags updated',
  details: 'Details updated',
  update: 'Update value changed',
  priority: 'Priority changed',
};

let tableReady;

async function ensureBoardTaskHistoryTable(prisma) {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "BoardTaskHistory" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "boardTaskId" TEXT NOT NULL,
          "action" TEXT NOT NULL,
          "detail" TEXT,
          "actorName" TEXT NOT NULL,
          "actorId" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "BoardTaskHistory_boardTaskId_fkey"
            FOREIGN KEY ("boardTaskId") REFERENCES "BoardTask"("id")
            ON DELETE CASCADE ON UPDATE CASCADE
        )
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BoardTaskHistory_boardTaskId_idx" ON "BoardTaskHistory"("boardTaskId")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BoardTaskHistory_createdAt_idx" ON "BoardTaskHistory"("createdAt")`);
    })();
  }
  await tableReady;
}

async function log(prisma, { boardTaskId, action, detail, actorName, actorId }) {
  if (!boardTaskId) return;
  try {
    await ensureBoardTaskHistoryTable(prisma);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "BoardTaskHistory" ("id", "boardTaskId", "action", "detail", "actorName", "actorId")
      VALUES ($1,$2,$3,$4,$5,$6)
    `, require('crypto').randomUUID(), boardTaskId, ACTION_LABELS[action] || action, detail || null, actorName || 'System', actorId || null);
  } catch (err) {
    console.error('[BoardTaskHistory] Failed to log:', err.message);
  }
}

module.exports = { ensureBoardTaskHistoryTable, log };
