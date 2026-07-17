// update-log-db.js
// Storage for generated Discord update-log posts, plus the query that finds
// candidate "fixes" (resolved bug/crash/suggestion reports) to build one
// from. Follows the same runtime table-creation pattern as TeamReport.

let tableReady;

async function ensureUpdateLogTable(prisma) {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "UpdateLog" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "content" TEXT NOT NULL,
          "sinceDate" TIMESTAMP(3) NOT NULL,
          "untilDate" TIMESTAMP(3) NOT NULL,
          "reportIds" TEXT[] NOT NULL DEFAULT '{}',
          "generatedById" TEXT,
          "generatedByName" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "UpdateLog_createdAt_idx" ON "UpdateLog"("createdAt")`);
    })();
  }
  await tableReady;
}

async function saveUpdateLog(prisma, { content, sinceDate, untilDate, reportIds, generatedById, generatedByName }) {
  const id = require('crypto').randomUUID();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "UpdateLog" ("id", "content", "sinceDate", "untilDate", "reportIds", "generatedById", "generatedByName")
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, id, content, sinceDate, untilDate, reportIds || [], generatedById || null, generatedByName || null);
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "UpdateLog" WHERE id = $1`, id);
  return rows[0];
}

async function listUpdateLogs(prisma, { limit = 20 } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM "UpdateLog" ORDER BY "createdAt" DESC LIMIT $1`,
    limit
  );
}

async function getLastUpdateLogUntil(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT "untilDate" FROM "UpdateLog" ORDER BY "createdAt" DESC LIMIT 1`);
  return rows[0]?.untilDate || null;
}

// Resolved reports (bugs/crashes/suggestions) in [since, until], one row per
// report keyed off its most recent "Marked as Resolved" history entry — a
// real audit event, not just current status, so a report that was resolved
// then reopened doesn't get pulled in by a stale status field.
async function fetchResolvedFixes(prisma, since, until) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT ON (r.id)
      r.id, r.title, r.description, r.type::text AS type,
      r."bugLevel"::text AS "bugLevel", r."devNotes", r.priority::text AS priority,
      rh."createdAt" AS "resolvedAt"
    FROM "ReportHistory" rh
    JOIN "Report" r ON r.id = rh."reportId"
    WHERE rh.action = 'Marked as Resolved' AND rh."createdAt" >= $1 AND rh."createdAt" <= $2
    ORDER BY r.id, rh."createdAt" DESC
  `, since, until);
  return rows.sort((a, b) => new Date(a.resolvedAt) - new Date(b.resolvedAt));
}

module.exports = {
  ensureUpdateLogTable,
  saveUpdateLog,
  listUpdateLogs,
  getLastUpdateLogUntil,
  fetchResolvedFixes,
};
