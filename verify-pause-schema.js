const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function ensureTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ReportPauseState" (
      "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
      "paused" BOOLEAN NOT NULL DEFAULT false,
      "pausedAt" TIMESTAMP(3),
      "pausedByName" TEXT,
      "pausedById" TEXT,
      "resumedAt" TIMESTAMP(3),
      "resumedByName" TEXT,
      "resumedById" TEXT
    )
  `);
  await prisma.$executeRawUnsafe(`INSERT INTO "ReportPauseState" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PausedReportAttempt" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "threadId" TEXT NOT NULL,
      "channelId" TEXT,
      "discordUserId" TEXT,
      "discordUser" TEXT,
      "title" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "pinged" BOOLEAN NOT NULL DEFAULT false,
      "pingedAt" TIMESTAMP(3)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PausedReportAttempt_pinged_idx" ON "PausedReportAttempt"("pinged")`);
}

(async () => {
  await ensureTables();

  const stateRow = await prisma.$queryRawUnsafe(`SELECT * FROM "ReportPauseState" WHERE id = 'singleton'`);
  console.log('ReportPauseState singleton:', stateRow);

  const idx = await prisma.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE tablename = 'PausedReportAttempt'`);
  console.log('PausedReportAttempt indexes:', idx);

  // Round-trip: pause -> insert attempt -> fetch pending -> mark pinged -> resume
  await prisma.$executeRawUnsafe(
    `UPDATE "ReportPauseState" SET paused = true, "pausedAt" = NOW(), "pausedByName" = $1, "pausedById" = $2 WHERE id = 'singleton'`,
    'Verify Script', 'verify-id'
  );
  const testId = 'verify-attempt-' + Date.now();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PausedReportAttempt" ("id","threadId","channelId","discordUserId","discordUser","title") VALUES ($1,$2,$3,$4,$5,$6)`,
    testId, 'test-thread-id', 'test-channel-id', 'test-user-id', 'TestUser#0001', 'Test paused thread'
  );

  const pending = await prisma.$queryRawUnsafe(`SELECT * FROM "PausedReportAttempt" WHERE pinged = false AND id = $1`, testId);
  console.log('Pending attempt found:', pending);

  await prisma.$executeRawUnsafe(`UPDATE "PausedReportAttempt" SET pinged = true, "pingedAt" = NOW() WHERE id = $1`, testId);
  const afterPing = await prisma.$queryRawUnsafe(`SELECT pinged, "pingedAt" FROM "PausedReportAttempt" WHERE id = $1`, testId);
  console.log('After mark-pinged:', afterPing);

  await prisma.$executeRawUnsafe(
    `UPDATE "ReportPauseState" SET paused = false, "resumedAt" = NOW(), "resumedByName" = $1, "resumedById" = $2 WHERE id = 'singleton'`,
    'Verify Script', 'verify-id'
  );
  const finalState = await prisma.$queryRawUnsafe(`SELECT * FROM "ReportPauseState" WHERE id = 'singleton'`);
  console.log('Final state after resume:', finalState);

  // Cleanup the test attempt row so it doesn't linger in real data
  await prisma.$executeRawUnsafe(`DELETE FROM "PausedReportAttempt" WHERE id = $1`, testId);
  const gone = await prisma.$queryRawUnsafe(`SELECT * FROM "PausedReportAttempt" WHERE id = $1`, testId);
  console.log('Cleanup confirmed, remaining rows:', gone.length);

  process.exit(0);
})().catch(err => {
  console.error('VERIFY FAILED:', err.message);
  process.exit(1);
});
