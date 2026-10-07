// Agent suggestions: storing validated proposals, and accepting or rejecting
// them. Accepting applies the change through the same service calls a human
// edit uses, with source = 'agent' and the accepting person as the actor.

const { newId } = require('../db');
const service = require('../service');
const C = require('../constants');
const { FIELD_FOR } = require('./validate');

const { AssetError } = service;

const FIELDS = `
  s.id, s.type, s.status, s.payload, s."appliedPayload", s.before, s.after, s.summary, s.confidence, s.reason, s.evidence,
  s."batchId", s."updateId", s."contentItemId", s."taskId", s."discordChannelId", s."discordMessageId",
  s."resolvedByUserId", s."resolvedByName", s."resolvedVia", s."resolvedAt", s."createdAt"`;

function notify(kind = 'suggestion') {
  try { require('../../events').broadcast('assets.changed', { kind, source: 'agent', timestamp: new Date().toISOString() }); } catch { /* no listeners */ }
}

async function listSuggestions(prisma, { status = 'pending', limit = 200 } = {}) {
  const where = status === 'pending' ? `s.status = 'pending'` : status === 'resolved' ? `s.status <> 'pending'` : 'TRUE';
  return prisma.$queryRawUnsafe(`
    SELECT ${FIELDS} FROM "AssetAgentSuggestion" s
    WHERE ${where}
    ORDER BY ${status === 'pending' ? 's."createdAt" DESC, s.confidence DESC' : 's."resolvedAt" DESC NULLS LAST'}
    LIMIT $1`, Math.min(500, Number(limit) || 200));
}

async function getSuggestion(prisma, id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT ${FIELDS} FROM "AssetAgentSuggestion" s WHERE s.id = $1`, id);
  return rows[0] || null;
}

async function countPending(prisma) {
  const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetAgentSuggestion" WHERE status = 'pending'`);
  return n;
}

// Stores the validator's accepted actions, skipping any that:
//   - duplicate a suggestion that is still pending
//   - repeat one a person rejected in the last 24 hours
//   - would overwrite a field a person edited after the evidence was posted
// evidenceFor(labels) resolves message labels to stored evidence rows.
async function storeSuggestions(prisma, accepted, { batchId, evidenceFor }) {
  const stored = [];
  const skipped = [];
  for (const action of accepted) {
    const evidence = evidenceFor(action.evidence);
    const dup = await prisma.$queryRawUnsafe(`
      SELECT id, status FROM "AssetAgentSuggestion"
      WHERE "dedupeKey" = $1 AND (status = 'pending' OR (status = 'rejected' AND "resolvedAt" > NOW() - INTERVAL '24 hours'))
      LIMIT 1`, action.dedupeKey);
    if (dup.length) { skipped.push({ action, why: dup[0].status === 'pending' ? 'already pending' : 'rejected recently' }); continue; }

    if (action.taskId && action.field) {
      const latest = evidence.reduce((max, e) => (e.postedAt > max ? e.postedAt : max), '');
      const edited = await prisma.$queryRawUnsafe(`
        SELECT 1 FROM "AssetActivity"
        WHERE "taskId" = $1 AND field = $2 AND source = 'human' AND "createdAt" > $3::timestamptz
        LIMIT 1`, action.taskId, action.field, latest);
      if (edited.length) { skipped.push({ action, why: 'a person changed that field after the message was posted' }); continue; }
    }

    const id = newId();
    await prisma.$executeRawUnsafe(`
      INSERT INTO "AssetAgentSuggestion" ("id", "type", "payload", "before", "after", "summary", "confidence", "reason",
        "evidence", "dedupeKey", "batchId", "updateId", "contentItemId", "taskId")
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
    `, id, action.type, JSON.stringify(action.payload), JSON.stringify(action.before ?? null), JSON.stringify(action.after ?? null),
    action.summary, action.confidence, action.reason, JSON.stringify(evidence), action.dedupeKey, batchId || null,
    action.updateId || null, action.contentItemId || null, action.taskId || null);
    stored.push(await getSuggestion(prisma, id));
  }
  if (stored.length) notify();
  return { stored, skipped };
}

