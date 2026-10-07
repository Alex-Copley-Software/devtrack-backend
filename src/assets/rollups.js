// Rollup math shared by every query. Counts come from SQL (TASK_COUNTS);
// progress is derived here so there is one definition of it.
//
//   progress = Done / active tasks that are not N/A

// SQL aggregate columns over an "AssetTask" alias. Assumes the alias is
// LEFT JOINed, so COUNT(alias.id) ignores the null row.
function taskCounts(t = 't') {
  const c = cond => `COUNT(${t}.id) FILTER (WHERE ${t}.active${cond ? ` AND ${cond}` : ''})::int`;
  return `
    ${c('')} AS "taskCount",
    ${c(`${t}.status <> 'N/A'`)} AS "countable",
    ${c(`${t}.status = 'Done'`)} AS "done",
    ${c(`${t}.status = 'In Progress'`)} AS "inProgress",
    ${c(`${t}.status = 'Review'`)} AS "review",
    ${c(`${t}.status = 'Blocked'`)} AS "blocked",
    ${c(`${t}.status = 'Not Started'`)} AS "notStarted"`;
}

function progressOf({ done = 0, countable = 0 } = {}) {
  if (!countable) return 0;
  return Math.round((done / countable) * 1000) / 1000;
}

function withProgress(row) {
  return { ...row, progress: progressOf(row) };
}

// Workload bar on the team view: open tasks against a comfortable ceiling.
const WORKLOAD_CEILING = 12;
function workloadOf(openTasks) {
  const ratio = Math.min(1, (openTasks || 0) / WORKLOAD_CEILING);
  const level = openTasks >= WORKLOAD_CEILING ? 'heavy' : openTasks >= WORKLOAD_CEILING / 2 ? 'steady' : 'light';
  return { ratio: Math.round(ratio * 100) / 100, level };
}

module.exports = { taskCounts, progressOf, withProgress, workloadOf, WORKLOAD_CEILING };
