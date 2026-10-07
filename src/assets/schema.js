// Runtime schema for the asset tracker, same "CREATE TABLE IF NOT EXISTS"
// pattern as BoardTask / ImportRequest. Nothing here stores a rollup:
// progress, counts and workload are always computed (see queries.js).

const { DEFAULT_DISCIPLINES, DEFAULT_CONTENT_TYPES } = require('./constants');
const { newId } = require('./db');

const TS = `TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS "AssetDiscipline" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "sortOrder" INT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetContentType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "sortOrder" INT NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetTaskTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskCode" TEXT NOT NULL UNIQUE,
    "contentTypeId" TEXT NOT NULL REFERENCES "AssetContentType"("id") ON DELETE CASCADE,
    "taskNumber" INT NOT NULL DEFAULT 0,
    "discipline" TEXT NOT NULL,
    "deliverable" TEXT NOT NULL,
    "definitionOfDone" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" ${TS},
    "updatedAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetDev" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "discipline" TEXT,
    "secondaryDiscipline" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "discordProfileUrl" TEXT,
    "discordUserId" TEXT,
    "notes" TEXT,
    "userId" TEXT REFERENCES "User"("id") ON DELETE SET NULL,
    "createdAt" ${TS},
    "updatedAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetDevDiscipline" (
    "devId" TEXT NOT NULL REFERENCES "AssetDev"("id") ON DELETE CASCADE,
    "discipline" TEXT NOT NULL,
    PRIMARY KEY ("devId", "discipline")
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" DOUBLE PRECISION NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Planning',
    "targetRelease" DATE,
    "leadDevId" TEXT REFERENCES "AssetDev"("id") ON DELETE SET NULL,
    "leadName" TEXT,
    "notes" TEXT,
    "notionUrl" TEXT,
    "createdAt" ${TS},
    "updatedAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetContentItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemNumber" INT NOT NULL UNIQUE,
    "updateId" TEXT NOT NULL REFERENCES "AssetUpdate"("id") ON DELETE CASCADE,
    "contentTypeId" TEXT NOT NULL REFERENCES "AssetContentType"("id"),
    "displayName" TEXT,
    "internalName" TEXT NOT NULL,
    "ownerDevId" TEXT REFERENCES "AssetDev"("id") ON DELETE SET NULL,
    "ownerName" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'Medium',
    "notes" TEXT,
    "notionUrl" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" ${TS},
    "updatedAt" ${TS},
    UNIQUE ("updateId", "internalName")
  )`,
  // A task holds only the manual fields. Discipline, deliverable, definition
  // of done and required come from its template, so a rebuild can never
  // detach an assignment or a status from the task it belongs to.
  `CREATE TABLE IF NOT EXISTS "AssetTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ref" SERIAL UNIQUE,
    "contentItemId" TEXT NOT NULL REFERENCES "AssetContentItem"("id") ON DELETE CASCADE,
    "templateId" TEXT NOT NULL REFERENCES "AssetTaskTemplate"("id"),
    "status" TEXT NOT NULL DEFAULT 'Not Started',
    "assigneeDevId" TEXT REFERENCES "AssetDev"("id") ON DELETE SET NULL,
    "dueDate" DATE,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" ${TS},
    "updatedAt" ${TS},
    UNIQUE ("contentItemId", "templateId")
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "updateId" TEXT,
    "contentItemId" TEXT,
    "taskId" TEXT,
    "action" TEXT NOT NULL,
    "field" TEXT,
    "before" JSONB,
    "after" JSONB,
    "label" TEXT,
    "source" TEXT NOT NULL DEFAULT 'human',
    "actorUserId" TEXT,
    "actorName" TEXT NOT NULL DEFAULT 'System',
    "suggestionId" TEXT,
    "evidence" JSONB,
    "createdAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetSavedView" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "createdAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" JSONB NOT NULL,
    "updatedAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetAgentChannel" (
    "channelId" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "addedByName" TEXT,
    "createdAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetAgentBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'claimed',
    "messageCount" INT NOT NULL DEFAULT 0,
    "relevant" BOOLEAN,
    "suggestionCount" INT NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" ${TS},
    "finishedAt" TIMESTAMP(3)
  )`,
  // "channelId" is the thread id when the message was posted in a thread,
  // so each thread is batched as its own conversation.
  `CREATE TABLE IF NOT EXISTS "AssetAgentMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "parentChannelId" TEXT,
    "guildId" TEXT,
    "authorDiscordId" TEXT NOT NULL,
    "authorName" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "batchId" TEXT,
    "createdAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetAgentSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payload" JSONB NOT NULL,
    "appliedPayload" JSONB,
    "before" JSONB,
    "after" JSONB,
    "summary" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "dedupeKey" TEXT NOT NULL,
    "batchId" TEXT,
    "updateId" TEXT,
    "contentItemId" TEXT,
    "taskId" TEXT,
    "discordChannelId" TEXT,
    "discordMessageId" TEXT,
    "needsDiscordPost" BOOLEAN NOT NULL DEFAULT true,
    "resolvedByUserId" TEXT,
    "resolvedByName" TEXT,
    "resolvedVia" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" ${TS}
  )`,
  `CREATE TABLE IF NOT EXISTS "AssetAgentUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT,
    "pass" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INT NOT NULL DEFAULT 0,
    "outputTokens" INT NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" ${TS}
  )`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS "AssetTaskTemplate_contentTypeId_idx" ON "AssetTaskTemplate"("contentTypeId")`,
  `CREATE INDEX IF NOT EXISTS "AssetDev_discordUserId_idx" ON "AssetDev"("discordUserId")`,
  `CREATE INDEX IF NOT EXISTS "AssetContentItem_updateId_idx" ON "AssetContentItem"("updateId")`,
  `CREATE INDEX IF NOT EXISTS "AssetTask_contentItemId_idx" ON "AssetTask"("contentItemId")`,
  `CREATE INDEX IF NOT EXISTS "AssetTask_assigneeDevId_idx" ON "AssetTask"("assigneeDevId")`,
  `CREATE INDEX IF NOT EXISTS "AssetTask_status_idx" ON "AssetTask"("status")`,
  `CREATE INDEX IF NOT EXISTS "AssetActivity_taskId_idx" ON "AssetActivity"("taskId")`,
  `CREATE INDEX IF NOT EXISTS "AssetActivity_contentItemId_idx" ON "AssetActivity"("contentItemId")`,
  `CREATE INDEX IF NOT EXISTS "AssetActivity_updateId_createdAt_idx" ON "AssetActivity"("updateId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "AssetSavedView_userId_idx" ON "AssetSavedView"("userId")`,
  `CREATE INDEX IF NOT EXISTS "AssetAgentMessage_unbatched_idx" ON "AssetAgentMessage"("channelId", "postedAt") WHERE "batchId" IS NULL`,
  `CREATE INDEX IF NOT EXISTS "AssetAgentMessage_postedAt_idx" ON "AssetAgentMessage"("postedAt")`,
  `CREATE INDEX IF NOT EXISTS "AssetAgentSuggestion_status_idx" ON "AssetAgentSuggestion"("status", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "AssetAgentSuggestion_dedupeKey_idx" ON "AssetAgentSuggestion"("dedupeKey")`,
  `CREATE INDEX IF NOT EXISTS "AssetAgentUsage_createdAt_idx" ON "AssetAgentUsage"("createdAt")`,
];

