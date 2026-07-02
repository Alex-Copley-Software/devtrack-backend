// POST /api/notion/webhook
// Receives Notion's page.created / page.properties_updated events.
// Mounted with express.raw() in index.js (BEFORE the global express.json())
// so we have the exact raw bytes needed for X-Notion-Signature verification.

const crypto = require('crypto');
const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const notion = require('../notion-client');
const db = require('../notion-tasks-db');
const taskHistory = require('../notion-task-history-logger');
const { broadcast } = require('../events');

const prisma = new PrismaClient();

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.NOTION_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const HANDLED_EVENT_TYPES = new Set(['page.created', 'page.properties_updated']);

router.post('/webhook', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // First-time subscription verification handshake. No signature exists yet.
  if (payload.verification_token) {
    console.log(`[Notion Webhook] Verification token received — paste this into your Notion integration's webhook settings: ${payload.verification_token}`);
    return res.status(200).json({ received: true });
  }

  if (!verifySignature(rawBody, req.headers['x-notion-signature'])) {
    console.warn('[Notion Webhook] Invalid or missing X-Notion-Signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Acknowledge immediately; Notion expects a fast response and will retry on timeout/error.
  res.status(200).json({ received: true });

  const eventType = payload.type;
  const pageId = payload.entity?.id;
  if (!HANDLED_EVENT_TYPES.has(eventType) || !pageId) return;

  try {
    const fields = await notion.fetchTaskFields(pageId);
    if (!fields.databaseId || !notion.isKnownDatabase(fields.databaseId)) return;

    await db.ensureNotionTaskTable(prisma);
    await db.ensureNotionNicknameColumn(prisma);
    await taskHistory.ensureNotionTaskHistoryTable(prisma);

    const existing = await db.fetchByPageId(prisma, pageId);

    if (!notion.matchesEngineerFilter(fields.assigneeNicknames)) {
      if (existing) {
        await db.deleteByPageId(prisma, pageId);
        broadcast('notionTask.deleted', { id: existing.id, timestamp: new Date().toISOString() });
        console.log(`[Notion Webhook] Removed task "${existing.title}" (${existing.id}) — no longer assigned to an engineer`);
      }
      return;
    }

    if (existing?.notionLastEditedTime && fields.notionLastEditedTime) {
      const existingTs = new Date(existing.notionLastEditedTime).getTime();
      const incomingTs = new Date(fields.notionLastEditedTime).getTime();
      if (existingTs >= incomingTs) {
        console.log(`[Notion Webhook] Skipping echo of our own write for page ${pageId}`);
        return;
      }
    }

    const task = await db.upsertFromNotion(prisma, {
      notionPageId: pageId,
      notionDatabaseId: fields.databaseId,
      title: fields.title,
      status: fields.status,
      assigneeNicknames: fields.assigneeNicknames,
      priority: fields.priority,
      dueDate: fields.dueDate,
      notionLastEditedTime: fields.notionLastEditedTime,
      notionUrl: fields.notionUrl,
    });

    if (!existing) {
      await taskHistory.log(prisma, { notionTaskId: task.id, action: 'created', detail: `Synced from Notion, status: ${task.status}`, source: 'notion', actorName: 'Notion sync' });
    } else {
      if (task.status !== existing.status) {
        await taskHistory.log(prisma, { notionTaskId: task.id, action: 'status', detail: `${existing.status} → ${task.status}`, source: 'notion', actorName: 'Notion sync' });
      }
      if (task.priority !== existing.priority) {
        await taskHistory.log(prisma, { notionTaskId: task.id, action: 'priority', detail: task.priority || 'cleared', source: 'notion', actorName: 'Notion sync' });
      }
      const prevNicknames = (existing.assigneeNicknames || []).slice().sort().join(',');
      const nextNicknames = (task.assigneeNicknames || []).slice().sort().join(',');
      if (prevNicknames !== nextNicknames) {
        await taskHistory.log(prisma, { notionTaskId: task.id, action: 'assigned', detail: task.assigneeNicknames?.join(', ') || 'Unassigned', source: 'notion', actorName: 'Notion sync' });
      }
    }

    broadcast(existing ? 'notionTask.updated' : 'notionTask.created', { task, timestamp: new Date().toISOString() });
    console.log(`[Notion Webhook] Synced task "${task.title}" (${task.id}) from Notion`);
  } catch (err) {
    console.error('[Notion Webhook] Failed to process event:', err.message);
  }
});

module.exports = router;
