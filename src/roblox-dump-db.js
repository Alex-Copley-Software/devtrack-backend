// roblox-dump-db.js
// Storage for raw JSON payloads posted from Roblox (game content snapshots,
// debug dumps, etc). Pure audit/debug log — no import-into-other-entities
// step; admins just view it as beautified JSON. Runtime table, same pattern
// as NotionTask/ImportRequest/TeamReport.

let tableReady;

async function ensureRobloxDumpTable(prisma) {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "RobloxDump" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "eventType" TEXT NOT NULL DEFAULT 'unknown',
          "robloxUserId" TEXT,
          "payload" JSONB NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "RobloxDump_eventType_idx" ON "RobloxDump"("eventType")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "RobloxDump_createdAt_idx" ON "RobloxDump"("createdAt")`);
    })();
  }
  await tableReady;
}

async function saveDump(prisma, { eventType, robloxUserId, payload }) {
  const id = require('crypto').randomUUID();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "RobloxDump" ("id", "eventType", "robloxUserId", "payload")
    VALUES ($1,$2,$3,$4::jsonb)
  `, id, eventType || 'unknown', robloxUserId || null, JSON.stringify(payload));
  return id;
}

// List view excludes the full payload (could be large) — just enough to
// pick a dump to open. payloadSize is the serialized byte length.
async function listDumps(prisma, { limit = 50, eventType } = {}) {
  const clauses = [];
  const values = [];
  let idx = 1;
  if (eventType && eventType !== 'all') { clauses.push(`"eventType" = $${idx++}`); values.push(eventType); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  values.push(limit);
  return prisma.$queryRawUnsafe(`
    SELECT "id", "eventType", "robloxUserId", "createdAt", octet_length("payload"::text) AS "payloadSize"
    FROM "RobloxDump"
    ${where}
    ORDER BY "createdAt" DESC
    LIMIT $${idx}
  `, ...values);
}

async function getDump(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "RobloxDump" WHERE id = $1`, id);
  return rows[0] || null;
}

async function deleteDump(prisma, id) {
  await prisma.$executeRawUnsafe(`DELETE FROM "RobloxDump" WHERE id = $1`, id);
}

async function listEventTypes(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT DISTINCT "eventType" FROM "RobloxDump" ORDER BY "eventType"`);
  return rows.map(r => r.eventType);
}

module.exports = {
  ensureRobloxDumpTable,
  saveDump,
  listDumps,
  getDump,
  deleteDump,
  listEventTypes,
};
