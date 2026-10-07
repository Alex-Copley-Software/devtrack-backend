// The agent's durable pipeline, all in Postgres so it survives restarts of
// either the bot or the API:
//
//   ingest   the bot posts messages from allowlisted channels
//   claim    a channel/thread with enough unbatched messages, or one that has
//            gone quiet, is claimed atomically as a batch
//   process  filter pass -> extraction pass -> validate -> store suggestions
//
// The bot drives it by calling tick() about once a minute.

const { newId } = require('../db');
const C = require('../constants');
const settingsStore = require('./settings');
const context = require('./context');
const { validateActions } = require('./validate');
const suggestions = require('./suggestions');

const MAX_CONTENT = 4000;

// ── allowlist ────────────────────────────────────────────────────────────────

async function listChannels(prisma) {
  return prisma.$queryRawUnsafe(`SELECT "channelId", label, enabled, "addedByName", "createdAt" FROM "AssetAgentChannel" ORDER BY "createdAt"`);
}

async function allowedChannelIds(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT "channelId" FROM "AssetAgentChannel" WHERE enabled`);
  return new Set(rows.map(r => r.channelId));
}

// ── ingest ───────────────────────────────────────────────────────────────────

// Stores only what the agent needs. Anything from a channel that is not on
// the allowlist (directly, or as the parent of a thread) is discarded, even
// if the bot sent it.
async function ingestMessages(prisma, messages) {
  const allowed = await allowedChannelIds(prisma);
  let stored = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || !/^\d{5,25}$/.test(String(m.id || '')) || !m.channelId || !m.authorDiscordId) continue;
    if (!allowed.has(String(m.channelId)) && !allowed.has(String(m.parentChannelId || ''))) continue;
    const postedAt = new Date(m.postedAt || Date.now());
    if (Number.isNaN(postedAt.getTime())) continue;
    const attachments = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 10)
      .map(a => ({ name: String(a?.name || '').slice(0, 200), url: String(a?.url || '').slice(0, 1000) }));
    const content = String(m.content || '').slice(0, MAX_CONTENT);
    if (!content.trim() && !attachments.length) continue;
    stored += await prisma.$executeRawUnsafe(`
      INSERT INTO "AssetAgentMessage" ("id", "channelId", "parentChannelId", "guildId", "authorDiscordId", "authorName", "content", "attachments", "postedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
      ON CONFLICT ("id") DO NOTHING
    `, String(m.id), String(m.channelId), m.parentChannelId ? String(m.parentChannelId) : null, m.guildId ? String(m.guildId) : null,
    String(m.authorDiscordId), String(m.authorName || '').slice(0, 100), content, JSON.stringify(attachments), postedAt.toISOString());
  }
  return stored;
}

async function pruneOldMessages(prisma, retentionDays) {
  return prisma.$executeRawUnsafe(
    `DELETE FROM "AssetAgentMessage" WHERE "postedAt" < NOW() - ($1 || ' days')::interval`, String(retentionDays));
}

// ── batching ─────────────────────────────────────────────────────────────────

// Claims up to `limit` batches. A conversation is ready when it has
// maxBatchMessages waiting, or its newest waiting message is older than
// quietMinutes. The UPDATE ... WHERE "batchId" IS NULL makes the claim
// atomic: two overlapping ticks can never take the same message.
async function claimBatches(prisma, { quietMinutes, maxBatchMessages, limit = 3 }) {
  const due = await prisma.$queryRawUnsafe(`
    SELECT "channelId"
    FROM "AssetAgentMessage"
    WHERE "batchId" IS NULL
    GROUP BY "channelId"
    HAVING COUNT(*) >= $1 OR MAX("postedAt") < NOW() - ($2 || ' minutes')::interval
    ORDER BY MIN("postedAt")
    LIMIT $3`, maxBatchMessages, String(quietMinutes), limit);

  const batches = [];
  for (const { channelId } of due) {
    const batchId = newId();
    const messages = await prisma.$queryRawUnsafe(`
      UPDATE "AssetAgentMessage" SET "batchId" = $1
      WHERE "batchId" IS NULL AND id IN (
        SELECT id FROM "AssetAgentMessage" WHERE "channelId" = $2 AND "batchId" IS NULL ORDER BY "postedAt", id LIMIT $3
      )
      RETURNING id, "channelId", "parentChannelId", "guildId", "authorDiscordId", "authorName", content, attachments, "postedAt"
    `, batchId, channelId, maxBatchMessages);
    if (!messages.length) continue;
    messages.sort((a, b) => new Date(a.postedAt) - new Date(b.postedAt) || String(a.id).localeCompare(String(b.id)));
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AssetAgentBatch" ("id", "channelId", "messageCount") VALUES ($1, $2, $3)`, batchId, channelId, messages.length);
    batches.push({ id: batchId, channelId, messages });
  }
  return batches;
}

async function finishBatch(prisma, id, fields) {
  await prisma.$executeRawUnsafe(`
    UPDATE "AssetAgentBatch"
    SET status = $2, relevant = $3, "suggestionCount" = $4, error = $5, "finishedAt" = CURRENT_TIMESTAMP
    WHERE id = $1`, id, fields.status, fields.relevant ?? null, fields.suggestionCount || 0, fields.error ? String(fields.error).slice(0, 500) : null);
}

