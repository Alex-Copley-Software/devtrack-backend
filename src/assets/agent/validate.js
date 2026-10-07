// Turns the model's proposed actions into checked suggestions. Pure: given a
// snapshot of the tracker and the batch's message labels, it accepts only
// actions whose every id resolves and whose values fit the enums, and drops
// the rest with a reason. Nothing the model says is trusted past this point.

const C = require('../constants');

const norm = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const slug = v => norm(v).replace(/[^a-z0-9]+/g, '');
const text = v => String(v ?? '').trim();

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

// The task field each action type would overwrite (null = additive, nothing is overwritten).
const FIELD_FOR = {
  update_task_status: 'status',
  mark_blocked: 'status',
  assign_task: 'assigneeDevId',
  set_due_date: 'dueDate',
  add_task_note: null,
};

function validateActions(rawActions, { snapshot, labels }) {
  const accepted = [];
  const dropped = [];
  const taskByRef = new Map(snapshot.tasks.map(t => [String(t.ref), t]));
  const itemById = new Map(snapshot.items.map(i => [i.id, i]));
  const devByName = new Map(snapshot.devs.map(d => [norm(d.name), d]));
  const typeByName = new Map(snapshot.contentTypes.map(t => [norm(t.name), t]));
  const openUpdateByNumber = new Map(snapshot.openUpdates.map(u => [String(u.number), u]));
  const seen = new Set();

  for (const raw of Array.isArray(rawActions) ? rawActions : []) {
    const drop = why => dropped.push({ action: raw, why });
    if (!raw || typeof raw !== 'object') { drop('not an object'); continue; }
    const type = text(raw.type);
    if (!C.SUGGESTION_TYPES.includes(type)) { drop(`unknown action type "${type}"`); continue; }

    const evidence = [...new Set((Array.isArray(raw.evidence) ? raw.evidence : []).map(e => text(e).replace(/^\[|\]$/g, '')))]
      .filter(label => labels.has(label));
    if (!evidence.length) { drop('no valid evidence message'); continue; }

    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence)) { drop('confidence is not a number'); continue; }

    const base = {
      type,
      confidence: Math.min(1, Math.max(0, confidence)),
      reason: text(raw.reason).slice(0, 300),
      evidence,
    };

    if (type === 'flag_unknown') {
      const note = text(raw.note) || text(raw.reason);
      if (!note) { drop('flag_unknown with nothing to flag'); continue; }
      const key = `flag_unknown:${slug(note).slice(0, 80)}`;
      if (seen.has(key)) { drop('duplicate within batch'); continue; }
      seen.add(key);
      accepted.push({ ...base, payload: { note: note.slice(0, 500) }, dedupeKey: key, summary: note.slice(0, 200), before: null, after: null });
      continue;
    }

    if (type === 'create_content_item') {
      const internalName = text(raw.item_internal_name);
      const contentType = typeByName.get(norm(raw.content_type));
      const update = openUpdateByNumber.get(text(raw.update_number).replace(/^#/, ''));
      if (!internalName) { drop('create_content_item without a name'); continue; }
      if (!contentType) { drop(`unknown content type "${text(raw.content_type)}"`); continue; }
      if (!update) { drop(`unknown or closed update "${text(raw.update_number)}"`); continue; }
      const exists = snapshot.items.some(i => i.updateId === update.id && (slug(i.internalName) === slug(internalName) || slug(i.displayName) === slug(internalName)));
      if (exists) { drop(`"${internalName}" already exists in update ${update.number}`); continue; }
      const key = `create_content_item:${update.id}:${slug(internalName)}`;
      if (seen.has(key)) { drop('duplicate within batch'); continue; }
      seen.add(key);
      const displayName = text(raw.display_name) || null;
      accepted.push({
        ...base,
        payload: { updateId: update.id, contentTypeId: contentType.id, internalName: internalName.slice(0, 80), displayName },
        dedupeKey: key, updateId: update.id,
        summary: `New ${contentType.name} "${internalName}" in update #${update.number} ${update.name}`,
        before: null,
        after: { internalName, displayName, contentType: contentType.name, update: `#${update.number} ${update.name}` },
      });
      continue;
    }

    // Everything else targets an existing task.
    const task = taskByRef.get(text(raw.task_ref).replace(/^#/, ''));
    if (!task) { drop(`unknown task ref "${text(raw.task_ref)}"`); continue; }
    const item = itemById.get(task.contentItemId);
    const target = { taskId: task.id, contentItemId: task.contentItemId, updateId: task.updateId };
    const where = `${item?.internalName || task.internalName} · ${task.deliverable}`;
    let payload; let before; let after; let key; let summary;

    if (type === 'update_task_status') {
      const status = C.TASK_STATUSES.find(s => norm(s) === norm(raw.status));
      if (!status) { drop(`status "${text(raw.status)}" is not in the list`); continue; }
      if (status === task.status) { drop('status is already that'); continue; }
      payload = { status }; before = { status: task.status }; after = { status };
      key = `update_task_status:${task.id}:${status}`;
      summary = `${where}: ${task.status} → ${status}`;
    } else if (type === 'mark_blocked') {
      const reason = text(raw.blocker_reason) || text(raw.note);
      if (!reason) { drop('mark_blocked without a reason'); continue; }
      if (task.status === 'Blocked') { drop('task is already blocked'); continue; }
      payload = { reason: reason.slice(0, 300) }; before = { status: task.status }; after = { status: 'Blocked', note: `Blocked: ${reason.slice(0, 300)}` };
      key = `mark_blocked:${task.id}`;
      summary = `${where}: blocked (${reason.slice(0, 120)})`;
    } else if (type === 'assign_task') {
      const dev = devByName.get(norm(raw.assignee));
      if (!dev) { drop(`"${text(raw.assignee)}" is not on the roster`); continue; }
      if (dev.id === task.assigneeDevId) { drop('already assigned to that dev'); continue; }
      payload = { assigneeDevId: dev.id }; before = { assignee: task.assigneeName || null }; after = { assignee: dev.name };
      key = `assign_task:${task.id}:${dev.id}`;
      summary = `${where}: assign to ${dev.name}`;
    } else if (type === 'set_due_date') {
      const dueDate = text(raw.due_date).slice(0, 10);
      if (!isDate(dueDate)) { drop(`due date "${text(raw.due_date)}" is not a date`); continue; }
      if (dueDate === task.dueDate) { drop('due date is already that'); continue; }
      payload = { dueDate }; before = { dueDate: task.dueDate || null }; after = { dueDate };
      key = `set_due_date:${task.id}:${dueDate}`;
      summary = `${where}: due ${dueDate}`;
    } else {
      const note = text(raw.note);
      if (!note) { drop('add_task_note without a note'); continue; }
      if ((task.notes || '').includes(note)) { drop('note is already on the task'); continue; }
      payload = { note: note.slice(0, 500) }; before = { notes: task.notes || null }; after = { notes: task.notes ? `${task.notes}\n${note.slice(0, 500)}` : note.slice(0, 500) };
      key = `add_task_note:${task.id}:${slug(note).slice(0, 60)}`;
      summary = `${where}: note "${note.slice(0, 120)}"`;
    }

    if (seen.has(key)) { drop('duplicate within batch'); continue; }
    seen.add(key);
    accepted.push({ ...base, ...target, payload, before, after, dedupeKey: key, summary, field: FIELD_FOR[type] });
  }
  return { accepted, dropped };
}

module.exports = { validateActions, FIELD_FOR };
