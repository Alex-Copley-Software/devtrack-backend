#!/usr/bin/env node
// Local demo of the Assets page with no database and no deploy: an
// in-memory Postgres (PGlite) seeded with demo data, the real /api/assets
// routes, and the dashboard's static files, all on one port.
//
//   node scripts/assets-dev-server.js [--big] [--port 4321] [--static ../devtrack-dashboard]
//
// Then open http://localhost:4321/dev-login?as=admin (or manager, dev, viewer).

const path = require('path');
const fs = require('fs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'assets-dev-secret';
process.env.BOT_SECRET = process.env.BOT_SECRET || 'assets-dev-bot-secret';
process.env.ASSETS_ENABLED = 'true';
process.env.ASSET_AGENT_ENABLED = process.env.ASSET_AGENT_ENABLED || 'true';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

const express = require('express');
const jwt = require('jsonwebtoken');
const { PGlite } = require('@electric-sql/pglite');
const { setPrisma } = require('../src/assets/db');
const { ensureAssetSchema } = require('../src/assets/schema');
const { seedDemo } = require('../src/assets/seed');

const USERS = {
  admin: { id: 'dev-admin', name: 'Alex Admin', email: 'admin@dev.local', role: 'admin' },
  manager: { id: 'dev-manager', name: 'Morgan Manager', email: 'manager@dev.local', role: 'engineer' },
  dev: { id: 'dev-dev', name: 'Ani Animator', email: 'ani@dev.local', role: 'qa' },
  viewer: { id: 'dev-viewer', name: 'Vic Viewer', email: 'viewer@dev.local', role: 'reviewer' },
};

async function main() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`); // match production, where timestamps are stored in UTC
  const prisma = {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).affectedRows ?? 0,
  };
  setPrisma(prisma);

  await pg.exec(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "name" TEXT, "email" TEXT, "role" TEXT, "pageAccess" TEXT[])`);
  for (const user of Object.values(USERS)) {
    await prisma.$executeRawUnsafe(`INSERT INTO "User" VALUES ($1, $2, $3, $4, $5::text[])`, user.id, user.name, user.email, user.role, ['bugs', 'assets']);
  }
  await ensureAssetSchema(prisma);
  const seeded = await seedDemo(prisma, { big: flag('big') });
  // The "dev" login is the roster's Ani, so that role can edit its own tasks.
  await prisma.$executeRawUnsafe(`UPDATE "AssetDev" SET "userId" = 'dev-dev' WHERE name = 'Ani'`);
  const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetTask"`);
  console.log(`Seeded ${seeded.updates} updates, ${seeded.items} items, ${n} tasks`);

  const app = express();
  app.use(express.json());
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/config', (req, res) => res.json({ assetsEnabled: true, assetAgentEnabled: process.env.ASSET_AGENT_ENABLED === 'true', discordServerId: '900000000000000000' }));
  app.use('/api/events', require('../src/routes/events'));
  app.use('/api/assets', require('../src/routes/assets'));
  try { app.use('/api/bot/assets', require('../src/routes/bot-assets')); } catch { /* added in a later phase */ }

  app.get('/dev-login', (req, res) => {
    const user = USERS[req.query.as] || USERS.admin;
    const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.send(`<script>
      localStorage.setItem('devtrack_token', ${JSON.stringify(token)});
      localStorage.setItem('devtrack_user', ${JSON.stringify(JSON.stringify({ ...user, pageAccess: ['bugs', 'assets'] }))});
      location.href = '/assets/';
    </script>`);
  });

  // The main dashboard at / would call the production API; send the root to the demo instead.
  app.get('/', (req, res) => res.redirect('/dev-login?as=admin'));

  const staticDir = path.resolve(option('static', path.join(__dirname, '../../netlify-dashboard-deploy')));
  if (fs.existsSync(staticDir)) app.use(express.static(staticDir));
  else console.log(`Static dir not found (${staticDir}); serving the API only.`);

  const port = Number(option('port', 4321));
  app.listen(port, () => {
    console.log(`Assets dev server on http://localhost:${port}`);
    console.log(`Sign in: http://localhost:${port}/dev-login?as=admin   (admin | manager | dev | viewer)`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
