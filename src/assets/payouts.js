// Dev payout requests.
//
// An asset dev posts in the "Payments" post of their own forum, saying what
// they want paid for ("30k payout for Aizen's shiny model"). The request is
// read by the model, tied to the content item and tasks it is for, checked
// against earlier payouts so nothing is paid twice, and forwarded to the
// admins' payouts channel. An admin presses Paid out; the dev's message gets
// a tick and a reply, and the tasks show as paid on the Assets page with a
// link back to the request.
//
//   needs_info   the dev did not say what it is for; the bot asked
//   pending      logged and forwarded, waiting for an admin
//   paid         an admin paid it
//   declined     an admin declined it (with a reason)

const fs = require('fs');
const path = require('path');
const { newId } = require('./db');
const q = require('./queries');
const service = require('./service');
const assistant = require('./agent/assistant');
const settingsStore = require('./agent/settings');

const { AssetError } = service;
const STATUSES = ['needs_info', 'pending', 'paid', 'declined'];

// ── settings ─────────────────────────────────────────────────────────────────

const isId = v => /^\d{17,20}$/.test(String(v || ''));
function normalizeSettings(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    // Where requests are forwarded. Empty: the bot uses a channel named "payouts".
    adminChannelId: isId(raw.adminChannelId) ? String(raw.adminChannelId) : '',
    // Optional role to mention when a dev needs help wording a request.
    managerRoleId: isId(raw.managerRoleId) ? String(raw.managerRoleId) : '',
  };
}
async function getSettings(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT "value" FROM "AssetSetting" WHERE "key" = 'payouts'`);
  return normalizeSettings(rows[0]?.value || {});
}
async function saveSettings(prisma, patch) {
  const next = normalizeSettings({ ...(await getSettings(prisma)), ...patch });
  await prisma.$executeRawUnsafe(`
    INSERT INTO "AssetSetting" ("key", "value") VALUES ('payouts', $1::jsonb)
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
  `, JSON.stringify(next));
  return next;
}

// ── reading ──────────────────────────────────────────────────────────────────

const FIELDS = `p.id, p."devId", COALESCE(d.name, p."devName") AS "devName", p."discordUserId", p."channelId", p."messageId", p."requestUrl",
  p.text, p.amount, p."amountText", p.description, p."contentItemId", ci."internalName" AS "itemName", p.status, p.duplicates,
  p."adminChannelId", p."adminMessageId", p."paidAt", p."resolvedByName", p."declineReason", p."createdAt", p."updatedAt",
  COALESCE((SELECT json_agg(json_build_object('id', t.id, 'ref', t.ref, 'deliverable', tt.deliverable, 'item', tci."internalName") ORDER BY t.ref)
    FROM "AssetPayoutTask" pt JOIN "AssetTask" t ON t.id = pt."taskId" JOIN "AssetTaskTemplate" tt ON tt.id = t."templateId"
    JOIN "AssetContentItem" tci ON tci.id = t."contentItemId" WHERE pt."payoutId" = p.id), '[]'::json) AS tasks`;
const FROM = `FROM "AssetPayout" p LEFT JOIN "AssetDev" d ON d.id = p."devId" LEFT JOIN "AssetContentItem" ci ON ci.id = p."contentItemId"`;

async function getPayout(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT ${FIELDS} ${FROM} WHERE p.id = $1`, id);
  return rows[0] || null;
}

async function listPayouts(prisma, { status, devId, limit = 200 } = {}) {
  const where = [];
  const values = [];
  if (STATUSES.includes(status)) { values.push(status); where.push(`p.status = $${values.length}`); }
  else where.push(`p.status <> 'needs_info'`);
  if (devId) { values.push(devId); where.push(`p."devId" = $${values.length}`); }
  return prisma.$queryRawUnsafe(`
    SELECT ${FIELDS} ${FROM} WHERE ${where.join(' AND ')}
    ORDER BY (p.status = 'pending') DESC, p."createdAt" DESC
    LIMIT ${Math.min(500, Math.max(1, Number(limit) || 200))}`, ...values);
}

