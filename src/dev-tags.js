// dev-tags.js
// Dev-name forum tags (Ricky, Bryan, ...) that testers put on their posts so a
// report says who it is for. The bot reads them off the forum post and sends
// them here; the bug queue filters and sorts by them.

const MAX_TAGS = 10;
const ready = new WeakSet();

async function ensureColumn(prisma) {
  if (ready.has(prisma)) return;
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "devTags" TEXT[] NOT NULL DEFAULT '{}'`);
  ready.add(prisma);
}

function clean(tags) {
  if (!Array.isArray(tags)) return [];
  const names = tags.map(t => String(t || '').trim().slice(0, 40)).filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_TAGS);
}

// items: [{ threadId, devTags }]. Returns the ids of reports whose tags changed.
async function setForThreads(prisma, items) {
  await ensureColumn(prisma);
  const changed = [];
  for (const item of Array.isArray(items) ? items : []) {
    const threadId = String(item?.threadId || '').trim();
    if (!threadId) continue;
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE "Report" SET "devTags" = $1::text[]
       WHERE "discordThreadId" = $2 AND "devTags" IS DISTINCT FROM $1::text[]
       RETURNING id`, clean(item.devTags), threadId);
    changed.push(...rows.map(r => r.id));
  }
  return changed;
}

module.exports = { ensureColumn, setForThreads, clean };
