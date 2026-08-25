// discord-notifier.js
// Called by the backend to trigger Discord actions via the bot webhook

const axios = require('axios');

const BOT_WEBHOOK = process.env.BOT_WEBHOOK_URL || 'http://localhost:3002';
const BOT_SECRET  = process.env.BOT_SECRET;

async function notify({ threadId, reportType, action, bugLevel, devNotes, discordUserId, assigneeName, notifyOwner }) {
  if (!threadId) {
    console.log('[Notifier] No threadId — skipping Discord notification');
    return;
  }
  console.log('[Notifier] Sending:', { action, notifyOwner, discordUserId }); // ADD THIS

  try {
    await axios.post(`${BOT_WEBHOOK}/action`, {
      threadId,
      reportType: reportType || 'bug',
      action,
      bugLevel,
      devNotes,
      discordUserId,
      assigneeName,
      notifyOwner: !!notifyOwner,
    }, {
      headers: { 'x-bot-secret': BOT_SECRET },
      timeout: 5000,
    });
    console.log(`[Notifier] Discord notified: ${action} on thread ${threadId}`);
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

module.exports = { notify, alert, importStatus, patchFixNotice, notifyTesters, notifyReportPauseState };
