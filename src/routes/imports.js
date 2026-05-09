const router = require('express').Router();
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { importStatus } = require('../discord-notifier');

const prisma = new PrismaClient();
const ASSET_TYPES = new Set([
  'Unit SFX',
  'Unit animations',
  'Enemy Animation',
  'Misc Animations',
  'Unit Models',
  'Unit VFX',
  'Maps',
  'Icons',
  'Cutscenes',
  'Music/Sounds',
  'Emotes',
  'General VFX',
  'Enemy Models',
  'Skins',
]);
let schemaReady;

function botAuth(req, res, next) {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized bot request' });
  }
  next();
}

async function ensureImportTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ImportRequest" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "description" TEXT,
      "assetType" TEXT,
      "updateVersion" TEXT,
      "status" TEXT NOT NULL DEFAULT 'queued',
      "assignedToId" TEXT,
      "discordUser" TEXT,
      "discordUserId" TEXT,
      "discordChannelId" TEXT,
      "discordMessageId" TEXT UNIQUE,
      "discordUrl" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ImportRequest_assignedToId_fkey"
        FOREIGN KEY ("assignedToId") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ImportFile" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "importRequestId" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "mimetype" TEXT NOT NULL,
      "size" INTEGER NOT NULL,
      "path" TEXT,
      "discordUrl" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ImportFile_importRequestId_fkey"
        FOREIGN KEY ("importRequestId") REFERENCES "ImportRequest"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ImportRequest_status_idx" ON "ImportRequest"("status")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ImportRequest_assignedToId_idx" ON "ImportRequest"("assignedToId")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ImportFile_importRequestId_idx" ON "ImportFile"("importRequestId")`);
}

router.use(async (req, res, next) => {
  try {
    if (!schemaReady) schemaReady = ensureImportTables();
    await schemaReady;
    next();
  } catch (err) {
    console.error('[Imports schema]', err.message);
    res.status(500).json({ error: 'Import storage is not ready' });
  }
});

