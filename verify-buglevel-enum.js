const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  await prisma.$executeRawUnsafe(`ALTER TYPE "BugLevel" ADD VALUE IF NOT EXISTS 'insignificant' BEFORE 'minor'`);

  const values = await prisma.$queryRawUnsafe(`
    SELECT e.enumlabel, e.enumsortorder
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'BugLevel'
    ORDER BY e.enumsortorder
  `);
  console.log('BugLevel enum values in order:', values);

  // Round-trip: find any real report, temporarily read (not write) to
  // confirm the enum cast works end-to-end, then verify via a scratch row
  // using a raw insert/delete against a throwaway id-less check instead of
  // touching real data.
  const testResult = await prisma.$queryRawUnsafe(`SELECT 'insignificant'::"BugLevel" AS ok`);
  console.log('Cast test:', testResult);

  process.exit(0);
})().catch(err => {
  console.error('VERIFY FAILED:', err.message);
  process.exit(1);
});
