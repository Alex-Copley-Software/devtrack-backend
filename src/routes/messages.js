const router = require('express').Router();
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const { uploadBuffer } = require('../r2');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();

function botAuth(req, res, next) {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/messages/:reportId
router.get('/:reportId', auth, async (req, res) => {
  try {
    const messages = await prisma.message.findMany({
      where: { reportId: req.params.reportId },
      orderBy: { createdAt: 'asc' }
    });
    res.json(messages);
  } catch (err) {
    console.error('[Messages GET] Error:', err.message);
    res.status(500).json({ error: 'Could not fetch messages' });
  }
});

// Each logged Discord message keeps its Discord id, so the bot can catch up on
// what it missed (see forum-sync.js in the bot) without logging anything twice.
let discordIdReady = false;
async function ensureDiscordId() {
  if (discordIdReady) return;
  await prisma.$executeRawUnsafe(`ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "discordMessageId" TEXT`);
  await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Message_report_discord_key" ON "Message"("reportId", "discordMessageId") WHERE "discordMessageId" IS NOT NULL`);
  discordIdReady = true;
}

// Discord attachment links expire after about a day, and die with the post if it is deleted,
// so a copy of each is kept in R2 and the message points at that instead.
const MAX_MIRROR_BYTES = Number(process.env.MAX_REMOTE_ATTACHMENT_BYTES || 125 * 1024 * 1024);
const isDiscordCdn = url => /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//.test(url);

async function mirrorAttachments(messageId, urls) {
  if (!urls.some(isDiscordCdn)) return;
  const kept = [];
  for (const url of urls) {
    if (!isDiscordCdn(url)) { kept.push(url); continue; }
    try {
      const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_MIRROR_BYTES });
      const name = path.basename(new URL(url).pathname);
      const r2Url = await uploadBuffer(Buffer.from(res.data), `messages/${messageId}/${name}`, res.headers['content-type'] || 'application/octet-stream');
      kept.push(r2Url || url);
    } catch (err) {
      console.error('[Messages] Could not copy an attachment:', err.message);
      kept.push(url);
    }
  }
  await prisma.$executeRawUnsafe(`UPDATE "Message" SET attachments = $2::text[] WHERE id = $1`, messageId, kept);
}

// POST /api/messages
// discordMessageId and sentAt are optional: a message already logged is
// skipped, and one logged late keeps the time it was sent in Discord.
router.post('/', botAuth, async (req, res) => {
  const { reportId, content, authorName, authorId, authorAvatar, attachments, isBot, discordMessageId, sentAt } = req.body;
  if (!reportId || !content) return res.status(400).json({ error: 'reportId and content required' });
  try {
    await ensureDiscordId();
    const id = crypto.randomUUID();
    const urls = Array.isArray(attachments) ? attachments.map(String) : [];
    const when = sentAt && !Number.isNaN(Date.parse(sentAt)) ? new Date(sentAt) : new Date();
    const inserted = await prisma.$executeRawUnsafe(`
      INSERT INTO "Message" ("id", "reportId", "content", "authorName", "authorId", "authorAvatar", "attachments", "isBot", "createdAt", "discordMessageId")
      VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10)
      ON CONFLICT DO NOTHING`,
      id, reportId, String(content), String(authorName || 'Unknown'), String(authorId || ''), authorAvatar ? String(authorAvatar) : null,
      urls, Boolean(isBot), when, discordMessageId ? String(discordMessageId) : null);
    if (!inserted) return res.status(200).json({ duplicate: true });
    res.status(201).json(await prisma.message.findUnique({ where: { id } }));
    mirrorAttachments(id, urls).catch(err => console.error('[Messages] Attachment copy failed:', err.message));
  } catch (err) {
    console.error('[Messages POST] Error:', err.message, '| reportId:', reportId);
    res.status(500).json({ error: 'Could not save message', detail: err.message });
  }
});

module.exports = router;
module.exports.ensureDiscordId = ensureDiscordId;