// Earlier requests that overlap this one: same task, or (when no task could be
// matched) same dev and item. Paid ones are the ones that matter most.
async function findDuplicates(prisma, { id, devId, contentItemId, taskIds }) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT p.id, p.status, p."amountText", p.description, p."requestUrl", p."paidAt", p."createdAt"
    FROM "AssetPayout" p
    LEFT JOIN "AssetPayoutTask" pt ON pt."payoutId" = p.id
    WHERE p.id <> $1 AND p.status IN ('pending', 'paid')
      AND (pt."taskId" = ANY($2::text[])
        OR ($3::text IS NOT NULL AND cardinality($2::text[]) = 0 AND p."devId" = $4 AND p."contentItemId" = $3
            AND NOT EXISTS (SELECT 1 FROM "AssetPayoutTask" x WHERE x."payoutId" = p.id)))
    ORDER BY p."createdAt" DESC LIMIT 5`, id, taskIds || [], contentItemId || null, devId || null);
  return rows.map(r => ({ id: r.id, status: r.status, amountText: r.amountText, description: r.description, requestUrl: r.requestUrl, when: r.paidAt || r.createdAt }));
}

// ── reading the request with the model ───────────────────────────────────────

const str = description => ({ type: 'string', description });
const TOOL = {
  name: 'log_payout_request',
  description: 'Record what this message in a dev\'s Payments post is. Call exactly once.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'amount_text', 'amount_number', 'description', 'item', 'task_refs', 'question'],
    properties: {
      kind: { type: 'string', enum: ['request', 'needs_info', 'not_a_request'] },
      amount_text: str('The amount exactly as written, e.g. "30k" or "$45". Empty if none was given.'),
      amount_number: { type: 'number', description: 'The amount as a plain number, e.g. 30000 for "30k". 0 if none was given.' },
      description: str('One line saying what the payout is for, e.g. "Aizen shiny model". Empty for not_a_request.'),
      item: str('The content item it is for, from the list. Empty if none can be told.'),
      task_refs: { type: 'array', items: { type: 'string' }, description: 'Task ref numbers (without #) from the task list that this payout covers. Empty if none match.' },
      question: str('For needs_info only: one short, friendly question asking for exactly what is missing. Otherwise empty.'),
    },
  },
};

let prompt = null;
const systemPrompt = () => (prompt ||= fs.readFileSync(path.join(__dirname, 'prompts/payout.md'), 'utf8').trim());

async function readWithModel({ context, text }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const { fetchWithFreshConnection } = require('../fresh-fetch');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: fetchWithFreshConnection });
  const model = process.env.ASSET_PAYOUT_MODEL || process.env.ASSET_AGENT_EXTRACT_MODEL || 'claude-sonnet-5-5';
  const usage = {};
  for (const reminder of [false, true]) {
    const message = await client.messages.create({
      model, max_tokens: 1500,
      system: [{ type: 'text', text: systemPrompt() }, { type: 'text', text: context }],
      tools: [TOOL],
      // This model rejects a forced tool choice; the prompt asks for the call and we check for it.
      tool_choice: { type: 'auto' },
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: `${text}\n\nCall log_payout_request once.${reminder ? ' Reply only with that tool call.' : ''}` }],
    }, { timeout: 90000 });
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) usage[key] = (usage[key] || 0) + (message.usage?.[key] || 0);
    const call = message.content.find(b => b.type === 'tool_use' && b.name === TOOL.name);
    if (call) return { result: call.input || {}, model, usage };
  }
  return { result: { kind: 'needs_info', question: '' }, model, usage };
}

// What the model is shown: who is asking, what they work on, and what was already requested.
async function buildContext(prisma, dev, ctx) {
  const mine = await q.listTasksDetailed(prisma, { assigneeDevId: dev.id });
  const mineIds = new Set(mine.map(t => t.id));
  // Tasks nobody is assigned to, in this dev's disciplines: the sheet has many of those.
  const open = (await prisma.$queryRawUnsafe(`
    SELECT t.id, t.ref, ci."internalName", tt.deliverable, tt.discipline, t.status
    FROM "AssetTask" t JOIN "AssetContentItem" ci ON ci.id = t."contentItemId" AND NOT ci.archived
    JOIN "AssetTaskTemplate" tt ON tt.id = t."templateId" JOIN "AssetUpdate" u ON u.id = ci."updateId"
    WHERE t.active AND t."assigneeDevId" IS NULL AND tt.discipline = ANY($1::text[]) AND u.status NOT IN ('Released', 'Cancelled')
    ORDER BY ci."itemNumber", tt."taskNumber" LIMIT 250`, dev.disciplines || [])).filter(t => !mineIds.has(t.id));
  const paid = await prisma.$queryRawUnsafe(`
    SELECT pt."taskId", p.status FROM "AssetPayoutTask" pt JOIN "AssetPayout" p ON p.id = pt."payoutId" WHERE p.status IN ('pending', 'paid')`);
  const payState = new Map(paid.map(r => [r.taskId, r.status === 'paid' ? 'PAID' : 'payout requested']));
  const line = t => `#${t.ref} | ${t.internalName} | ${t.deliverable} | ${t.discipline} | ${t.status}${payState.has(t.id) ? ` | ${payState.get(t.id)}` : ''}`;
  const earlier = await listPayouts(prisma, { devId: dev.id, limit: 15 });
  return [
    `DEV: ${dev.name} (${(dev.disciplines || []).join(', ') || 'no discipline set'})`,
    `CONTENT ITEMS: ${ctx.items.filter(i => !i.archived).map(i => i.internalName).join(', ') || 'none'}`,
    `TASKS ASSIGNED TO ${dev.name.toUpperCase()} (ref | item | task | discipline | status):\n${mine.map(line).join('\n') || '(none)'}`,
    `UNASSIGNED TASKS IN THEIR DISCIPLINES:\n${open.map(line).join('\n') || '(none)'}`,
    `THEIR EARLIER PAYOUT REQUESTS:\n${earlier.map(p => `${p.status} | ${p.amountText || 'no amount'} | ${p.description || ''}`).join('\n') || '(none)'}`,
  ].join('\n\n');
}

