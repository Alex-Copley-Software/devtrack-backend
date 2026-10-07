// Who can do what on the Assets page. Pure functions, no database.
//
//   admin    owner / admin role: everything, including templates and the agent
//   manager  engineer role, a login linked to a dev with the Manager
//            discipline, or the lead of the update in question
//   dev      a login linked to a roster dev: status, due date and notes on
//            tasks assigned to that dev
//   viewer   everyone else with the page: read only

const DEV_EDITABLE_TASK_FIELDS = ['status', 'dueDate', 'notes'];

// role: DevTrack role of the login, if any. dev: the roster entry, if any.
function accessFor({ role = '', dev = null, updates = [] }) {
  const isAdmin = role === 'owner' || role === 'admin';
  const hasManagerDiscipline = !!dev && [dev.discipline, dev.secondaryDiscipline, ...(dev.disciplines || [])].includes('Manager');
  const isManager = isAdmin || role === 'engineer' || hasManagerDiscipline;
  const leadUpdateIds = dev ? updates.filter(u => u.leadDevId === dev.id).map(u => u.id) : [];
  return {
    level: isAdmin ? 'admin' : isManager ? 'manager' : dev ? 'dev' : 'viewer',
    isAdmin,
    isManager,
    devId: dev?.id || null,
    leadUpdateIds,
  };
}

// For a signed-in DevTrack user: the roster dev linked to that login, if any.
function resolveAccess(user, { devs = [], updates = [] } = {}) {
  const dev = devs.find(d => d.userId && d.userId === user?.id) || null;
  return accessFor({ role: user?.role || '', dev, updates });
}

function canManageUpdate(access, updateId) {
  return access.isManager || (!!updateId && access.leadUpdateIds.includes(updateId));
}

// task: { assigneeDevId, updateId }. fields: names being changed.
function canEditTask(access, task, fields) {
  if (canManageUpdate(access, task.updateId)) return true;
  if (!access.devId || task.assigneeDevId !== access.devId) return false;
  return fields.every(f => DEV_EDITABLE_TASK_FIELDS.includes(f));
}

const canEditTemplates = access => access.isAdmin;
const canEditAgentSettings = access => access.isAdmin;
const canEditRoster = access => access.isManager;
const canResolveSuggestion = (access, updateId) => canManageUpdate(access, updateId);

module.exports = {
  DEV_EDITABLE_TASK_FIELDS,
  accessFor,
  resolveAccess,
  canManageUpdate,
  canEditTask,
  canEditTemplates,
  canEditAgentSettings,
  canEditRoster,
  canResolveSuggestion,
};
