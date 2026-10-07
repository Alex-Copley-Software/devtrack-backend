// Builds what the extraction model sees: the tracker state and the batch of
// messages, as compact text. Also returns the lookup tables the validator
// uses to check every id the model sends back.

const q = require('../queries');
const C = require('../constants');

// The updates the agent works on: anything in development or testing, or the
// ones still being planned if nothing is further along.
function pickActiveUpdates(updates) {
  const live = updates.filter(u => ['In Development', 'Testing'].includes(u.status));
  return live.length ? live : updates.filter(u => u.status === 'Planning');
}

async function buildSnapshot(prisma) {
  const [updates, devs, contentTypes] = await Promise.all([q.listUpdates(prisma), q.listDevs(prisma), q.listContentTypes(prisma)]);
  const active = pickActiveUpdates(updates);
  const items = [];
  const tasks = [];
  for (const update of active) {
    items.push(...await q.listItems(prisma, { updateId: update.id }));
    tasks.push(...await q.listTasksDetailed(prisma, { updateId: update.id }));
  }
  return {
    updates,
    activeUpdates: active,
    openUpdates: updates.filter(u => !['Released', 'Cancelled'].includes(u.status)),
    items,
    tasks,
    devs: devs.filter(d => d.status !== 'Inactive'),
    contentTypes: contentTypes.filter(t => t.active),
  };
}

// Stable ordering throughout, so the rendered text is byte-identical while
// the tracker has not changed (which is what lets the prompt cache hit).
function renderTrackerState(snapshot) {
  const lines = [];
  lines.push(`Task statuses: ${C.TASK_STATUSES.join(', ')}`);
  lines.push(`Content types: ${snapshot.contentTypes.map(t => t.name).join(', ')}`);
  lines.push('');
  lines.push('UPDATES (open)');
  for (const u of [...snapshot.openUpdates].sort((a, b) => a.number - b.number)) {
    lines.push(`- Update ${u.number} "${u.name}" | ${u.status}${u.leadName ? ` | lead ${u.leadName}` : ''}${u.targetRelease ? ` | target ${u.targetRelease}` : ''}`);
  }
  lines.push('');
  lines.push('ROSTER');
  for (const d of [...snapshot.devs].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`- ${d.name} | ${d.disciplines.join(', ') || 'no discipline'}${d.status !== 'Active' ? ` | ${d.status}` : ''}`);
  }
  lines.push('');
  lines.push('CONTENT AND OPEN TASKS (active updates). Task line: #ref | discipline | deliverable | status | assignee | due');
  const tasksByItem = new Map();
  for (const t of snapshot.tasks) {
    if (!tasksByItem.has(t.contentItemId)) tasksByItem.set(t.contentItemId, []);
    tasksByItem.get(t.contentItemId).push(t);
  }
  const updateNumber = new Map(snapshot.updates.map(u => [u.id, u.number]));
  for (const item of [...snapshot.items].sort((a, b) => a.itemNumber - b.itemNumber)) {
    const all = tasksByItem.get(item.id) || [];
    const open = all.filter(t => C.OPEN_TASK_STATUSES.includes(t.status));
    const display = item.displayName && item.displayName !== item.internalName ? ` (display name "${item.displayName}")` : '';
    lines.push(`ITEM "${item.internalName}"${display} | ${item.contentType} | update ${updateNumber.get(item.updateId)}${item.ownerName ? ` | owner ${item.ownerName}` : ''} | ${item.done}/${item.countable} done`);
    for (const t of open) {
      lines.push(`  #${t.ref} | ${t.discipline} | ${t.deliverable} | ${t.status} | ${t.assigneeName || 'unassigned'} | ${t.dueDate || 'no due date'}`);
    }
    if (!open.length) lines.push('  (no open tasks)');
  }
  if (!snapshot.items.length) lines.push('(no content items yet)');
  return lines.join('\n');
}

// messages: AssetAgentMessage rows, oldest first. Returns the text plus the
// m1..mN label map, so the model never handles raw Discord ids.
function renderBatch(messages, snapshot) {
  const devByDiscord = new Map(snapshot.devs.filter(d => d.discordUserId).map(d => [d.discordUserId, d]));
  const labels = new Map();
  const lines = messages.map((m, i) => {
    const label = `m${i + 1}`;
    labels.set(label, m);
    const dev = devByDiscord.get(m.authorDiscordId);
    const who = dev ? `${dev.name} (${dev.disciplines.join(', ') || 'roster'})` : `${m.authorName || 'unknown'} (not on the roster)`;
    const when = new Date(m.postedAt).toISOString().slice(0, 16).replace('T', ' ');
    const files = Array.isArray(m.attachments) && m.attachments.length ? ` {attachments: ${m.attachments.map(a => a.name || a.url).join(', ')}}` : '';
    return `[${label}] ${when} UTC | ${who}: ${String(m.content || '').replace(/\s+/g, ' ').trim()}${files}`;
  });
  return { text: lines.join('\n'), labels };
}

module.exports = { pickActiveUpdates, buildSnapshot, renderTrackerState, renderBatch };
