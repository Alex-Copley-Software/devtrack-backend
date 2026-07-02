// team-reports-db.js
// Storage for generated AI standup reports, plus the activity-aggregation
// query that feeds them. Follows the same runtime table-creation pattern as
// NotionTask/ImportRequest.

let tableReady;

async function ensureTeamReportTable(prisma) {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "TeamReport" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "period" TEXT NOT NULL,
          "periodStart" TIMESTAMP(3) NOT NULL,
          "periodEnd" TIMESTAMP(3) NOT NULL,
          "content" TEXT NOT NULL,
          "generatedById" TEXT,
          "generatedByName" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "TeamReport_createdAt_idx" ON "TeamReport"("createdAt")`);
    })();
  }
  await tableReady;
}

async function saveReport(prisma, { period, periodStart, periodEnd, content, generatedById, generatedByName }) {
  const id = require('crypto').randomUUID();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "TeamReport" ("id", "period", "periodStart", "periodEnd", "content", "generatedById", "generatedByName")
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, id, period, periodStart, periodEnd, content, generatedById || null, generatedByName || null);
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "TeamReport" WHERE id = $1`, id);
  return rows[0];
}

async function listReports(prisma, { limit = 20 } = {}) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM "TeamReport" ORDER BY "createdAt" DESC LIMIT $1`,
    limit
  );
}

async function getReport(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "TeamReport" WHERE id = $1`, id);
  return rows[0] || null;
}

const ACTIVITY_CAP_PER_ENGINEER = 50;

// Gathers each engineer's activity within [start, end] across bug/suggestion
// history (real audit trail), imports, and Notion tasks (current state of
// items touched in the window — there's no change-history table for those
// yet, so it's "what's in this state as of now that was touched then", not
// a true before/after diff).
async function buildActivitySummary(prisma, start, end) {
  const users = await prisma.$queryRawUnsafe(`SELECT id, name FROM "User" WHERE role = 'engineer' ORDER BY name`);
  const engineerByName = new Map(users.map(u => [u.name, u]));
  const engineerById = new Map(users.map(u => [u.id, u]));

  const history = await prisma.$queryRawUnsafe(`
    SELECT rh."actorName", rh.action, rh.detail, rh."createdAt",
           r.title AS "reportTitle", r.type::text AS "reportType"
    FROM "ReportHistory" rh
    JOIN "Report" r ON r.id = rh."reportId"
    WHERE rh."createdAt" >= $1 AND rh."createdAt" <= $2
    ORDER BY rh."createdAt" ASC
  `, start, end);

  const imports = await prisma.$queryRawUnsafe(`
    SELECT ir.title, ir.status, ir."assetType", ir."updateVersion", ir."updatedAt", u.name AS "assigneeName"
    FROM "ImportRequest" ir
    LEFT JOIN "User" u ON u.id = ir."assignedToId"
    WHERE ir."updatedAt" >= $1 AND ir."updatedAt" <= $2
    ORDER BY ir."updatedAt" ASC
  `, start, end).catch(() => []); // table may not exist yet if no imports have ever been created

  const tasksRaw = await prisma.$queryRawUnsafe(`
    SELECT nt.title, nt.status, nt.priority, nt."updatedAt",
      COALESCE((SELECT array_agg(u.id) FROM "User" u WHERE u.role = 'engineer' AND u."notionNickname" = ANY(nt."assigneeNicknames")), ARRAY[]::TEXT[]) AS "assigneeIds"
    FROM "NotionTask" nt
    WHERE nt."updatedAt" >= $1 AND nt."updatedAt" <= $2
    ORDER BY nt."updatedAt" ASC
  `, start, end).catch(() => []);

  const byEngineer = new Map();
  function bucket(name) {
    if (!byEngineer.has(name)) byEngineer.set(name, { name, bugActivity: [], importActivity: [], taskActivity: [] });
    return byEngineer.get(name);
  }
  for (const u of users) bucket(u.name); // include engineers with zero activity too

  for (const h of history) {
    if (!engineerByName.has(h.actorName)) continue; // skip non-engineer actors (reporters, Discord bot)
    const b = bucket(h.actorName);
    if (b.bugActivity.length < ACTIVITY_CAP_PER_ENGINEER) {
      b.bugActivity.push({ action: h.action, detail: h.detail, reportTitle: h.reportTitle, reportType: h.reportType, at: h.createdAt });
    }
  }
  for (const i of imports) {
    if (!i.assigneeName) continue;
    const b = bucket(i.assigneeName);
    if (b.importActivity.length < ACTIVITY_CAP_PER_ENGINEER) {
      b.importActivity.push({ title: i.title, status: i.status, assetType: i.assetType, updateVersion: i.updateVersion, at: i.updatedAt });
    }
  }
  for (const t of tasksRaw) {
    for (const id of (t.assigneeIds || [])) {
      const u = engineerById.get(id);
      if (!u) continue;
      const b = bucket(u.name);
      if (b.taskActivity.length < ACTIVITY_CAP_PER_ENGINEER) {
        b.taskActivity.push({ title: t.title, status: t.status, priority: t.priority, at: t.updatedAt });
      }
    }
  }

  return {
    engineers: [...byEngineer.values()],
    totals: {
      bugActions: history.length,
      importsTouched: imports.length,
      tasksTouched: tasksRaw.length,
    },
  };
}

module.exports = {
  ensureTeamReportTable,
  saveReport,
  listReports,
  getReport,
  buildActivitySummary,
};
