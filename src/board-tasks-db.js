// board-tasks-db.js
// Raw-SQL data layer for the native dev task board (BoardTask), replacing
// the old Notion-synced kanban. Same runtime "CREATE TABLE IF NOT EXISTS"
// pattern as NotionTask/ImportRequest rather than a Prisma model.

let tableReady;

async function ensureBoardTaskTable(prisma) {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "BoardTask" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "title" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'todo',
          "details" TEXT,
          "notionUrl" TEXT,
          "update" TEXT,
          "assigneeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          "createdById" TEXT REFERENCES "User"(id) ON DELETE SET NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Migrate from the original single-assignee column (cards created
      // before multi-assignee support) to the array column, then drop it.
      await prisma.$executeRawUnsafe(`ALTER TABLE "BoardTask" ADD COLUMN IF NOT EXISTS "assigneeIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`);
      await prisma.$executeRawUnsafe(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'BoardTask' AND column_name = 'assigneeId') THEN
            UPDATE "BoardTask" SET "assigneeIds" = ARRAY["assigneeId"]
              WHERE "assigneeId" IS NOT NULL AND (cardinality("assigneeIds") = 0);
            ALTER TABLE "BoardTask" DROP COLUMN "assigneeId";
          END IF;
        END $$;
      `);
      // Defensive add for tables created before the "update" field existed.
      await prisma.$executeRawUnsafe(`ALTER TABLE "BoardTask" ADD COLUMN IF NOT EXISTS "update" TEXT`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BoardTask_status_idx" ON "BoardTask"("status")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BoardTask_assigneeIds_idx" ON "BoardTask" USING GIN ("assigneeIds")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BoardTask_tags_idx" ON "BoardTask" USING GIN ("tags")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BoardTask_update_idx" ON "BoardTask"("update")`);
    })();
  }
  await tableReady;
}

// assignees is resolved live from the current assigneeIds array, so a
// renamed/deleted user reflects immediately without needing a rewrite.
const SELECT_FIELDS = `
  bt.*,
  COALESCE(
    (SELECT json_agg(jsonb_build_object('id', u.id, 'name', u.name) ORDER BY u.name) FROM "User" u WHERE u.id = ANY(bt."assigneeIds")),
    '[]'
  ) AS assignees
`;

async function create(prisma, { title, status, details, notionUrl, update: updateVersion, assigneeIds, tags, createdById }) {
  const id = require('crypto').randomUUID();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "BoardTask" ("id", "title", "status", "details", "notionUrl", "update", "assigneeIds", "tags", "createdById")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
  `, id, title, status || 'todo', details || null, notionUrl || null, updateVersion || null, assigneeIds || [], tags || [], createdById || null);
  return fetchById(prisma, id);
}

async function fetchById(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SELECT_FIELDS} FROM "BoardTask" bt WHERE bt.id = $1`,
    id
  );
  return rows[0] || null;
}

async function fetchAll(prisma, { status, assigneeId, tag, update: updateVersion, search } = {}) {
  const clauses = [];
  const values = [];
  let idx = 1;
  if (status && status !== 'all') { clauses.push(`bt.status = $${idx++}`); values.push(status); }
  if (assigneeId && assigneeId !== 'all') {
    if (assigneeId === 'unassigned') clauses.push(`cardinality(bt."assigneeIds") = 0`);
    else { clauses.push(`$${idx++} = ANY(bt."assigneeIds")`); values.push(assigneeId); }
  }
  if (tag && tag !== 'all') { clauses.push(`$${idx++} = ANY(bt.tags)`); values.push(tag); }
  if (updateVersion && updateVersion !== 'all') {
    if (updateVersion === 'none') clauses.push(`bt."update" IS NULL`);
    else { clauses.push(`bt."update" = $${idx++}`); values.push(updateVersion); }
  }
  if (search) { clauses.push(`bt.title ILIKE $${idx++}`); values.push(`%${search}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return prisma.$queryRawUnsafe(
    `SELECT ${SELECT_FIELDS} FROM "BoardTask" bt ${where} ORDER BY bt."updatedAt" DESC`,
    ...values
  );
}

async function update(prisma, id, { title, status, details, notionUrl, update: updateVersion, assigneeIds, tags }) {
  const updates = [];
  const values = [];
  let idx = 1;
  if (title !== undefined) { updates.push(`"title" = $${idx++}`); values.push(title); }
  if (status !== undefined) { updates.push(`"status" = $${idx++}`); values.push(status); }
  if (details !== undefined) { updates.push(`"details" = $${idx++}`); values.push(details || null); }
  if (notionUrl !== undefined) { updates.push(`"notionUrl" = $${idx++}`); values.push(notionUrl || null); }
  if (updateVersion !== undefined) { updates.push(`"update" = $${idx++}`); values.push(updateVersion || null); }
  if (assigneeIds !== undefined) { updates.push(`"assigneeIds" = $${idx++}`); values.push(assigneeIds || []); }
  if (tags !== undefined) { updates.push(`"tags" = $${idx++}`); values.push(tags || []); }
  if (!updates.length) return fetchById(prisma, id);
  updates.push(`"updatedAt" = CURRENT_TIMESTAMP`);
  values.push(id);
  await prisma.$executeRawUnsafe(`UPDATE "BoardTask" SET ${updates.join(', ')} WHERE id = $${idx}`, ...values);
  return fetchById(prisma, id);
}

async function deleteTask(prisma, id) {
  await prisma.$executeRawUnsafe(`DELETE FROM "BoardTask" WHERE id = $1`, id);
}

async function listTags(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT DISTINCT unnest(tags) AS tag FROM "BoardTask" ORDER BY tag`);
  return rows.map(r => r.tag);
}

async function listUpdates(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT DISTINCT "update" FROM "BoardTask" WHERE "update" IS NOT NULL ORDER BY "update"`);
  return rows.map(r => r.update);
}

module.exports = {
  ensureBoardTaskTable,
  create,
  fetchById,
  fetchAll,
  update,
  deleteTask,
  listTags,
  listUpdates,
};
