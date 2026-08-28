const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const report = await prisma.report.create({
    data: {
      type: 'bug',
      title: 'Verify typed update on insignificant row',
      description: 'Throwaway row, deleted immediately after.',
      discordUser: 'verify-script',
      discordChannel: '#verify',
      queued: true,
      status: 'queued',
    },
  });

  await prisma.$executeRawUnsafe(
    `UPDATE "Report" SET "bugLevel" = 'insignificant'::"BugLevel" WHERE id = $1`, report.id
  );

  // Typed update that does NOT touch bugLevel, but still returns the full
  // row by default (same shape as notifyOwner/upvotes/etc. routes) — this
  // is exactly what crashed before regenerating the client.
  const updated = await prisma.report.update({
    where: { id: report.id },
    data: { notifyOwner: true },
  });
  console.log('Typed update returned bugLevel:', updated.bugLevel);

  await prisma.report.delete({ where: { id: report.id } });
  console.log('Cleanup done.');

  process.exit(0);
})().catch(err => {
  console.error('VERIFY FAILED:', err.message);
  process.exit(1);
});
