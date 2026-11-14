// import-linear.js
// The Assets board used to live in Linear. This copies it into DevTrack once, the
// first time the backend starts with an empty board and LINEAR_API_KEY set, and
// never talks to Linear again (the key can be removed afterwards).
//
// What comes across, as the board showed it:
//   the issues under the "Units" issue      cards (kind 'unit'), keeping their id and identifier,
//                                           so images, notes, check-ins and history stay attached
//   their project ("Winter Update [6.0]")   the card's update
//   Rarity / Element labels, Notion link    the same on the card
//   the issues under a unit                 tasks; "Equipment & Evo Item Icons" becomes "Icons",
//                                           with Equipment and Evo Item under it
//   the issues under a task (Shinies)       subtasks
//   state, and the name on the end of the   status and dev ("Texture - Ruku" is Ruku's, in progress)
//   title
//   files sent to Linear                    a delivery with the file names and a link to the issue
// Canceled and duplicate issues are left out.

const { newId } = require('../assets/db');

const API = 'https://api.linear.app/graphql';
const TEAM_KEY = () => process.env.LINEAR_TEAM_KEY || 'ASS';

async function gql(query, variables = {}) {
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

const ISSUE = `id identifier title url description createdAt updatedAt startedAt completedAt
  state { name type } parent { id identifier } project { name }
  labels { nodes { name parent { name } } }
  comments(first: 50) { nodes { body createdAt user { name } } }`;

// Every issue in the team that isn't archived.
async function allIssues() {
  const { teams } = await gql(`query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`, { key: TEAM_KEY() });
  const team = teams.nodes[0];
  if (!team) throw new Error(`No Linear team with the key ${TEAM_KEY()}`);
  const out = [];
  let after = null;
  do {
    const { issues } = await gql(`query($team: ID!, $after: String) { issues(first: 100, after: $after,
      filter: { team: { id: { eq: $team } } }) { pageInfo { hasNextPage endCursor } nodes { ${ISSUE} } } }`, { team: team.id, after });
    out.push(...issues.nodes);
    after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
  } while (after);
  return out;
}

const NAME_TAIL = / - ([^-]+)$/;
const nameOf = title => (NAME_TAIL.exec(title || '') || [])[1]?.trim() || null;
const withoutName = title => String(title || '').replace(NAME_TAIL, '').trim();
const statusOf = type => (type === 'started' ? 'in_progress' : type === 'completed' ? 'done'
  : type === 'canceled' || type === 'duplicate' ? null : 'untasked');
const FILE_LINK = /\[([^\]]+)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;
const NOTION_LINK = /(https:\/\/(?:app\.|www\.)?notion\.(?:so|com)\/[^\s)>\]]+)/;
const ICONS = /equipment.*evo.*icon/i;
const ICON_SUBTASKS = ['Equipment', 'Evo Item'];