// Files the dev linked to by Discord message link, resolved from the file index.
async function linkedFiles(prisma, text) {
  const ids = [...String(text || '').matchAll(/discord(?:app)?\.com\/channels\/\d+\/\d+\/(\d+)/g)].map(m => m[1]);
  if (!ids.length) return [];
  return prisma.$queryRawUnsafe(`
    SELECT f.filename, ci."internalName" AS "itemName", f.context
    FROM "AssetFile" f LEFT JOIN "AssetContentItem" ci ON ci.id = f."contentItemId" WHERE f."messageId" = ANY($1::text[])`, ids);
}

// ── a message arrives in a Payments post ─────────────────────────────────────

// message: { id, channelId, parentChannelId, guildId, authorDiscordId, authorName, content, attachments, postedAt }
// Returns { action: 'ignore' } | { action: 'ask', reply } | { action: 'logged', reply, payout }
async function handleRequest(prisma, message, { read = readWithModel } = {}) {
  const settings = await getSettings(prisma);
  if (!settings.enabled) return { action: 'ignore', why: 'off' };
  const ctx = await assistant.indexContext(prisma);
  // The Payments post sits in the dev's own forum; that is how we know whose it is.
  const dev = ctx.devs.find(d => d.discordThreadId && d.discordThreadId === String(message.parentChannelId || ''));
  if (!dev) return { action: 'ignore', why: 'not a dev forum' };
  // Only the dev's own messages are requests. A lead replying in the post is not asking to be paid.
  const approved = new Set((await assistant.getSettings(prisma)).admins.map(a => a.id));
  const isDev = dev.discordUserId ? dev.discordUserId === String(message.authorDiscordId) : !approved.has(String(message.authorDiscordId));
  if (!isDev) return { action: 'ignore', why: 'not the dev' };

  const body = String(message.content || '').trim().slice(0, 2000);
  const attachments = (message.attachments || []).map(a => a.name).filter(Boolean);
  if (!body && !attachments.length) return { action: 'ignore', why: 'empty' };

  // A reply to "what is this for?" continues the request that was waiting on it.
  const [waiting] = await prisma.$queryRawUnsafe(`
    SELECT id, text FROM "AssetPayout"
    WHERE "channelId" = $1 AND "devId" = $2 AND status = 'needs_info' AND "createdAt" > NOW() - INTERVAL '3 days'
    ORDER BY "createdAt" DESC LIMIT 1`, String(message.channelId), dev.id);
  const text = [waiting?.text, body].filter(Boolean).join('\n');
  const files = await linkedFiles(prisma, text);

  const { result, model, usage } = await read({
    context: await buildContext(prisma, dev, ctx),
    text: [
      `${dev.name} wrote in their Payments post:`, '', text,
      attachments.length ? `\n(Attached: ${attachments.join(', ')})` : '',
      files.length ? `\n(The link points at: ${files.map(f => `${f.filename}${f.itemName ? ` for ${f.itemName}` : ''}${f.context ? `, posted with "${f.context}"` : ''}`).join('; ')})` : '',
    ].filter(l => l !== '').join('\n'),
  });
  if (usage) await settingsStore.logUsage(prisma, { batchId: null, pass: 'payout', model, usage });

  if (result.kind === 'not_a_request') return { action: 'ignore', why: 'not a request' };

  const item = result.item ? assistant.findItem(ctx.items, result.item) : assistant.matchItem(ctx.items, text);
  const refs = [...new Set((Array.isArray(result.task_refs) ? result.task_refs : []).map(r => Number(String(r).replace(/^#/, ''))).filter(Number.isInteger))];
  const tasks = refs.length ? await prisma.$queryRawUnsafe(
    `SELECT t.id, t.ref, t."contentItemId" FROM "AssetTask" t WHERE t.ref = ANY($1::int[])`, refs) : [];
  const description = String(result.description || '').trim().slice(0, 300);
  const amountNumber = Number(result.amount_number);
  const requestUrl = message.guildId ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}` : null;
  // Enough to pay on: we know what it is for. An amount is wanted but not required.
  const enough = result.kind === 'request' && !!description && (!!item || tasks.length > 0 || description.length >= 12);
  const id = waiting?.id || newId();
  const fields = [
    dev.id, dev.name, String(message.authorDiscordId), String(message.channelId), String(message.id), message.guildId ? String(message.guildId) : null,
    requestUrl, text, Number.isFinite(amountNumber) && amountNumber > 0 ? amountNumber : null, String(result.amount_text || '').trim().slice(0, 40) || null,
    description || null, item?.id || tasks[0]?.contentItemId || null, enough ? 'pending' : 'needs_info',
  ];
  if (waiting) {
    await prisma.$executeRawUnsafe(`
      UPDATE "AssetPayout" SET "devId" = $2, "devName" = $3, "discordUserId" = $4, "channelId" = $5, "messageId" = $6, "guildId" = $7,
        "requestUrl" = $8, text = $9, amount = $10, "amountText" = $11, description = $12, "contentItemId" = $13, status = $14, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = $1`, id, ...fields);
  } else {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "AssetPayout" ("id", "devId", "devName", "discordUserId", "channelId", "messageId", "guildId", "requestUrl", "text",
        "amount", "amountText", "description", "contentItemId", "status")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, id, ...fields);
  }

  if (!enough) {
    const question = String(result.question || '').trim().slice(0, 400)
      || 'What is this payout for? Name the item and what you made, for example "30k payout for Aizen\'s shiny model", or paste a link to the file.';
    return { action: 'ask', reply: question, managerRoleId: settings.managerRoleId || null, payoutId: id };
  }

  await prisma.$executeRawUnsafe(`DELETE FROM "AssetPayoutTask" WHERE "payoutId" = $1`, id);
  for (const t of tasks) {
    await prisma.$executeRawUnsafe(`INSERT INTO "AssetPayoutTask" ("payoutId", "taskId") VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, t.id);
  }
  const duplicates = await findDuplicates(prisma, { id, devId: dev.id, contentItemId: fields[11], taskIds: tasks.map(t => t.id) });
  await prisma.$executeRawUnsafe(`UPDATE "AssetPayout" SET duplicates = $2::jsonb WHERE id = $1`, id, JSON.stringify(duplicates));
  const payout = await getPayout(prisma, id);
  await service.logActivity({ prisma, source: 'human', actor: { userId: null, name: `${dev.name} (Discord)` } }, [{
    entityType: 'payout', entityId: id, contentItemId: payout.contentItemId, action: 'requested',
    label: `Payout requested: ${payout.amountText || 'no amount'} for ${payout.description}`,
  }]);
  broadcast();
  return {
    action: 'logged', payout, adminChannelId: settings.adminChannelId || null,
    reply: `Logged${payout.amountText ? ` **${payout.amountText}**` : ''} for **${payout.description}**${payout.amountText ? '' : ' (no amount given, an admin will confirm it)'}. I have passed it to the admins and will let you know here when it is paid.`,
  };
}

function broadcast() {
  try { require('../events').broadcast('assets.changed', { kind: 'payouts', timestamp: new Date().toISOString() }); } catch { /* no listeners */ }
}

// ── resolving ────────────────────────────────────────────────────────────────

// decision: 'paid' | 'declined' | 'reopen'. via 'discord' is applied to Discord
// by the bot at once; via 'web' is picked up on the bot's next poll.
async function resolve(prisma, id, { decision, actorName, reason, via = 'web' }) {
  const payout = await getPayout(prisma, id);
  if (!payout) throw new AssetError(404, 'Payout request not found');
  const next = { paid: 'paid', declined: 'declined', reopen: 'pending' }[decision];
  if (!next) throw new AssetError(400, 'Unknown decision');
  if (payout.status === 'needs_info') throw new AssetError(409, 'That request is still waiting on the dev to say what it is for.');
  if (payout.status === next) throw new AssetError(409, next === 'paid' ? `Already paid${payout.resolvedByName ? ` by ${payout.resolvedByName}` : ''}.` : `Already ${next}.`);
  const why = String(reason || '').trim().slice(0, 300) || null;
  if (next === 'declined' && !why) throw new AssetError(400, 'Say why it is declined, so the dev knows.');
  await prisma.$executeRawUnsafe(`
    UPDATE "AssetPayout"
    SET status = $2, "paidAt" = CASE WHEN $2 = 'paid' THEN CURRENT_TIMESTAMP ELSE NULL END, "resolvedByName" = $3, "declineReason" = $4,
      "needsDiscordSync" = $5, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = $1`, id, next, next === 'pending' ? null : actorName || null, next === 'declined' ? why : null, via !== 'discord');
  const updated = await getPayout(prisma, id);
  await service.logActivity({ prisma, source: 'human', actor: { userId: null, name: actorName || 'Admin' } }, [{
    entityType: 'payout', entityId: id, contentItemId: updated.contentItemId, action: next,
    label: `Payout ${next === 'pending' ? 'reopened' : next}: ${updated.amountText || 'no amount'} to ${updated.devName} for ${updated.description}${why ? ` (${why})` : ''}`,
  }]);
  broadcast();
  return updated;
}

// Payouts changed on the web that Discord has not been told about yet.
async function claimDiscordSync(prisma, limit = 10) {
  const rows = await prisma.$queryRawUnsafe(`
    UPDATE "AssetPayout" SET "needsDiscordSync" = false
    WHERE id IN (SELECT id FROM "AssetPayout" WHERE "needsDiscordSync" ORDER BY "updatedAt" LIMIT $1)
    RETURNING id`, limit);
  const out = [];
  for (const r of rows) out.push(await getPayout(prisma, r.id));
  return out;
}

async function markPosted(prisma, id, { adminChannelId, adminMessageId }) {
  await prisma.$executeRawUnsafe(`UPDATE "AssetPayout" SET "adminChannelId" = $2, "adminMessageId" = $3 WHERE id = $1`,
    id, String(adminChannelId || ''), String(adminMessageId || ''));
}

module.exports = {
  STATUSES, TOOL, getSettings, saveSettings, getPayout, listPayouts, findDuplicates,
  handleRequest, resolve, claimDiscordSync, markPosted,
};