// Applies one suggestion's change. edits may override payload fields
// ("edit then accept"). Returns the payload that was applied.
async function applyChange(prisma, suggestion, { actor, edits }) {
  const payload = { ...suggestion.payload, ...(edits || {}) };
  const ctx = {
    prisma, source: 'agent',
    actor: { userId: actor.userId || null, name: actor.name },
    suggestionId: suggestion.id,
    evidence: suggestion.evidence,
  };
  switch (suggestion.type) {
    case 'update_task_status': await service.updateTask(ctx, suggestion.taskId, { status: payload.status }); break;
    case 'assign_task': await service.updateTask(ctx, suggestion.taskId, { assigneeDevId: payload.assigneeDevId || null }); break;
    case 'set_due_date': await service.updateTask(ctx, suggestion.taskId, { dueDate: payload.dueDate }); break;
    case 'add_task_note': await service.appendTaskNote(ctx, suggestion.taskId, payload.note); break;
    case 'mark_blocked':
      await service.updateTask(ctx, suggestion.taskId, { status: 'Blocked' });
      await service.appendTaskNote(ctx, suggestion.taskId, `Blocked: ${payload.reason}`);
      break;
    case 'create_content_item':
      await service.createContentItem(ctx, {
        updateId: payload.updateId, contentTypeId: payload.contentTypeId,
        internalName: payload.internalName, displayName: payload.displayName || null,
      });
      break;
    case 'flag_unknown': break; // accepting just acknowledges it
    default: throw new AssetError(400, `Unknown suggestion type "${suggestion.type}"`);
  }
  return payload;
}

// decision: 'accept' | 'reject'. via: 'web' | 'discord' | 'auto'.
// The row is claimed first (pending -> resolved in one statement) so two
// people clicking at once cannot both apply it; a failed apply puts it back.
async function resolveSuggestion(prisma, id, { decision, actor, via = 'web', edits }) {
  const hasEdits = !!edits && Object.keys(edits).length > 0;
  const status = decision === 'reject' ? 'rejected' : hasEdits ? 'edited' : 'accepted';
  const claimed = await prisma.$queryRawUnsafe(`
    UPDATE "AssetAgentSuggestion"
    SET status = $2, "resolvedByUserId" = $3, "resolvedByName" = $4, "resolvedVia" = $5, "resolvedAt" = CURRENT_TIMESTAMP
    WHERE id = $1 AND status = 'pending'
    RETURNING id`, id, status, actor.userId || null, actor.name, via);
  if (!claimed.length) {
    const existing = await getSuggestion(prisma, id);
    if (!existing) throw new AssetError(404, 'Suggestion not found');
    throw new AssetError(409, `Already ${existing.status}${existing.resolvedByName ? ` by ${existing.resolvedByName}` : ''}`);
  }
  if (decision !== 'reject') {
    const suggestion = await getSuggestion(prisma, id);
    try {
      const applied = await applyChange(prisma, suggestion, { actor, edits });
      await prisma.$executeRawUnsafe(`UPDATE "AssetAgentSuggestion" SET "appliedPayload" = $2::jsonb WHERE id = $1`, id, JSON.stringify(applied));
    } catch (err) {
      await prisma.$executeRawUnsafe(`
        UPDATE "AssetAgentSuggestion"
        SET status = 'pending', "resolvedByUserId" = NULL, "resolvedByName" = NULL, "resolvedVia" = NULL, "resolvedAt" = NULL
        WHERE id = $1`, id);
      throw err;
    }
  }
  notify();
  return getSuggestion(prisma, id);
}

// Auto-apply is off by default, per type, and never applies to creating items.
function shouldAutoApply(settings, suggestion) {
  if (C.NEVER_AUTO_APPLY.includes(suggestion.type)) return false;
  const rule = settings.autoApply?.[suggestion.type];
  return !!rule && rule.enabled === true && suggestion.confidence >= rule.threshold;
}

// What a person may change before accepting, per type.
const EDITABLE = {
  update_task_status: ['status'], assign_task: ['assigneeDevId'], set_due_date: ['dueDate'],
  add_task_note: ['note'], mark_blocked: ['reason'], create_content_item: ['internalName', 'displayName', 'contentTypeId', 'updateId'],
};
function pickEdits(type, edits) {
  if (!edits || typeof edits !== 'object') return undefined;
  const out = {};
  for (const key of EDITABLE[type] || []) if (edits[key] !== undefined && edits[key] !== null && edits[key] !== '') out[key] = edits[key];
  return Object.keys(out).length ? out : undefined;
}

module.exports = { listSuggestions, getSuggestion, countPending, storeSuggestions, resolveSuggestion, shouldAutoApply, pickEdits, FIELD_FOR };