async function importOnce(prisma, fetchAll = allIssues) {
  const B = require('./board');
  await B.ensureSchema(prisma);
  if (await B.getMeta('linearImport', prisma)) return null;
  const [{ n }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BoardCard"`);
  if (n) { await B.setMeta('linearImport', { at: new Date(), skipped: 'the board already had cards' }, prisma); return null; }
  if (fetchAll === allIssues && !process.env.LINEAR_API_KEY) return null;

  const issues = await fetchAll();
  const { list, byName } = await B.roster(prisma);
  // Names typed for devs in Discord's "Give Linear Task" (kept by the backend), as they appear on titles.
  const saved = await prisma.$queryRawUnsafe(`SELECT "discordId", name FROM "LinearDevName"`).catch(() => []);
  for (const s of saved) { const d = list.find(x => x.discordUserId === s.discordId); if (d) byName.set(s.name.toLowerCase(), d); }

  const kids = new Map();
  for (const i of issues) if (i.parent) kids.set(i.parent.id, [...(kids.get(i.parent.id) || []), i]);
  const root = issues.find(i => !i.parent && /^units?$/i.test(i.title.trim()));
  const units = (root ? kids.get(root.id) || [] : issues.filter(i => !i.parent && (kids.get(i.id) || []).length)).filter(u => statusOf(u.state.type));

  // The update for each project.
  const updates = new Map();
  for (const name of [...new Set(units.map(u => u.project?.name).filter(Boolean))]) {
    const [have] = await prisma.$queryRawUnsafe(`SELECT id FROM "BoardUpdate" WHERE lower(name) = lower($1)`, name);
    if (have) { updates.set(name, have.id); continue; }
    const id = newId();
    await prisma.$executeRawUnsafe(`INSERT INTO "BoardUpdate" (id, name) VALUES ($1, $2)`, id, name);
    updates.set(name, id);
  }

  let next = Math.max(0, ...issues.map(i => Number((/(\d+)$/.exec(i.identifier) || [])[1]) || 0)) + 1;
  const ident = () => `${TEAM_KEY()}-${next++}`;
  const devOf = title => {
    const name = nameOf(title);
    const dev = name ? byName.get(name.toLowerCase()) : null;
    return { devId: dev?.id || null, devName: dev?.name || name || null };
  };
  const date = d => (d ? new Date(d) : null);

  let taskCount = 0;
  const addTask = async (i, cardId, parentId, nameOverride, statusOverride) => {
    const status = statusOverride?.status || statusOf(i.state.type);
    const dev = statusOverride ? { devId: statusOverride.devId, devName: statusOverride.devName } : devOf(i.title);
    const id = statusOverride ? newId() : i.id;
    await prisma.$executeRawUnsafe(`INSERT INTO "BoardTask" (id, identifier, "cardId", "parentId", name, status, "devId", "devName", "startedAt", "completedAt", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
    id, statusOverride ? ident() : i.identifier, cardId, parentId, nameOverride || withoutName(i.title), status,
    status === 'untasked' ? null : dev.devId, status === 'untasked' ? null : dev.devName,
    status === 'untasked' ? null : date(i.startedAt) || (status === 'done' ? date(i.completedAt) : null), status === 'done' ? date(i.completedAt) : null,
    date(i.createdAt) || new Date(), date(i.updatedAt) || new Date());
    taskCount++;
    // Files sent to Linear: one delivery per description or comment that had any.
    if (!statusOverride) {
      const texts = [{ body: i.description || '', at: i.createdAt }, ...(i.comments?.nodes || []).map(c => ({ body: c.body, at: c.createdAt }))];
      for (const t of texts) {
        const files = [...t.body.matchAll(FILE_LINK)].map(m => m[1]);
        if (files.length) {
          await prisma.$executeRawUnsafe(`INSERT INTO "BoardDelivery" (id, "taskId", url, files, note, "devName", by, at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
            newId(), id, i.url, JSON.stringify(files), 'Sent to Linear before the board moved to DevTrack', dev.devName, 'Linear', date(t.at) || new Date());
        }
      }
    }
    return id;
  };

  for (const u of units) {
    const labels = (u.labels?.nodes || []).map(l => ({ name: l.name, group: l.parent?.name || '' }));
    await prisma.$executeRawUnsafe(`INSERT INTO "BoardCard" (id, identifier, name, kind, "updateId", rarity, element, "notionUrl", "createdBy", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, 'unit', $4, $5, $6, $7, 'Linear', $8, $9) ON CONFLICT (id) DO NOTHING`,
    u.id, u.identifier, withoutName(u.title), updates.get(u.project?.name) || null,
    labels.find(l => /rarity/i.test(l.group))?.name || null, labels.find(l => /element/i.test(l.group))?.name || null,
    (NOTION_LINK.exec(u.description || '') || [])[1] || null, date(u.createdAt) || new Date(), date(u.updatedAt) || new Date());
    for (const t of (kids.get(u.id) || []).filter(x => statusOf(x.state.type))) {
      const icons = ICONS.test(withoutName(t.title));
      const taskId = await addTask(t, u.id, null, icons ? 'Icons' : null);
      const subs = (kids.get(t.id) || []).filter(x => statusOf(x.state.type));
      for (const s of subs) await addTask(s, u.id, taskId);
      if (icons) {
        // Equipment and Evo Item, as far along as the Icons task was.
        const have = new Set(subs.map(s => withoutName(s.title).toLowerCase()));
        const status = statusOf(t.state.type);
        for (const name of ICON_SUBTASKS.filter(x => !have.has(x.toLowerCase()))) {
          await addTask(t, u.id, taskId, name, { status, ...devOf(t.title) });
        }
      }
    }
  }
  const result = { at: new Date(), cards: units.length, tasks: taskCount, updates: updates.size };
  await B.setMeta('linearImport', result, prisma);
  return result;
}

module.exports = { importOnce, allIssues, nameOf, withoutName };