const messageUrl = m => (m.guildId ? `https://discord.com/channels/${m.guildId}/${m.channelId}/${m.id}` : null);

// ── processing ───────────────────────────────────────────────────────────────

async function processBatch(prisma, batch, { model, settings }) {
  const snapshot = await context.buildSnapshot(prisma);
  const { text, labels } = context.renderBatch(batch.messages, snapshot);

  const screened = await model.filter(text);
  await settingsStore.logUsage(prisma, { batchId: batch.id, pass: 'filter', model: screened.model, usage: screened.usage });
  if (!screened.relevant) {
    await finishBatch(prisma, batch.id, { status: 'filtered_out', relevant: false });
    return { batchId: batch.id, relevant: false, stored: [], dropped: [], skipped: [] };
  }

  const extracted = await model.extract({
    trackerState: context.renderTrackerState(snapshot),
    batchText: text,
    today: new Date().toISOString().slice(0, 10),
  });
  await settingsStore.logUsage(prisma, { batchId: batch.id, pass: 'extract', model: extracted.model, usage: extracted.usage });

  const { accepted, dropped } = validateActions(extracted.actions, { snapshot, labels });
  const evidenceFor = list => list.map(label => {
    const m = labels.get(label);
    return {
      messageId: m.id, channelId: m.channelId, url: messageUrl(m), authorName: m.authorName,
      authorDiscordId: m.authorDiscordId, postedAt: new Date(m.postedAt).toISOString(), excerpt: String(m.content || '').slice(0, 240),
    };
  });
  const { stored, skipped } = await suggestions.storeSuggestions(prisma, accepted, { batchId: batch.id, evidenceFor });

  // Optional auto-apply, off by default (see settings).
  for (const suggestion of stored) {
    if (!suggestions.shouldAutoApply(settings, suggestion)) continue;
    try {
      Object.assign(suggestion, await suggestions.resolveSuggestion(prisma, suggestion.id, {
        decision: 'accept', via: 'auto', actor: { userId: null, name: 'Auto-apply' },
      }));
    } catch (err) {
      console.error('[AssetAgent] auto-apply failed:', err.message);
    }
  }

  await finishBatch(prisma, batch.id, { status: 'extracted', relevant: true, suggestionCount: stored.length });
  if (dropped.length || skipped.length) {
    console.log(`[AssetAgent] batch ${batch.id}: ${stored.length} stored, ${dropped.length} dropped (${dropped.map(d => d.why).join('; ')}), ${skipped.length} skipped (${skipped.map(s => s.why).join('; ')})`);
  }
  return { batchId: batch.id, relevant: true, stored, dropped, skipped };
}

// Suggestions the bot has not posted to the review channel yet. Claimed
// atomically so a suggestion is handed to the bot once.
async function claimDiscordPosts(prisma, limit = 10) {
  return prisma.$queryRawUnsafe(`
    UPDATE "AssetAgentSuggestion" SET "needsDiscordPost" = false
    WHERE id IN (SELECT id FROM "AssetAgentSuggestion" WHERE "needsDiscordPost" ORDER BY "createdAt" LIMIT $1)
    RETURNING id, type, status, summary, before, after, confidence, reason, evidence, "updateId", "resolvedByName", "resolvedVia", "createdAt"
  `, limit);
}

// One poll from the bot. Returns what happened and what to post to Discord.
async function tick(prisma, { model = require('./model'), maxBatches = 3 } = {}) {
  if (!C.isEnabled('ASSET_AGENT_ENABLED')) return { state: 'disabled', processed: [], toPost: [] };
  const settings = await settingsStore.getSettings(prisma);
  await pruneOldMessages(prisma, settings.retentionDays);

  let state = 'ok';
  const processed = [];
  if (settings.paused) state = 'paused';
  else if (settings.dailyBudgetUsd > 0 && await settingsStore.spentToday(prisma) >= settings.dailyBudgetUsd) state = 'over_budget';
  else {
    const batches = await claimBatches(prisma, { ...settings, limit: maxBatches });
    for (const batch of batches) {
      try {
        const result = await processBatch(prisma, batch, { model, settings });
        processed.push({ batchId: batch.id, channelId: batch.channelId, messages: batch.messages.length, relevant: result.relevant, suggestions: result.stored.length });
      } catch (err) {
        console.error(`[AssetAgent] batch ${batch.id} failed:`, err.message);
        await finishBatch(prisma, batch.id, { status: 'failed', error: err.message });
        processed.push({ batchId: batch.id, channelId: batch.channelId, messages: batch.messages.length, error: err.message });
      }
      // Stop mid-tick if this batch pushed spend over the cap.
      if (settings.dailyBudgetUsd > 0 && await settingsStore.spentToday(prisma) >= settings.dailyBudgetUsd) { state = 'over_budget'; break; }
    }
  }
  return { state, processed, toPost: await claimDiscordPosts(prisma) };
}

module.exports = { listChannels, allowedChannelIds, ingestMessages, pruneOldMessages, claimBatches, processBatch, claimDiscordPosts, tick };
