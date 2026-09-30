const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: 'Ricky', mode: 'insensitive' } },
        { email: { contains: 'codex', mode: 'insensitive' } },
        { email: { contains: 'bot', mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, email: true, role: true, createdAt: true, pageAccess: true },
  });
  console.log('Matching accounts:', JSON.stringify(users, null, 2));
  process.exit(0);
})().catch(err => {
  console.error('CHECK FAILED:', err.message);
  process.exit(1);
});
