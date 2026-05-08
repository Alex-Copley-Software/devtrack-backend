const router = require('express').Router();
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const {
  uploadPrivateBuffer,
  getPrivateObject,
  deletePrivateObject,
  isPrivateConfigured,
} = require('../r2');

const prisma = new PrismaClient();
const IMPORT_R2_BUCKET = process.env.IMPORT_R2_BUCKET_NAME || process.env.R2_IMPORT_BUCKET_NAME;
const MAX_IMPORT_BYTES = Number(process.env.MAX_IMPORT_ATTACHMENT_BYTES || 250 * 1024 * 1024);
const ASSET_TYPES = new Set([
  'Unit SFX',
  'Unit animations',
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

function r2Path(key) {
  return key ? `r2://${IMPORT_R2_BUCKET}/${key}` : null;
}

function r2KeyFromPath(value) {
  return String(value || '').replace(/^r2:\/\/[^/]+\//, '');
}

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

async function fetchFile(importId, fileId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM "ImportFile" WHERE id = $1 AND "importRequestId" = $2 LIMIT 1`,
    fileId,
    importId
  );
  return rows[0] || null;
}

async function deleteStoredFiles(importId) {
  const files = await prisma.$queryRawUnsafe(
    `SELECT id, path FROM "ImportFile" WHERE "importRequestId" = $1 AND path IS NOT NULL`,
    importId
  );
  for (const file of files) {
    await deletePrivateObject(r2KeyFromPath(file.path), IMPORT_R2_BUCKET);
  }
  await prisma.$executeRawUnsafe(`UPDATE "ImportFile" SET path = NULL WHERE "importRequestId" = $1`, importId);
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

router.get('/:id/file/:fileId', auth, requireRole('engineer', 'admin'), async (req, res) => {
  try {
    const file = await fetchFile(req.params.id, req.params.fileId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (!file.path) return res.redirect(file.discordUrl);

    const object = await getPrivateObject(r2KeyFromPath(file.path), IMPORT_R2_BUCKET);
    if (!object?.Body) return res.status(404).json({ error: 'Stored file not found' });
    res.setHeader('Content-Type', file.mimetype || object.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`);
    return object.Body.pipe(res);
  } catch (err) {
    console.error('[Imports file]', err.message);
    res.status(500).json({ error: 'Could not fetch import file' });
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

    if (status === 'imported') await deleteStoredFiles(req.params.id);
    res.json(await fetchImport(req.params.id));
  } catch (err) {
    console.error('[Imports PATCH]', err.message);
    res.status(500).json({ error: 'Could not update import' });
  }
});

router.post('/bot', botAuth, async (req, res) => {
  const { title, description, discordUser, discordUserId, discordChannelId, discordMessageId, attachments } = req.body;
  if (!discordChannelId || !discordMessageId || !Array.isArray(attachments) || !attachments.length) {
    return res.status(400).json({ error: 'channel, message, and attachments are required' });
  }
  if (!isPrivateConfigured(IMPORT_R2_BUCKET)) {
    return res.status(500).json({ error: 'Import R2 bucket is not configured' });
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
      const ext = path.extname(filename) || '.bin';
      const key = `imports/${new Date().getFullYear()}/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      const response = await axios.get(att.url, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: MAX_IMPORT_BYTES,
        maxBodyLength: MAX_IMPORT_BYTES,
      });
      const buffer = Buffer.from(response.data);
      const uploadedKey = await uploadPrivateBuffer(buffer, key, att.contentType, IMPORT_R2_BUCKET);
      if (!uploadedKey) throw new Error('R2 upload failed');
      await prisma.$executeRawUnsafe(`
        INSERT INTO "ImportFile" (id, "importRequestId", filename, mimetype, size, path, "discordUrl")
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, crypto.randomUUID(), importId, filename, att.contentType || 'application/octet-stream',
        Number(att.size || buffer.length || 0), r2Path(uploadedKey), att.url);
    }

    res.status(201).json({ importId, import: await fetchImport(importId) });
  } catch (err) {
    console.error('[Imports bot]', err.message);
    res.status(500).json({ error: 'Could not queue import' });
  }
});

module.exports = router;
