#!/usr/bin/env node
// Adds (or removes) the demo data for the Assets page in whatever database
// DATABASE_URL points at: two fake updates numbered 900 and 901, a demo
// roster, and task templates for any content type that has none yet.
//
//   node scripts/seed-assets-demo.js            add the demo data
//   node scripts/seed-assets-demo.js --big      same, plus enough filler for 6,000+ tasks
//   node scripts/seed-assets-demo.js --remove   take it out again
//
// To try the page with no database at all, use scripts/assets-dev-server.js.

require('dotenv').config();
const { getPrisma } = require('../src/assets/db');
const { ensureAssetSchema } = require('../src/assets/schema');
const { seedDemo, removeDemo, hasDemo } = require('../src/assets/seed');

async function main() {
  const args = new Set(process.argv.slice(2));
  const prisma = getPrisma();
  await ensureAssetSchema(prisma);

  if (args.has('--remove')) {
    await removeDemo(prisma);
    console.log('Demo updates removed, along with demo roster entries nothing else refers to.');
    console.log('Template tasks the seed added are left in place; edit them on the Templates page.');
    return;
  }
  if (await hasDemo(prisma)) {
    console.log('Demo data is already there. Run with --remove first to reseed.');
    return;
  }
  const result = await seedDemo(prisma, { big: args.has('--big') });
  console.log(`Seeded ${result.updates} demo updates (#900, #901) with ${result.items} items.`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
