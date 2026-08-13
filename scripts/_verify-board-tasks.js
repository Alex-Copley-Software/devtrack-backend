const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const byStatus = await prisma.$queryRawUnsafe(`SELECT status, COUNT(*)::int AS count FROM "BoardTask" GROUP BY status ORDER BY status`);
  console.log('By status:', JSON.stringify(byStatus));
  const sample = await prisma.$queryRawUnsafe(`SELECT id, title, status, "notionUrl", "assigneeId" FROM "BoardTask" LIMIT 3`);
  console.log('Sample:', JSON.stringify(sample, null, 2));
}

main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
