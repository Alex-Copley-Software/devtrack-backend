#!/usr/bin/env node
// Local demo of the Assets page with no database and no deploy: an
// in-memory Postgres (PGlite) seeded with demo data, the real /api/assets
// routes, and the dashboard's static files, all on one port.
//
//   node scripts/assets-dev-server.js [--big] [--port 4321] [--static ../devtrack-dashboard]
//   node scripts/assets-dev-server.js --sheet <google sheet id>    the real tracker instead of demo data
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

// Runs a canned Discord conversation through the real agent pipeline with a
// stand-in for the two Claude calls, so the suggestions inbox has something
// to review without an API key. Pass --real-model to call Claude instead
// (needs ANTHROPIC_API_KEY).
async function seedDemoSuggestions(prisma) {
  const q = require('../src/assets/queries');
  const pipeline = require('../src/assets/agent/pipeline');
  const model = require('../src/assets/agent/model');
  const CHANNEL = '900000000000000100';
  const discord = name => `9000000000000000${String(['MrBee', 'Kaido', 'Sora', 'Mesh', 'Tex', 'Ani', 'Vex', 'Echo', 'Ricky', 'Brick', 'Quinn', 'Juno'].indexOf(name)).padStart(2, '0')}`;
  const tasks = await q.listTasksDetailed(prisma, {});
  const ref = (item, deliverable) => String(tasks.find(t => t.internalName === item && t.deliverable.startsWith(deliverable))?.ref || '');
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  if (!flag('real-model')) {
    const blank = { task_ref: '', status: '', assignee: '', due_date: '', note: '', blocker_reason: '', item_internal_name: '', display_name: '', content_type: '', update_number: '' };
    model.filter = async () => ({ relevant: true, model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 1800, output_tokens: 3 } });
    model.extract = async () => ({
      model: 'claude-sonnet-5-5', usage: { input_tokens: 9200, output_tokens: 760 },
      actions: [
        { ...blank, type: 'update_task_status', task_ref: ref('Aizen', 'Ability scripting'), status: 'Done', confidence: 0.94, reason: 'MrBee approved the Aizen ability scripting and asked for it to be marked done.', evidence: ['m2'] },
        { ...blank, type: 'assign_task', task_ref: ref('Ulquiorra', 'Ability VFX'), assignee: 'Vex', confidence: 0.88, reason: 'Vex said they will take the Ulquiorra VFX.', evidence: ['m3'] },
        { ...blank, type: 'set_due_date', task_ref: ref('Ulquiorra', 'Ability VFX'), due_date: day(5), confidence: 0.71, reason: 'Vex expects to have it done by the end of the week.', evidence: ['m3'] },
        { ...blank, type: 'add_task_note', task_ref: ref('Rukia', 'Unit mesh'), note: 'rbxassetid://7781234', confidence: 0.96, reason: 'Mesh posted the asset ID for the Rukia mesh.', evidence: ['m4'] },
        { ...blank, type: 'mark_blocked', task_ref: ref('HuecoMundo', 'Final build'), blocker_reason: 'waiting on the skybox from Sora', confidence: 0.83, reason: 'Brick cannot finish the Hueco Mundo build until the skybox is in.', evidence: ['m5'] },
        { ...blank, type: 'create_content_item', item_internal_name: 'Byakuya', display_name: 'Legendary', content_type: 'Unit', update_number: '900', confidence: 0.64, reason: 'Kaido proposed adding Byakuya as a legendary unit this update.', evidence: ['m6', 'm7'] },
        { ...blank, type: 'flag_unknown', note: 'A "bankai meter" UI element was discussed, but no content item or task matches it.', confidence: 0.4, reason: 'Could not map the bankai meter to anything in the tracker.', evidence: ['m8'] },
      ],
    });
  }

  await prisma.$executeRawUnsafe(`INSERT INTO "AssetAgentChannel" ("channelId", "label", "addedByName") VALUES ($1, '#dev-assets (demo)', 'Demo seed')`, CHANNEL);
  const lines = [
    ['Ricky', 'aizen abilities are all hooked up, no errors in the test place'],
    ['MrBee', 'tested it, looks great. approved, mark aizen scripting done'],
    ['Vex', "i'll take the ulquiorra vfx, should have it by end of the week"],
    ['Mesh', 'rukia mesh is uploaded: rbxassetid://7781234'],
    ['Brick', "can't finish the hueco mundo final build until sora gets me the skybox"],
    ['Kaido', 'thinking we add byakuya as a legendary this update'],
    ['MrBee', 'yeah lets do it, add him'],
    ['Sora', 'also do we still want that bankai meter UI thing?'],
  ];
  await pipeline.ingestMessages(prisma, lines.map(([name, content], i) => ({
    id: String(910000000000000000n + BigInt(i)), channelId: CHANNEL, guildId: '900000000000000000',
    authorDiscordId: discord(name), authorName: name, content, postedAt: new Date(Date.now() - (20 - i) * 60000).toISOString(),
  })));
  const result = await pipeline.tick(prisma);
  console.log(`Demo agent run: ${result.processed.map(b => b.error || `${b.suggestions} suggestions`).join(', ') || result.state}`);
}

async function main() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`); // match production, where timestamps are stored in UTC
  // Read TIMESTAMP columns (type 1114) as UTC, the way Prisma does. PGlite's default reads them as local time.
  const parsers = { 1114: value => new Date(`${value.replace(' ', 'T')}Z`) };
  const prisma = {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values, { parsers })).affectedRows ?? 0,
  };
  setPrisma(prisma);

  await pg.exec(`CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "name" TEXT, "email" TEXT, "role" TEXT, "pageAccess" TEXT[])`);
  for (const user of Object.values(USERS)) {
    await prisma.$executeRawUnsafe(`INSERT INTO "User" VALUES ($1, $2, $3, $4, $5::text[])`, user.id, user.name, user.email, user.role, ['bugs', 'assets']);
  }
  await ensureAssetSchema(prisma);
  const sheetId = option('sheet', process.env.ASSET_SHEET_ID);
  if (sheetId) {
    // The real tracker, read from the sheet at startup. Nothing is written back.
    const { buildImportPlan } = require('../src/assets/sheets/parse');
    const { readSheetTabs, applyImportPlan } = require('../src/assets/sheets/importer');
    const plan = buildImportPlan(await readSheetTabs(sheetId, console.log));
    await applyImportPlan(prisma, plan);
    // The "dev" login becomes whoever has the most assigned tasks, so that role has something to edit.
    await prisma.$executeRawUnsafe(`UPDATE "AssetDev" SET "userId" = 'dev-dev' WHERE id = (
      SELECT "assigneeDevId" FROM "AssetTask" WHERE "assigneeDevId" IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1)`);
    const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetTask"`);
    console.log(`Loaded the sheet: ${plan.counts.updates} updates, ${plan.counts.items} items, ${n} tasks, ${plan.counts.problems} rows not mapped`);
  } else {
    const seeded = await seedDemo(prisma, { big: flag('big') });
    // The "dev" login is the roster's Ani, so that role can edit its own tasks.
    await prisma.$executeRawUnsafe(`UPDATE "AssetDev" SET "userId" = 'dev-dev' WHERE name = 'Ani'`);
    const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetTask"`);
    console.log(`Seeded ${seeded.updates} updates, ${seeded.items} items, ${n} tasks`);
    await seedDemoSuggestions(prisma);
  }

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
