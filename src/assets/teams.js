// teams.js
// A team is a named group of disciplines with its own Discord category:
//
//   Modelers   Unit Mesh, Unit Texture
//   Artists    Art
//   Animators  Animation, Rigging
//   VFX        VFX, VFX Scripting
//
// Nothing is stored per dev or per task: a dev is on a team when one of
// their disciplines is the team's, and a task belongs to the team its
// discipline belongs to. So the roster and the templates stay the one place
// that says who does what.
//
// The Discord category does the wiring. The agent reads everything in it,
// and each dev's own forum inside it is matched to the roster by name, which
// is what gives that forum its status dot, its Payments post and `--` replies.

const { newId } = require('./db');
const q = require('./queries');
const service = require('./service');

const { AssetError } = service;

const DEFAULT_TEAMS = [
  { name: 'Modelers', disciplines: ['Unit Mesh', 'Unit Texture'] },
  { name: 'Artists', disciplines: ['Art'] },
  { name: 'Animators', disciplines: ['Animation', 'Rigging'] },
  { name: 'VFX', disciplines: ['VFX', 'VFX Scripting'] },
];

const setting = async (prisma, key) => (await prisma.$queryRawUnsafe(`SELECT "value" FROM "AssetSetting" WHERE "key" = $1`, key))[0]?.value;
const saveSetting = (prisma, key, value) => prisma.$executeRawUnsafe(`
  INSERT INTO "AssetSetting" ("key", "value") VALUES ($1, $2::jsonb)
  ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP`, key, JSON.stringify(value));

