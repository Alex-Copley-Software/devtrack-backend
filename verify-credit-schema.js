const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const cols = await prisma.$queryRawUnsafe(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Report' AND column_name IN ('creditedDiscordUserId','creditedDiscordUser')`
  );
  console.log('Report credit columns:', cols);

  const tbl = await prisma.$queryRawUnsafe(`SELECT to_regclass('public."CreditRequest"') AS exists`);
  console.log('CreditRequest table:', tbl);

  process.exit(0);
})();
