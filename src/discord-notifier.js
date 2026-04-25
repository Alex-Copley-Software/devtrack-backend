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

module.exports = { notify };