// The four starting teams, once. Deleting them all later does not bring them back.
async function seed(prisma) {
  if (await setting(prisma, 'teamsSeeded')) return;
  const known = new Set(await q.listDisciplines(prisma));
  for (const [i, t] of DEFAULT_TEAMS.entries()) {
    const id = newId();
    const made = await prisma.$executeRawUnsafe(
      `INSERT INTO "AssetTeam" ("id", "name", "sortOrder") VALUES ($1, $2, $3) ON CONFLICT ("name") DO NOTHING`, id, t.name, i);
    if (!made) continue;
    for (const d of t.disciplines.filter(d => known.has(d))) {
      await prisma.$executeRawUnsafe(`INSERT INTO "AssetTeamDiscipline" ("teamId", "discipline") VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, d);
    }
  }
  await saveSetting(prisma, 'teamsSeeded', true);
}

async function listTeams(prisma) {
  await seed(prisma);
  return prisma.$queryRawUnsafe(`
    SELECT t.id, t.name, t."discordCategoryId", t."sortOrder",
      COALESCE((SELECT array_agg(d.discipline ORDER BY d.discipline) FROM "AssetTeamDiscipline" d WHERE d."teamId" = t.id), ARRAY[]::text[]) AS disciplines
    FROM "AssetTeam" t ORDER BY t."sortOrder", t.name`);
}

// A category id as pasted: the bare id, or a Discord link ending in it.
function categoryId(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const m = /(\d{15,22})\/?$/.exec(v);
  if (!m) throw new AssetError(400, 'The Discord category must be its ID (right-click the category, Copy Category ID).');
  return m[1];
}

async function saveTeam(prisma, id, data = {}) {
  const teams = await listTeams(prisma);
  const existing = id ? teams.find(t => t.id === id) : null;
  if (id && !existing) throw new AssetError(404, 'Team not found');
  const name = data.name !== undefined ? String(data.name || '').trim().slice(0, 60) : existing?.name;
  if (!name) throw new AssetError(400, 'A team needs a name');
  if (teams.some(t => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new AssetError(409, `There is already a team called ${name}`);
  const category = data.discordCategoryId !== undefined ? categoryId(data.discordCategoryId) : existing?.discordCategoryId || null;
  if (category && teams.some(t => t.id !== id && t.discordCategoryId === category)) throw new AssetError(409, 'Another team already uses that Discord category');
  let disciplines = existing?.disciplines || [];
  if (data.disciplines !== undefined) {
    const known = new Set(await q.listDisciplines(prisma));
    disciplines = [...new Set((Array.isArray(data.disciplines) ? data.disciplines : []).map(String))];
    const unknown = disciplines.filter(d => !known.has(d));
    if (unknown.length) throw new AssetError(400, `Not a discipline: ${unknown.join(', ')}`);
    // A discipline on two teams would put the same task and the same dev in both.
    const taken = teams.filter(t => t.id !== id).flatMap(t => t.disciplines.filter(d => disciplines.includes(d)).map(d => `${d} (${t.name})`));
    if (taken.length) throw new AssetError(409, `Already on another team: ${taken.join(', ')}`);
  }
  const teamId = id || newId();
  if (existing) {
    await prisma.$executeRawUnsafe(`UPDATE "AssetTeam" SET "name" = $2, "discordCategoryId" = $3 WHERE id = $1`, teamId, name, category);
  } else {
    await prisma.$executeRawUnsafe(`INSERT INTO "AssetTeam" ("id", "name", "discordCategoryId", "sortOrder") VALUES ($1, $2, $3, $4)`, teamId, name, category, teams.length);
  }
  if (data.disciplines !== undefined) {
    await prisma.$executeRawUnsafe(`DELETE FROM "AssetTeamDiscipline" WHERE "teamId" = $1`, teamId);
    for (const d of disciplines) await prisma.$executeRawUnsafe(`INSERT INTO "AssetTeamDiscipline" ("teamId", "discipline") VALUES ($1, $2)`, teamId, d);
  }
  return (await listTeams(prisma)).find(t => t.id === teamId);
}

async function deleteTeam(prisma, id) {
  const gone = await prisma.$queryRawUnsafe(`DELETE FROM "AssetTeam" WHERE id = $1 RETURNING name`, id);
  if (!gone.length) throw new AssetError(404, 'Team not found');
  return { removed: gone[0].name };
}

const teamOfDiscipline = (teams, discipline) => teams.find(t => t.disciplines.includes(discipline)) || null;
const teamsOfDev = (teams, dev) => teams.filter(t => t.disciplines.some(d => (dev.disciplines || []).includes(d)));

// ── Discord: a team's category, and the dev forums inside it ────────────────

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// How far apart two short names are (for "drnken" and "Drunken").
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

// Which dev a forum called `name` belongs to, among devs who have no channel
// yet. An exact name anywhere on the roster; failing that a near miss, but
// only inside the team and only when exactly one dev is that close.
function matchDev(name, free, team) {
  const n = norm(name);
  if (n.length < 2) return null;
  const exact = free.filter(d => norm(d.name) === n);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const inTeam = free.filter(d => team.disciplines.some(x => (d.disciplines || []).includes(x)));
  const near = inTeam.filter(d => {
    const dn = norm(d.name);
    return dn.length >= 4 && n.length >= 4 && (distance(n, dn) <= (Math.max(n.length, dn.length) >= 7 ? 2 : 1) || dn.startsWith(n) || n.startsWith(dn));
  });
  return near.length === 1 ? near[0] : null;
}

// The bot reports the channels sitting in team categories. Each forum that
// is not yet somebody's is given to the dev it is named after; the rest are
// kept as a list for a person to link or wave off.
// channels: [{ id, name, categoryId }]
async function syncChannels(prisma, channels) {
  const teams = (await listTeams(prisma)).filter(t => t.discordCategoryId);
  const byCategory = new Map(teams.map(t => [t.discordCategoryId, t]));
  const ignored = new Set((await setting(prisma, 'teamIgnoredChannels')) || []);
  let devs = await q.listDevs(prisma);
  const linked = [];
  const unlinked = [];
  for (const ch of (Array.isArray(channels) ? channels : [])) {
    const team = byCategory.get(String(ch.categoryId || ''));
    const id = String(ch.id || '');
    if (!team || !id) continue;
    if (devs.some(d => d.discordThreadId === id)) continue;
    if (ignored.has(id)) continue;
    const dev = matchDev(ch.name, devs.filter(d => !d.discordThreadId && d.status !== 'Inactive'), team);
    if (dev) {
      await service.updateDev({ prisma, source: 'human', actor: { userId: null, name: `Teams (${team.name} category)` } }, dev.id, { discordThreadId: id });
      linked.push({ channelId: id, channelName: ch.name, dev: dev.name, team: team.name });
      devs = await q.listDevs(prisma);
    } else {
      unlinked.push({ channelId: id, channelName: String(ch.name || '').slice(0, 100), teamId: team.id, team: team.name });
    }
  }
  await saveSetting(prisma, 'teamUnlinkedChannels', unlinked);
  return { linked, unlinked };
}

const unlinkedChannels = async prisma => (await setting(prisma, 'teamUnlinkedChannels')) || [];

// A person settles one unmatched forum: it is this dev's, or it is nobody's (an admin forum, say).
async function resolveChannel(prisma, channelId, { devId, ignore }, ctx) {
  const id = String(channelId);
  const list = await unlinkedChannels(prisma);
  if (ignore) {
    const ignored = new Set((await setting(prisma, 'teamIgnoredChannels')) || []);
    ignored.add(id);
    await saveSetting(prisma, 'teamIgnoredChannels', [...ignored]);
  } else {
    if (!devId) throw new AssetError(400, 'Choose a dev, or ignore the channel');
    await service.updateDev(ctx, devId, { discordThreadId: id });
  }
  await saveSetting(prisma, 'teamUnlinkedChannels', list.filter(c => c.channelId !== id));
  return { unlinked: await unlinkedChannels(prisma) };
}

module.exports = {
  DEFAULT_TEAMS, listTeams, saveTeam, deleteTeam, teamOfDiscipline, teamsOfDev,
  matchDev, syncChannels, unlinkedChannels, resolveChannel,
};
