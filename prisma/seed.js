const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const engineers = [
    { name: 'Alex Rivera', email: 'alex@devtrack.com', role: 'engineer' },
    { name: 'Sam Chen', email: 'sam@devtrack.com', role: 'engineer' },
    { name: 'Jordan Park', email: 'jordan@devtrack.com', role: 'engineer' },
    { name: 'Morgan Liu', email: 'morgan@devtrack.com', role: 'engineer' },
    { name: 'Casey Wolf', email: 'casey@devtrack.com', role: 'engineer' },
  ];

  for (const eng of engineers) {
    const hashed = await bcrypt.hash('devtrack123', 10);
    const user = await prisma.user.upsert({
      where: { email: eng.email },
      update: {},
      create: { ...eng, password: hashed }
    });
    console.log(`Created user: ${user.name} (${user.email})`);
  }

  console.log('Seed complete! Default password for all accounts: devtrack123');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
