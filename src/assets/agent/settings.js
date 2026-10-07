// Agent settings (one JSON row in AssetSetting) and usage / budget accounting.

const { newId } = require('../db');
const { SUGGESTION_TYPES, NEVER_AUTO_APPLY } = require('../constants');

const AUTO_APPLY_TYPES = SUGGESTION_TYPES.filter(t => !NEVER_AUTO_APPLY.includes(t));

const DEFAULTS = {
  paused: false,
  retentionDays: 30,
  dailyBudgetUsd: 2,
  quietMinutes: 3,
  maxBatchMessages: 25,
  // Off by default for every type. create_content_item and flag_unknown are
  // not even listed: they can never auto-apply.
  autoApply: Object.fromEntries(AUTO_APPLY_TYPES.map(t => [t, { enabled: false, threshold: 0.9 }])),
};

const clamp = (n, lo, hi, fallback) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : fallback);

function normalize(raw = {}) {
  const autoApply = {};
  for (const type of AUTO_APPLY_TYPES) {
    const entry = raw.autoApply?.[type] || {};
    autoApply[type] = { enabled: entry.enabled === true, threshold: clamp(entry.threshold, 0.5, 1, 0.9) };
  }
  return {
    paused: raw.paused === true,
    retentionDays: Math.round(clamp(raw.retentionDays, 1, 365, DEFAULTS.retentionDays)),
    dailyBudgetUsd: clamp(raw.dailyBudgetUsd, 0, 1000, DEFAULTS.dailyBudgetUsd),
    quietMinutes: clamp(raw.quietMinutes, 1, 60, DEFAULTS.quietMinutes),
    maxBatchMessages: Math.round(clamp(raw.maxBatchMessages, 5, 100, DEFAULTS.maxBatchMessages)),
    autoApply,
  };
}

async function getSettings(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT "value" FROM "AssetSetting" WHERE "key" = 'agent'`);
  return normalize(rows[0]?.value || {});
}

async function saveSettings(prisma, patch) {
  const current = await getSettings(prisma);
  const next = normalize({ ...current, ...patch, autoApply: { ...current.autoApply, ...(patch.autoApply || {}) } });
  await prisma.$executeRawUnsafe(`
    INSERT INTO "AssetSetting" ("key", "value") VALUES ('agent', $1::jsonb)
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
  `, JSON.stringify(next));
  return next;
}

// USD per million tokens. Cache writes cost 1.25x input, cache reads 0.1x.
// Override or extend with ASSET_AGENT_PRICING='{"model-id":{"input":1,"output":5}}'.
const PRICING = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};
function priceFor(model) {
  let overrides = {};
  try { overrides = JSON.parse(process.env.ASSET_AGENT_PRICING || '{}'); } catch { /* ignore a malformed override */ }
  // An unknown model is priced like the most expensive known one, so the budget errs on the safe side.
  return overrides[model] || PRICING[model] || PRICING['claude-opus-5-5'];
}

function costOf(model, usage = {}) {
  const p = priceFor(model);
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * p.input + (usage.output_tokens || 0) * p.output) / 1e6;
}

async function logUsage(prisma, { batchId, pass, model, usage }) {
  const inputTokens = (usage?.input_tokens || 0) + (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
  const costUsd = costOf(model, usage);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "AssetAgentUsage" ("id", "batchId", "pass", "model", "inputTokens", "outputTokens", "costUsd")
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, newId(), batchId || null, pass, model, inputTokens, usage?.output_tokens || 0, costUsd);
  return costUsd;
}

// The budget day is the UTC calendar day.
async function spentToday(prisma) {
  const [row] = await prisma.$queryRawUnsafe(`
    SELECT COALESCE(SUM("costUsd"), 0)::float AS cost
    FROM "AssetAgentUsage" WHERE "createdAt" >= date_trunc('day', (NOW() AT TIME ZONE 'UTC'))`);
  return Number(row.cost) || 0;
}

async function usageSummary(prisma) {
  const [daily, recent, settings, today] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
        COALESCE(SUM("costUsd"), 0)::float AS cost,
        COALESCE(SUM("inputTokens"), 0)::int AS "inputTokens",
        COALESCE(SUM("outputTokens"), 0)::int AS "outputTokens",
        COUNT(*) FILTER (WHERE pass = 'filter')::int AS "filterCalls",
        COUNT(*) FILTER (WHERE pass = 'extract')::int AS "extractCalls"
      FROM "AssetAgentUsage"
      WHERE "createdAt" >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '14 days'
      GROUP BY 1 ORDER BY 1`),
    prisma.$queryRawUnsafe(`
      SELECT b.id, b."channelId", b.status, b."messageCount", b.relevant, b."suggestionCount", b.error, b."createdAt",
        COALESCE((SELECT SUM(u."costUsd") FROM "AssetAgentUsage" u WHERE u."batchId" = b.id), 0)::float AS cost
      FROM "AssetAgentBatch" b ORDER BY b."createdAt" DESC LIMIT 20`),
    getSettings(prisma),
    spentToday(prisma),
  ]);
  return { today, budget: settings.dailyBudgetUsd, overBudget: settings.dailyBudgetUsd > 0 && today >= settings.dailyBudgetUsd, daily, recentBatches: recent };
}

module.exports = { DEFAULTS, AUTO_APPLY_TYPES, normalize, getSettings, saveSettings, costOf, priceFor, logUsage, spentToday, usageSummary };
