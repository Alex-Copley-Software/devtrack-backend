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

// Gathers each engineer's activity within [start, end] from the real audit
// trails: ReportHistory (bugs/suggestions), ImportHistory (imports), and
// BoardTaskHistory (dev board tasks — status/assignee/tag transitions).
// This is genuine "did X then Y" history, not just a snapshot of current
// state for items touched in the window.
async function buildActivitySummary(prisma, start, end) {
  const users = await prisma.$queryRawUnsafe(`SELECT id, name FROM "User" WHERE role = 'engineer' ORDER BY name`);
  const engineerByName = new Map(users.map(u => [u.name, u]));

  const bugHistory = await prisma.$queryRawUnsafe(`
    SELECT rh."actorName", rh.action, rh.detail, rh."createdAt",
           r.title AS "reportTitle", r.type::text AS "reportType"
    FROM "ReportHistory" rh
    JOIN "Report" r ON r.id = rh."reportId"
    WHERE rh."createdAt" >= $1 AND rh."createdAt" <= $2
    ORDER BY rh."createdAt" ASC
  `, start, end);

  const importHistoryRows = await prisma.$queryRawUnsafe(`
    SELECT ih."actorName", ih.action, ih.detail, ih."createdAt", ir.title AS "importTitle"
    FROM "ImportHistory" ih
    JOIN "ImportRequest" ir ON ir.id = ih."importRequestId"
    WHERE ih."createdAt" >= $1 AND ih."createdAt" <= $2
    ORDER BY ih."createdAt" ASC
  `, start, end).catch(() => []); // table may not exist yet if no imports have ever been created

  const taskHistoryRows = await prisma.$queryRawUnsafe(`
    SELECT th."actorName", th.action, th.detail, th."createdAt", bt.title AS "taskTitle"
    FROM "BoardTaskHistory" th
    JOIN "BoardTask" bt ON bt.id = th."boardTaskId"
    WHERE th."createdAt" >= $1 AND th."createdAt" <= $2
    ORDER BY th."createdAt" ASC
  `, start, end).catch(() => []); // table may not exist yet if no tasks have ever changed status

  const byEngineer = new Map();
  function bucket(name) {
    if (!byEngineer.has(name)) byEngineer.set(name, { name, bugActivity: [], importActivity: [], taskActivity: [] });
    return byEngineer.get(name);
  }
  for (const u of users) bucket(u.name); // include engineers with zero activity too

  for (const h of bugHistory) {
    if (!engineerByName.has(h.actorName)) continue; // skip non-engineer actors (reporters, Discord bot)
    const b = bucket(h.actorName);
    if (b.bugActivity.length < ACTIVITY_CAP_PER_ENGINEER) {
      b.bugActivity.push({ action: h.action, detail: h.detail, reportTitle: h.reportTitle, reportType: h.reportType, at: h.createdAt });
    }
  }
  for (const i of importHistoryRows) {
    if (!engineerByName.has(i.actorName)) continue;
    const b = bucket(i.actorName);
    if (b.importActivity.length < ACTIVITY_CAP_PER_ENGINEER) {
      b.importActivity.push({ action: i.action, detail: i.detail, importTitle: i.importTitle, at: i.createdAt });
    }
  }
  for (const t of taskHistoryRows) {
    if (!engineerByName.has(t.actorName)) continue; // skip non-engineer actors (admins/QA editing a card)
    const b = bucket(t.actorName);
    if (b.taskActivity.length < ACTIVITY_CAP_PER_ENGINEER) {
      b.taskActivity.push({ action: t.action, detail: t.detail, taskTitle: t.taskTitle, source: 'app', at: t.createdAt });
    }
  }

  return {
    engineers: [...byEngineer.values()],
    totals: {
      bugActions: bugHistory.length,
      importActions: importHistoryRows.length,
      taskActions: taskHistoryRows.length,
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
