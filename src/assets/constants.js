// Enums for the asset tracker. Disciplines and content types are editable
// lists stored in the database; these are only the first-run defaults.

const TASK_STATUSES = ['Not Started', 'In Progress', 'Review', 'Done', 'Blocked', 'N/A'];
const OPEN_TASK_STATUSES = ['Not Started', 'In Progress', 'Review', 'Blocked'];
const PRIORITIES = ['High', 'Medium', 'Low'];
const UPDATE_STATUSES = ['Planning', 'In Development', 'Testing', 'Released', 'Cancelled'];
const DEV_STATUSES = ['Active', 'On Break', 'Inactive'];
const ACTIVITY_SOURCES = ['human', 'agent', 'import'];

const DEFAULT_DISCIPLINES = [
  'Design', 'Art', 'Unit Mesh', 'Unit Texture', 'Animation', 'VFX', 'SFX', 'Engineers',
  'Data', 'UI', 'QA', 'Rigging', 'VFX Scripting', 'Builder', 'Manager',
];

const DEFAULT_CONTENT_TYPES = ['Unit', 'Map / Stage', 'Enemy', 'Boss', 'Portal', 'Skin', 'Update Launch'];

const SUGGESTION_TYPES = [
  'update_task_status', 'assign_task', 'set_due_date', 'add_task_note',
  'mark_blocked', 'create_content_item', 'flag_unknown',
];
const SUGGESTION_STATUSES = ['pending', 'accepted', 'rejected', 'edited'];
// Never auto-applied, whatever the settings say.
// log_expenses is not in SUGGESTION_TYPES on purpose: the agent reading chat can never emit it. Only the
// assistant proposes it, on a manager's instruction, and it writes to the Revenue page once accepted.
const NEVER_AUTO_APPLY = ['create_content_item', 'flag_unknown', 'log_expenses'];

function isEnabled(name) {
  return String(process.env[name] || '').toLowerCase() === 'true';
}

module.exports = {
  TASK_STATUSES, OPEN_TASK_STATUSES, PRIORITIES, UPDATE_STATUSES, DEV_STATUSES, ACTIVITY_SOURCES,
  DEFAULT_DISCIPLINES, DEFAULT_CONTENT_TYPES,
  SUGGESTION_TYPES, SUGGESTION_STATUSES, NEVER_AUTO_APPLY,
  isEnabled,
};
