// notion-tasks-db.js
// Shared raw-SQL data layer for the NotionTask table, used by both the
// inbound webhook route and the outbound REST route. Follows the same
// runtime "CREATE TABLE IF NOT EXISTS" pattern as ImportRequest/ImportFile
// (src/routes/imports.js) rather than a Prisma model, since this table is
// entirely driven by an external system's schema.

let tableReady;
let nicknameColumnReady;

async function ensureNotionTaskTable(prisma) {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "NotionTask" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "notionPageId" TEXT NOT NULL UNIQUE,
          "notionDatabaseId" TEXT NOT NULL,
          "title" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'Not started',
          "assigneeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          "assigneeNicknames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          "priority" TEXT,
          "dueDate" TIMESTAMP(3),
          "notionUrl" TEXT,
          "lastSyncedBy" TEXT,
          "notionLastEditedTime" TIMESTAMP(3),
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "NotionTask_notionDatabaseId_idx" ON "NotionTask"("notionDatabaseId")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "NotionTask_status_idx" ON "NotionTask"("status")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "NotionTask_assigneeIds_idx" ON "NotionTask" USING GIN ("assigneeIds")`);
    })();
  }
  await tableReady;
}

async function ensureNotionNicknameColumn(prisma) {
  if (!nicknameColumnReady) {
    nicknameColumnReady = (async () => {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notionNickname" TEXT`);
      await prisma.$executeRawUnsafe(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'User_notionNickname_key') THEN
            CREATE UNIQUE INDEX "User_notionNickname_key" ON "User"("notionNickname") WHERE "notionNickname" IS NOT NULL;
          END IF;
        END $$;
      `);
    })();
  }
  await nicknameColumnReady;
}

async function resolveAssigneeIds(prisma, nicknames) {
  if (!nicknames || !nicknames.length) return [];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM "User" WHERE role = 'engineer' AND "notionNickname" = ANY($1)`,
    nicknames
  );
  return rows.map(r => r.id);
}

async function resolveNicknamesForUsers(prisma, userIds) {
  if (!userIds || !userIds.length) return [];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "notionNickname" FROM "User" WHERE role = 'engineer' AND id = ANY($1) AND "notionNickname" IS NOT NULL`,
    userIds
  );
  return rows.map(r => r.notionNickname);
}

async function upsertFromNotion(prisma, task) {
  const { notionPageId, notionDatabaseId, title, status, assigneeNicknames, priority, dueDate, notionLastEditedTime, notionUrl } = task;
  const assigneeIds = await resolveAssigneeIds(prisma, assigneeNicknames);
  const id = require('crypto').randomUUID();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "NotionTask" (
      "id", "notionPageId", "notionDatabaseId", "title", "status",
      "assigneeIds", "assigneeNicknames", "priority", "dueDate", "notionUrl",
      "lastSyncedBy", "notionLastEditedTime", "updatedAt"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'notion',$11,CURRENT_TIMESTAMP)
    ON CONFLICT ("notionPageId") DO UPDATE SET
      "title" = EXCLUDED."title",
      "status" = EXCLUDED."status",
      "assigneeIds" = EXCLUDED."assigneeIds",
      "assigneeNicknames" = EXCLUDED."assigneeNicknames",
      "priority" = EXCLUDED."priority",
      "dueDate" = EXCLUDED."dueDate",
      "notionUrl" = EXCLUDED."notionUrl",
      "lastSyncedBy" = 'notion',
      "notionLastEditedTime" = EXCLUDED."notionLastEditedTime",
      "updatedAt" = CURRENT_TIMESTAMP
  `, id, notionPageId, notionDatabaseId, title, status, assigneeIds, assigneeNicknames || [],
     priority || null, dueDate ? new Date(dueDate) : null, notionUrl || null, notionLastEditedTime ? new Date(notionLastEditedTime) : null);

  return fetchByPageId(prisma, notionPageId);
}

// assigneeIds is resolved live from current User.notionNickname mappings
// (engineers only) rather than trusting the stored snapshot, so a nickname
// mapped in Admin after a task synced still shows up immediately.
const LIVE_ASSIGNEE_IDS_SQL = `
  COALESCE(
    (SELECT array_agg(u.id) FROM "User" u WHERE u.role = 'engineer' AND u."notionNickname" = ANY(nt."assigneeNicknames")),
    ARRAY[]::TEXT[]
  ) AS "assigneeIds"
`;

async function fetchByPageId(prisma, notionPageId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT nt.*, ${LIVE_ASSIGNEE_IDS_SQL} FROM "NotionTask" nt WHERE nt."notionPageId" = $1`,
    notionPageId
  );
  return rows[0] || null;
}

async function fetchById(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT nt.*, ${LIVE_ASSIGNEE_IDS_SQL} FROM "NotionTask" nt WHERE nt."id" = $1`,
    id
  );
  return rows[0] || null;
}

async function fetchAll(prisma, { status, notionDatabaseId, assigneeId, search } = {}) {
  const clauses = [];
  const values = [];
  let idx = 1;
  if (status && status !== 'all') { clauses.push(`nt.status = $${idx++}`); values.push(status); }
  if (notionDatabaseId && notionDatabaseId !== 'all') { clauses.push(`nt."notionDatabaseId" = $${idx++}`); values.push(notionDatabaseId); }
  if (search) { clauses.push(`nt.title ILIKE $${idx++}`); values.push(`%${search}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await prisma.$queryRawUnsafe(
    `SELECT nt.*, ${LIVE_ASSIGNEE_IDS_SQL} FROM "NotionTask" nt ${where} ORDER BY nt."updatedAt" DESC`,
    ...values
  );
  if (assigneeId && assigneeId !== 'all') return rows.filter(r => (r.assigneeIds || []).includes(assigneeId));
  return rows;
}

module.exports = {
  ensureNotionTaskTable,
  ensureNotionNicknameColumn,
  resolveAssigneeIds,
  resolveNicknamesForUsers,
  upsertFromNotion,
  fetchByPageId,
  fetchById,
  fetchAll,
};
