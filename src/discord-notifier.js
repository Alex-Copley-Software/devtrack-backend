// discord-notifier.js
// Called by the backend to trigger Discord actions via the bot webhook

const axios = require('axios');

const BOT_WEBHOOK = process.env.BOT_WEBHOOK_URL || 'http://localhost:3002';
const BOT_SECRET  = process.env.BOT_SECRET;

// ── outbox ────────────────────────────────────────────────────────────────────
// The bot restarts on every deploy, and anything sent to it meanwhile used to
// be lost: a forum post never got its "accepted" or "resolved" message, and a
// tester was never asked to check a fix. Status messages and QA checks the bot
// cannot take are kept here and sent again, oldest first, every 30 seconds
// for up to a day. While any are waiting, new ones queue behind them so a
// post's messages stay in order.

const OUTBOX_POLL_MS = 30 * 1000;
const OUTBOX_MAX_AGE_HOURS = 24;
let prisma = null;
const db = () => prisma || (prisma = new (require('@prisma/client').PrismaClient)());
let outboxReady = false;
let waiting = 0;

async function ensureOutbox() {
  if (outboxReady) return;
  await db().$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "BotOutbox" (
      "id" BIGSERIAL PRIMARY KEY,
      "path" TEXT NOT NULL,
      "payload" JSONB NOT NULL,
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "lastError" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  outboxReady = true;
}

const send = (path, payload, timeout) => axios.post(`${BOT_WEBHOOK}${path}`, payload, { headers: { 'x-bot-secret': BOT_SECRET }, timeout });
// A 400 or 404 means the bot will never take it; anything else (down, restarting, Discord hiccup) is worth another try.
const retryable = err => ![400, 404].includes(err.response?.status);

async function deliver(path, payload, { timeout = 5000 } = {}) {
  if (!waiting) {
    try {
      await send(path, payload, timeout);
      return true;
    } catch (err) {
      if (!retryable(err)) throw err;
      console.error(`[Notifier] Bot not reachable for ${path} (${err.message}); kept in the outbox`);
    }
  }
  try {
    await ensureOutbox();
    await db().$executeRawUnsafe(`INSERT INTO "BotOutbox" ("path", "payload") VALUES ($1, $2::jsonb)`, path, JSON.stringify(payload));
    waiting++;
  } catch (err) {
    console.error(`[Notifier] Could not keep ${path} in the outbox:`, err.message);
  }
  return false;
}

let draining = false;
async function drainOutbox() {
  if (draining) return;
  draining = true;
  try {
    await ensureOutbox();
    const expired = await db().$executeRawUnsafe(
      `DELETE FROM "BotOutbox" WHERE "createdAt" < NOW() - ($1 * INTERVAL '1 hour')`, OUTBOX_MAX_AGE_HOURS);
    if (expired) console.error(`[Notifier] Gave up on ${expired} outbox message(s) older than ${OUTBOX_MAX_AGE_HOURS} hours`);
    const rows = await db().$queryRawUnsafe(`SELECT id, path, payload FROM "BotOutbox" ORDER BY id LIMIT 50`);
    for (const row of rows) {
      try {
        await send(row.path, row.payload, 20000);
      } catch (err) {
        if (retryable(err)) {
          await db().$executeRawUnsafe(`UPDATE "BotOutbox" SET attempts = attempts + 1, "lastError" = $2 WHERE id = $1`, row.id, String(err.message).slice(0, 500));
          break; // the bot is still away; keep the order and try again next time
        }
        console.error(`[Notifier] Bot refused outbox message ${row.id} (${row.path}):`, err.response?.data?.error || err.message);
      }
      await db().$executeRawUnsafe(`DELETE FROM "BotOutbox" WHERE id = $1`, row.id);
    }
    waiting = Number((await db().$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "BotOutbox"`))[0]?.n || 0);
    if (rows.length && !waiting) console.log('[Notifier] Outbox delivered');
  } catch (err) {
    console.error('[Notifier] Outbox drain failed:', err.message);
  } finally {
    draining = false;
  }
}

function startOutbox() {
  drainOutbox();
  setInterval(drainOutbox, OUTBOX_POLL_MS);
}

async function notify({ threadId, reportType, action, bugLevel, devNotes, discordUserId, assigneeName, notifyOwner, verifiedBy, proof }) {
  if (!threadId) {
    console.log('[Notifier] No threadId — skipping Discord notification');
    return;
  }
  console.log('[Notifier] Sending:', { action, notifyOwner, discordUserId }); // ADD THIS

  try {
    const sent = await deliver('/action', {
      threadId,
      reportType: reportType || 'bug',
      action,
      bugLevel,
      devNotes,
      discordUserId,
      assigneeName,
      notifyOwner: !!notifyOwner,
      verifiedBy,
      proof,
    });
    if (sent) console.log(`[Notifier] Discord notified: ${action} on thread ${threadId}`);
  } catch (err) {
    // Non-fatal — log but don't break the API response
    console.error(`[Notifier] Failed to notify Discord:`, err.message);
  }
}

async function alert(payload) {
  try {
    await axios.post(`${BOT_WEBHOOK}/alert`, payload, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    console.log(`[Notifier] Discord alert sent: ${payload.kind}`);
  } catch (err) {
    console.error('[Notifier] Failed to send Discord alert:', err.message);
  }
}

async function importStatus(payload) {
  try {
    await axios.post(`${BOT_WEBHOOK}/import-status`, payload, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    console.log(`[Notifier] Import status sent: ${payload.status}`);
  } catch (err) {
    console.error('[Notifier] Failed to send import status:', err.message);
  }
}

async function patchFixNotice(payload) {
  try {
    await axios.post(`${BOT_WEBHOOK}/patch-fix`, payload, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    console.log(`[Notifier] Patch-fix notice sent: ${payload.title}`);
  } catch (err) {
    console.error('[Notifier] Failed to send patch-fix notice:', err.message);
  }
}

async function notifyTesters() {
  try {
    await axios.post(`${BOT_WEBHOOK}/ping-testers`, {}, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    console.log('[Notifier] Tester ping sent');
  } catch (err) {
    console.error('[Notifier] Failed to send tester ping:', err.message);
  }
}

async function notifyReportPauseState(paused) {
  try {
    await axios.post(`${BOT_WEBHOOK}/reports-pause-state`, { paused }, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    console.log(`[Notifier] Report pause state sent: ${paused}`);
  } catch (err) {
    console.error('[Notifier] Failed to send report pause state:', err.message);
  }
}

// Tester QA: ask the reporter to confirm a fix in their thread, and later
// update that message if staff approve it or the report leaves QA first.
async function qaCheck(payload) {
  try {
    // The bot answers once the check is posted in Discord, which can take a few seconds.
    if (await deliver('/qa-check', payload, { timeout: 20000 })) console.log(`[Notifier] Tester QA check sent for thread ${payload.threadId}`);
  } catch (err) {
    console.error('[Notifier] Failed to send tester QA check:', err.message);
  }
}

async function qaCheckUpdate(payload) {
  try {
    await deliver('/qa-check-update', payload);
  } catch (err) {
    console.error('[Notifier] Failed to update tester QA check:', err.message);
  }
}

module.exports = { startOutbox, drainOutbox, notify, alert, importStatus, patchFixNotice, notifyTesters, notifyReportPauseState, qaCheck, qaCheckUpdate };