const ready = new WeakMap();

async function seedDefaults(prisma) {
  const [{ n: disciplines }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetDiscipline"`);
  if (!disciplines) {
    for (const [i, name] of DEFAULT_DISCIPLINES.entries()) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "AssetDiscipline" ("name", "sortOrder") VALUES ($1, $2) ON CONFLICT DO NOTHING`, name, i);
    }
  }
  const [{ n: types }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetContentType"`);
  if (!types) {
    for (const [i, name] of DEFAULT_CONTENT_TYPES.entries()) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "AssetContentType" ("id", "name", "sortOrder") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, newId(), name, i);
    }
  }
}

// Guarded per client so a failed first attempt is retried on the next call.
async function ensureAssetSchema(prisma) {
  if (!ready.has(prisma)) {
    const run = (async () => {
      for (const sql of TABLES) await prisma.$executeRawUnsafe(sql);
      // Update numbers were whole numbers at first; the real tracker has 3.5.
      await prisma.$executeRawUnsafe(`ALTER TABLE "AssetUpdate" ALTER COLUMN "number" TYPE DOUBLE PRECISION`);
      // Lets a whole Discord category be allowlisted, not just single channels.
      await prisma.$executeRawUnsafe(`ALTER TABLE "AssetAgentMessage" ADD COLUMN IF NOT EXISTS "categoryId" TEXT`);
      for (const sql of INDEXES) await prisma.$executeRawUnsafe(sql);
      await seedDefaults(prisma);
    })();
    ready.set(prisma, run);
    run.catch(() => ready.delete(prisma));
  }
  await ready.get(prisma);
}

module.exports = { ensureAssetSchema };
