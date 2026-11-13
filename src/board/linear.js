// linear.js
// The Assets board's link to Linear: read the whole team, and make the same changes
// /linear makes in Discord (devtrack-bot/src/linear.js): a dev's name on the end of
// a task's title (" - Ruku") and its state. Needs LINEAR_API_KEY (on Railway it's a
// reference to the bot's own variable, so the key lives in one place).

const API = 'https://api.linear.app/graphql';
const TEAM_KEY = () => process.env.LINEAR_TEAM_KEY || 'ASS';

const enabled = () => !!process.env.LINEAR_API_KEY;

async function gql(query, variables = {}) {
  if (!enabled()) throw new Error('LINEAR_API_KEY is not set on the backend');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: process.env.LINEAR_API_KEY },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) throw new Error(`Linear: ${body.errors?.[0]?.message || `HTTP ${res.status}`}`);
  return body.data;
}

let team = null;
async function teamInfo(fresh = false) {
  if (team && !fresh) return team;
  const { teams } = await gql(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name
    states { nodes { id name type position } } } } }`, { key: TEAM_KEY() });
  const t = teams.nodes[0];
  if (!t) throw new Error(`No Linear team with the key ${TEAM_KEY()}`);
  const states = [...t.states.nodes].sort((a, b) => a.position - b.position);
  team = {
    id: t.id, key: t.key, name: t.name, states,
    todo: states.find(s => s.type === 'unstarted') || states.find(s => s.type === 'backlog'),
    started: states.find(s => s.type === 'started'),
    done: states.find(s => s.type === 'completed'),
  };
  return team;
}

const ISSUE = `id identifier title url description createdAt updatedAt startedAt completedAt
  state { name type } parent { id identifier } project { name }
  labels { nodes { name parent { name } } }
  comments(first: 30) { nodes { body createdAt user { name } } }`;

// Every issue in the team that isn't archived.
async function allIssues() {
  const t = await teamInfo();
  const out = [];
  let after = null;
  do {
    const { issues } = await gql(`query($team: ID!, $after: String) { issues(first: 100, after: $after,
      filter: { team: { id: { eq: $team } } }) { pageInfo { hasNextPage endCursor } nodes { ${ISSUE} } } }`, { team: t.id, after });
    out.push(...issues.nodes);
    after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
  } while (after);
  return out;
}

// The name on the end of a title ("Texture - Ruku" -> "Ruku"), and the title without it.
const NAME_TAIL = / - ([^-]+)$/;
const nameOf = title => (NAME_TAIL.exec(title || '') || [])[1]?.trim() || null;
const withoutName = title => String(title || '').replace(NAME_TAIL, '').trim();

async function updateIssue(id, input) {
  const { issueUpdate } = await gql(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) {
    success issue { ${ISSUE} } } }`, { id, input });
  if (!issueUpdate.success) throw new Error('Linear did not take the change');
  return issueUpdate.issue;
}

// Untasked: the name comes off and it goes back to Todo. In progress: the dev's name on the end, In Progress.
// Done: Done, keeping the name.
async function setStatus(issue, status, devName) {
  const t = await teamInfo();
  if (status === 'in_progress') {
    if (!devName) throw new Error('Pick who is doing it');
    return updateIssue(issue.id, { title: `${withoutName(issue.title)} - ${devName}`, stateId: t.started.id });
  }
  if (status === 'done') return updateIssue(issue.id, { stateId: t.done.id });
  if (status === 'untasked') return updateIssue(issue.id, { title: withoutName(issue.title), stateId: t.todo.id });
  throw new Error(`Unknown status ${status}`);
}

async function comment(issueId, body) {
  const { commentCreate } = await gql(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
    { input: { issueId, body } });
  return commentCreate.success;
}

module.exports = { enabled, gql, teamInfo, allIssues, setStatus, comment, nameOf, withoutName };
