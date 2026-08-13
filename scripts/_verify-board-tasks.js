const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'BoardTask' ORDER BY column_name`);
  console.log('Columns:', cols.map(c => c.column_name).join(', '));
  const total = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "BoardTask"`);
  const withAssignee = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "BoardTask" WHERE cardinality("assigneeIds") > 0`);
  console.log('Total:', total[0].count, 'With at least one assignee:', withAssignee[0].count);
  const sample = await prisma.$queryRawUnsafe(`SELECT id, title, "assigneeIds" FROM "BoardTask" WHERE cardinality("assigneeIds") > 0 LIMIT 3`);
  console.log('Sample:', JSON.stringify(sample, null, 2));
}

main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
