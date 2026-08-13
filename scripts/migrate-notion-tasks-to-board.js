// One-time migration: copies existing NotionTask rows into the new
// independent BoardTask table, now that the Tasks page no longer syncs
// with Notion. Run once via `node scripts/migrate-notion-tasks-to-board.js`
// (e.g. through `railway ssh -s devtrack-backend`). Safe to re-run — it
// skips any NotionTask whose title+notionUrl pair already has a matching
// BoardTask, so accidental double-runs don't duplicate cards.
//
// Simplifications from the old multi-assignee Notion model: BoardTask has a
// single assigneeId, so only the first live-mapped assignee is kept.
// NotionTask had no free-text "details" field, so it's left blank; tags are
// a brand-new concept and start empty. The original notionUrl is preserved
// as the new card's link-out field.

const { PrismaClient } = require('@prisma/client');
const { ensureBoardTaskTable } = require('../src/board-tasks-db');
const { ensureBoardTaskHistoryTable } = require('../src/board-task-history-logger');
const prisma = new PrismaClient();

const STATUS_MAP = {
  'Requires Prerequisite': 'needs_prerequisite',
  'Not started':           'todo',
  'In progress':           'in_progress',
  'Waiting for Import':    'in_progress',
  'Done':                  'done',
  'Live Game':              'archive',
  'Archive':                'archive',
};

function mapStatus(notionStatus) {
  return STATUS_MAP[notionStatus] || 'todo';
}

async function main() {
  await ensureBoardTaskTable(prisma);
  await ensureBoardTaskHistoryTable(prisma);

  const exists = await prisma.$queryRawUnsafe(`SELECT to_regclass('"NotionTask"') AS reg`);
  if (!exists[0]?.reg) {
    console.log('No NotionTask table found — nothing to migrate.');
    return;
  }

  const notionTasks = await prisma.$queryRawUnsafe(`
    SELECT nt.*,
      COALESCE(
        (SELECT array_agg(u.id) FROM "User" u WHERE u.role = 'engineer' AND u."notionNickname" = ANY(nt."assigneeNicknames")),
        ARRAY[]::TEXT[]
      ) AS "liveAssigneeIds"
    FROM "NotionTask" nt
    ORDER BY nt."createdAt" ASC
  `);

  console.log(`Found ${notionTasks.length} NotionTask row(s) to migrate.`);

  let migrated = 0;
  let skipped = 0;

  for (const nt of notionTasks) {
    const already = await prisma.$queryRawUnsafe(
      `SELECT id FROM "BoardTask" WHERE title = $1 AND "notionUrl" IS NOT DISTINCT FROM $2 LIMIT 1`,
      nt.title, nt.notionUrl || null
    );
    if (already.length) { skipped++; continue; }

    const status = mapStatus(nt.status);
    const assigneeId = (nt.liveAssigneeIds || [])[0] || null;
    const id = require('crypto').randomUUID();

    await prisma.$executeRawUnsafe(`
      INSERT INTO "BoardTask" ("id", "title", "status", "notionUrl", "assigneeId", "tags", "createdAt")
      VALUES ($1,$2,$3,$4,$5,ARRAY[]::TEXT[],$6)
    `, id, nt.title, status, nt.notionUrl || null, assigneeId, nt.createdAt);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "BoardTaskHistory" ("id", "boardTaskId", "action", "detail", "actorName", "actorId")
      VALUES ($1,$2,'created',$3,'Migration',NULL)
    `, require('crypto').randomUUID(), id, `Migrated from Notion (was "${nt.status}")`);

    migrated++;
  }

  console.log(`Migrated ${migrated} card(s), skipped ${skipped} already-migrated card(s).`);
}

main()
  .catch(err => { console.error('[Migration] Failed:', err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
