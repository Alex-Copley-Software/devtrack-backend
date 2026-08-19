const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function ensureCreditColumns() {
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "creditedDiscordUserId" TEXT`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "creditedDiscordUser" TEXT`);
}

async function ensureCreditRequestTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "CreditRequest" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "reportId" TEXT NOT NULL REFERENCES "Report"(id) ON DELETE CASCADE,
      "requestedDiscordUserId" TEXT NOT NULL,
      "requestedDiscordUser" TEXT NOT NULL,
      "ownerDiscordUserId" TEXT,
      "threadId" TEXT NOT NULL,
      "promptMessageId" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "resolvedByDiscordUserId" TEXT,
      "resolvedByDiscordUser" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "escalatedAt" TIMESTAMP(3),
      "resolvedAt" TIMESTAMP(3)
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditRequest_reportId_idx" ON "CreditRequest"("reportId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditRequest_status_idx" ON "CreditRequest"("status")`);
}

(async () => {
  await ensureCreditColumns();
  await ensureCreditRequestTable();

  const cols = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Report' AND column_name IN ('creditedDiscordUserId','creditedDiscordUser')`
  );
  console.log('Report credit columns:', cols);

  const tbl = await prisma.$queryRawUnsafe(`SELECT to_regclass('public."CreditRequest"')::text AS exists`);
  console.log('CreditRequest table:', tbl);

  const idx = await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'CreditRequest'`
  );
  console.log('CreditRequest indexes:', idx);

  // Round-trip test: insert, read, delete a throwaway row (no real Report FK,
  // so use a real existing report id if one exists, otherwise skip insert).
  const anyReport = await prisma.$queryRawUnsafe(`SELECT id FROM "Report" LIMIT 1`);
  if (anyReport.length) {
    const reportId = anyReport[0].id;
    const testId = 'verify-' + Date.now();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "CreditRequest" ("id","reportId","requestedDiscordUserId","requestedDiscordUser","threadId") VALUES ($1,$2,$3,$4,$5)`,
      testId, reportId, 'test-user-id', 'TestUser#0001', 'test-thread-id'
    );
    const inserted = await prisma.$queryRawUnsafe(`SELECT * FROM "CreditRequest" WHERE id = $1`, testId);
    console.log('Round-trip insert:', inserted);
    await prisma.$executeRawUnsafe(`DELETE FROM "CreditRequest" WHERE id = $1`, testId);
    const gone = await prisma.$queryRawUnsafe(`SELECT * FROM "CreditRequest" WHERE id = $1`, testId);
    console.log('Round-trip cleanup confirmed, remaining rows:', gone.length);
  } else {
    console.log('No existing Report rows to test insert against — skipping round-trip test.');
  }

  process.exit(0);
})().catch(err => {
  console.error('VERIFY FAILED:', err.message);
  process.exit(1);
});
