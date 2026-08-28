const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  // Create a throwaway report satisfying all NOT NULL columns
  const report = await prisma.report.create({
    data: {
      type: 'bug',
      title: 'Verify accept bugLevel raw-SQL write',
      description: 'Throwaway row for verification, deleted immediately after.',
      discordUser: 'verify-script',
      discordChannel: '#verify',
      queued: true,
      status: 'queued',
    },
  });
  console.log('Created throwaway report:', report.id);

  // Exact same statement the accept route now runs for bugLevel
  await prisma.$executeRawUnsafe(
    `UPDATE "Report" SET "bugLevel" = $1::"BugLevel" WHERE id = $2`,
    'insignificant', report.id
  );

  const [row] = await prisma.$queryRawUnsafe(
    `SELECT id, "bugLevel"::text AS "bugLevel" FROM "Report" WHERE id = $1`, report.id
  );
  console.log('After accept-style raw SQL write:', row);

  await prisma.report.delete({ where: { id: report.id } });
  const gone = await prisma.$queryRawUnsafe(`SELECT id FROM "Report" WHERE id = $1`, report.id);
  console.log('Cleanup confirmed, remaining rows:', gone.length);

  process.exit(0);
})().catch(err => {
  console.error('VERIFY FAILED:', err.message);
  process.exit(1);
});