function cleanFilename(filename) {
  return String(filename || 'import-file.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function discordMessageUrl(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

async function fetchImports(where = '', values = []) {
  return prisma.$queryRawUnsafe(`
    SELECT ir.*,
      COALESCE(jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email), NULL) AS assignee,
      COALESCE(
        json_agg(
          jsonb_build_object(
            'id', f.id,
            'filename', f.filename,
            'mimetype', f.mimetype,
            'size', f.size,
            'hasStoredFile', f.path IS NOT NULL,
            'discordUrl', f."discordUrl",
            'createdAt', f."createdAt"
          )
        ) FILTER (WHERE f.id IS NOT NULL),
        '[]'
      ) AS files
    FROM "ImportRequest" ir
    LEFT JOIN "User" u ON u.id = ir."assignedToId"
    LEFT JOIN "ImportFile" f ON f."importRequestId" = ir.id
    ${where}
    GROUP BY ir.id, u.id
    ORDER BY CASE WHEN ir.status = 'queued' THEN 0 WHEN ir.status = 'ready' THEN 1 ELSE 2 END, ir."createdAt" DESC
  `, ...values);
}

async function fetchImport(id) {
  const rows = await fetchImports('WHERE ir.id = $1', [id]);
  return rows[0] || null;
}

router.get('/', auth, requireRole('engineer', 'admin'), async (req, res) => {
  const { status, assigneeId, search } = req.query;
  const clauses = [];
  const values = [];
  let idx = 1;
  if (status && status !== 'all') { clauses.push(`ir.status = $${idx++}`); values.push(status); }
  if (assigneeId && assigneeId !== 'all') { clauses.push(`ir."assignedToId" = $${idx++}`); values.push(assigneeId); }
  if (search) {
    clauses.push(`(ir.title ILIKE $${idx} OR ir.description ILIKE $${idx} OR ir."assetType" ILIKE $${idx} OR ir."updateVersion" ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }
  try {
    const rows = await fetchImports(clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values);
    res.json(rows);
  } catch (err) {
    console.error('[Imports GET]', err.message);
    res.status(500).json({ error: 'Could not fetch imports' });
  }
});

router.patch('/:id', auth, requireRole('engineer', 'admin'), async (req, res) => {
  const allowedStatuses = new Set(['queued', 'ready', 'imported']);
  const assetType = req.body.assetType ? String(req.body.assetType).trim() : null;
  const updateVersion = req.body.updateVersion !== undefined ? String(req.body.updateVersion).trim() : null;
  const assignedToId = req.body.assignedToId === '' ? null : req.body.assignedToId;
  const description = req.body.description !== undefined ? String(req.body.description || '') : undefined;
  const status = req.body.status;

  if (assetType && !ASSET_TYPES.has(assetType)) return res.status(400).json({ error: 'Invalid asset type' });
  if (status && !allowedStatuses.has(status)) return res.status(400).json({ error: 'Invalid import status' });

  try {
    const current = await fetchImport(req.params.id);
    if (!current) return res.status(404).json({ error: 'Import not found' });

    if (assignedToId) {
      const users = await prisma.$queryRawUnsafe(`SELECT id FROM "User" WHERE id = $1 AND role = 'engineer' LIMIT 1`, assignedToId);
      if (!users.length) return res.status(400).json({ error: 'Assigned user must be an engineer' });
    }

    const next = {
      assetType: assetType !== null ? assetType : current.assetType,
      updateVersion: updateVersion !== null ? updateVersion : current.updateVersion,
      assignedToId: assignedToId !== undefined ? assignedToId : current.assignedToId,
      description: description !== undefined ? description : current.description,
    };
    const complete = Boolean(
      next.assetType &&
      next.updateVersion &&
      next.assignedToId &&
      String(next.description || '').trim()
    );
    if ((status === 'ready' || status === 'imported') && !complete) {
      return res.status(400).json({ error: 'Asset type, update, assigned dev, and description are required first' });
    }
    if (status === 'imported' && current.status !== 'ready') {
      return res.status(400).json({ error: 'Import must be accepted as ready before it can be marked imported' });
    }

    const updates = [];
    const values = [];
    let idx = 1;
    if (assetType !== null) { updates.push(`"assetType" = $${idx++}`); values.push(assetType); }
    if (updateVersion !== null) { updates.push(`"updateVersion" = $${idx++}`); values.push(updateVersion); }
    if (assignedToId !== undefined) { updates.push(`"assignedToId" = $${idx++}`); values.push(assignedToId); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (status) { updates.push(`status = $${idx++}`); values.push(status); }
    if (!updates.length) return res.status(400).json({ error: 'No changes provided' });

    updates.push(`"updatedAt" = CURRENT_TIMESTAMP`);
    values.push(req.params.id);
    const result = await prisma.$executeRawUnsafe(
      `UPDATE "ImportRequest" SET ${updates.join(', ')} WHERE id = $${idx}`,
      ...values
    );
    if (!result) return res.status(404).json({ error: 'Import not found' });

    const updated = await fetchImport(req.params.id);
    if (status === 'imported') {
      importStatus({
        channelId: current.discordChannelId,
        messageId: current.discordMessageId,
        status: 'imported',
      }).catch(err => console.error('[Imports notify]', err.message));
      return res.json(await fetchImport(req.params.id));
    }
    res.json(updated);
  } catch (err) {
    console.error('[Imports PATCH]', err.message);
    res.status(500).json({ error: 'Could not update import' });
  }
});

router.delete('/:id', auth, requireRole('engineer', 'admin'), async (req, res) => {
  try {
    const existing = await fetchImport(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Import not found' });
    await prisma.$executeRawUnsafe(`DELETE FROM "ImportRequest" WHERE id = $1`, req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Imports DELETE]', err.message);
    res.status(500).json({ error: 'Could not delete import' });
  }
});

router.post('/bot', botAuth, async (req, res) => {
  const { title, description, discordUser, discordUserId, discordChannelId, discordMessageId, attachments } = req.body;
  if (!discordChannelId || !discordMessageId || !Array.isArray(attachments) || !attachments.length) {
    return res.status(400).json({ error: 'channel, message, and attachments are required' });
  }

  try {
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM "ImportRequest" WHERE "discordMessageId" = $1 LIMIT 1`,
      discordMessageId
    );
    if (existing.length) return res.status(409).json({ error: 'Import already exists', importId: existing[0].id });

    const importId = crypto.randomUUID();
    const discordUrl = discordMessageUrl(process.env.DISCORD_SERVER_ID, discordChannelId, discordMessageId);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "ImportRequest" (
        id, title, description, status, "discordUser", "discordUserId",
        "discordChannelId", "discordMessageId", "discordUrl"
      ) VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$8)
    `, importId, title || attachments[0]?.filename || 'Import request', description || '', discordUser || null,
      discordUserId || null, discordChannelId, discordMessageId, discordUrl);

    for (const att of attachments) {
      const filename = cleanFilename(att.filename);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "ImportFile" (id, "importRequestId", filename, mimetype, size, path, "discordUrl")
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, crypto.randomUUID(), importId, filename, att.contentType || 'application/octet-stream',
        Number(att.size || 0), null, att.url);
    }

    res.status(201).json({ importId, import: await fetchImport(importId) });
  } catch (err) {
    console.error('[Imports bot]', err.message);
    res.status(500).json({ error: 'Could not queue import' });
  }
});

module.exports = router;
