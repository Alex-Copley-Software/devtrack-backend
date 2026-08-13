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
          "assigneeId" TEXT REFERENCES "User"(id) ON DELETE SET NULL,
          "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          "createdById" TEXT REFERENCES "User"(id) ON DELETE SET NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BoardTask_status_idx" ON "BoardTask"("status")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BoardTask_assigneeId_idx" ON "BoardTask"("assigneeId")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "BoardTask_tags_idx" ON "BoardTask" USING GIN ("tags")`);
    })();
  }
  await tableReady;
}

const SELECT_FIELDS = `
  bt.*,
  CASE WHEN u.id IS NOT NULL THEN jsonb_build_object('id', u.id, 'name', u.name) ELSE NULL END AS assignee
`;

async function create(prisma, { title, status, details, notionUrl, assigneeId, tags, createdById }) {
  const id = require('crypto').randomUUID();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "BoardTask" ("id", "title", "status", "details", "notionUrl", "assigneeId", "tags", "createdById")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, id, title, status || 'todo', details || null, notionUrl || null, assigneeId || null, tags || [], createdById || null);
  return fetchById(prisma, id);
}

async function fetchById(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SELECT_FIELDS} FROM "BoardTask" bt LEFT JOIN "User" u ON u.id = bt."assigneeId" WHERE bt.id = $1`,
    id
  );
  return rows[0] || null;
}

async function fetchAll(prisma, { status, assigneeId, tag, search } = {}) {
  const clauses = [];
  const values = [];
  let idx = 1;
  if (status && status !== 'all') { clauses.push(`bt.status = $${idx++}`); values.push(status); }
  if (assigneeId && assigneeId !== 'all') {
    if (assigneeId === 'unassigned') clauses.push(`bt."assigneeId" IS NULL`);
    else { clauses.push(`bt."assigneeId" = $${idx++}`); values.push(assigneeId); }
  }
  if (tag && tag !== 'all') { clauses.push(`$${idx++} = ANY(bt.tags)`); values.push(tag); }
  if (search) { clauses.push(`bt.title ILIKE $${idx++}`); values.push(`%${search}%`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return prisma.$queryRawUnsafe(
    `SELECT ${SELECT_FIELDS} FROM "BoardTask" bt LEFT JOIN "User" u ON u.id = bt."assigneeId" ${where} ORDER BY bt."updatedAt" DESC`,
    ...values
  );
}

async function update(prisma, id, { title, status, details, notionUrl, assigneeId, tags }) {
  const updates = [];
  const values = [];
  let idx = 1;
  if (title !== undefined) { updates.push(`"title" = $${idx++}`); values.push(title); }
  if (status !== undefined) { updates.push(`"status" = $${idx++}`); values.push(status); }
  if (details !== undefined) { updates.push(`"details" = $${idx++}`); values.push(details || null); }
  if (notionUrl !== undefined) { updates.push(`"notionUrl" = $${idx++}`); values.push(notionUrl || null); }
  if (assigneeId !== undefined) { updates.push(`"assigneeId" = $${idx++}`); values.push(assigneeId || null); }
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

module.exports = {
  ensureBoardTaskTable,
  create,
  fetchById,
  fetchAll,
  update,
  deleteTask,
  listTags,
};
