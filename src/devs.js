// devs.js
// The Developers tab on the Assets page: who the devs are, where each one's 🟢/🟡
// dot goes (a Discord category, forum, channel or forum post), and who is away.
//
//   "LinearDev"      one row per dev: their name, their Discord user (for Send to
//                    Assets and Give task), the place for the dot, and Away. (The
//                    tables kept their old names from when the board was in Linear.)
//   "LinearDevMeta"  what the bot last reported: the server's channels (for the
//                    picker) and each dev's dot
//
// The first time, the list is filled from the old asset roster ("AssetDev"),
// keeping each dev's status post as their place.

const { getPrisma, newId } = require('./assets/db');

class DevError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ready = new WeakSet();
async function ensureSchema(prisma = getPrisma()) {
  if (ready.has(prisma)) return;
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LinearDev" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "discordUserId" TEXT,
    "channelId" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
  )`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "LinearDev" ADD COLUMN IF NOT EXISTS "away" BOOLEAN NOT NULL DEFAULT false`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LinearDevMeta" (
    "key" TEXT PRIMARY KEY,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
  )`);
  await seedFromAssetRoster(prisma);
  ready.add(prisma);
}

async function seedFromAssetRoster(prisma) {
  const [{ seeded } = {}] = await prisma.$queryRawUnsafe(`SELECT EXISTS (SELECT 1 FROM "LinearDevMeta" WHERE key = 'seeded') AS seeded`);
  if (seeded) return;
  const [{ has } = {}] = await prisma.$queryRawUnsafe(`SELECT to_regclass('"AssetDev"') IS NOT NULL AS has`);
  if (has) {
    const old = await prisma.$queryRawUnsafe(`SELECT name, "discordUserId", "discordThreadId" FROM "AssetDev" WHERE status = 'Active' ORDER BY name`);
    for (const d of old) {
      await prisma.$executeRawUnsafe(`INSERT INTO "LinearDev" (id, name, "discordUserId", "channelId") VALUES ($1, $2, $3, $4)`,
        newId(), d.name, d.discordUserId || null, d.discordThreadId || null);
    }
  }
  await prisma.$executeRawUnsafe(`INSERT INTO "LinearDevMeta" (key, value) VALUES ('seeded', $1::jsonb) ON CONFLICT (key) DO NOTHING`,
    JSON.stringify({ at: new Date().toISOString() }));
}

const snowflake = v => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  // A pasted channel link: https://discord.com/channels/<server>/<channel>[/<message>] takes the channel.
  const link = s.match(/discord(?:app)?\.com\/channels\/\d+\/(\d{15,22})/);
  const id = link ? link[1] : s;
  if (!/^\d{15,22}$/.test(id)) throw new DevError(400, `"${s}" is not a Discord ID or channel link`);
  return id;
};

function clean(body, partial) {
  const out = {};
  if (!partial || 'name' in body) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new DevError(400, 'A name is required');
    if (name.length > 60) throw new DevError(400, 'That name is too long');
    out.name = name;
  }
  if (!partial || 'discordUserId' in body) out.discordUserId = snowflake(body.discordUserId);
  if (!partial || 'channelId' in body) out.channelId = snowflake(body.channelId);
  if ('away' in body) out.away = body.away === true;
  return out;
}

async function meta(prisma, key) {
  const [row] = await prisma.$queryRawUnsafe(`SELECT value, "updatedAt" FROM "LinearDevMeta" WHERE key = $1`, key);
  return row ? { value: typeof row.value === 'string' ? JSON.parse(row.value) : row.value, at: row.updatedAt } : null;
}
async function setMeta(prisma, key, value) {
  await prisma.$executeRawUnsafe(`INSERT INTO "LinearDevMeta" (key, value, "updatedAt") VALUES ($1, $2::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`, key, JSON.stringify(value));
}

async function list(prisma = getPrisma()) {
  await ensureSchema(prisma);
  return prisma.$queryRawUnsafe(`SELECT id, name, "discordUserId", "channelId", "away", "createdAt", "updatedAt" FROM "LinearDev" ORDER BY lower(name)`);
}

async function overview(prisma = getPrisma()) {
  const devs = await list(prisma);
  const channels = await meta(prisma, 'channels');
  const status = await meta(prisma, 'status');
  return {
    devs,
    channels: channels?.value || [],
    channelsAt: channels?.at || null,
    status: status?.value || {},
    syncedAt: status?.at || null,
  };
}

async function sameName(prisma, name, exceptId) {
  const [row] = await prisma.$queryRawUnsafe(`SELECT id FROM "LinearDev" WHERE lower(name) = lower($1) AND id <> $2`, name, exceptId || '');
  if (row) throw new DevError(409, `There is already a dev called ${name}`);
}

async function create(body, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const d = clean(body || {}, false);
  await sameName(prisma, d.name);
  if (d.discordUserId) {
    const [taken] = await prisma.$queryRawUnsafe(`SELECT name FROM "LinearDev" WHERE "discordUserId" = $1`, d.discordUserId);
    if (taken) throw new DevError(409, `That Discord account is already ${taken.name}'s`);
  }
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "LinearDev" (id, name, "discordUserId", "channelId", "away") VALUES ($1, $2, $3, $4, $5)`, id, d.name, d.discordUserId, d.channelId, d.away === true);
  return (await list(prisma)).find(x => x.id === id);
}

// The dev with this Discord account; someone given a task from Discord who isn't on the
// list yet is added under their server name.
async function forDiscord(discordUserId, name, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const id = snowflake(discordUserId);
  if (!id) throw new DevError(400, 'A Discord user is required');
  const [have] = await prisma.$queryRawUnsafe(`SELECT id FROM "LinearDev" WHERE "discordUserId" = $1`, id);
  if (have) return (await list(prisma)).find(x => x.id === have.id);
  let clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || `Dev ${id.slice(-4)}`;
  // Someone already listed under that name but without a Discord account is them.
  const [same] = await prisma.$queryRawUnsafe(`SELECT id, "discordUserId" FROM "LinearDev" WHERE lower(name) = lower($1)`, clean);
  if (same && !same.discordUserId) return update(same.id, { discordUserId: id }, prisma);
  if (same) clean = `${clean} (${id.slice(-4)})`;
  return create({ name: clean, discordUserId: id }, prisma);
}

async function update(id, body, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const d = clean(body || {}, true);
  const [old] = await prisma.$queryRawUnsafe(`SELECT id FROM "LinearDev" WHERE id = $1`, id);
  if (!old) throw new DevError(404, 'No such dev');
  if (d.name) await sameName(prisma, d.name, id);
  const sets = Object.keys(d).map((k, i) => `"${k}" = $${i + 2}`);
  if (sets.length) await prisma.$executeRawUnsafe(`UPDATE "LinearDev" SET ${sets.join(', ')}, "updatedAt" = now() WHERE id = $1`, id, ...Object.values(d));
  return (await list(prisma)).find(x => x.id === id);
}

async function remove(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM "LinearDev" WHERE id = $1`, id);
}

// From the bot: the server's channels, for the picker.
async function setChannels(channels, prisma = getPrisma()) {
  await ensureSchema(prisma);
  if (!Array.isArray(channels)) throw new DevError(400, 'channels must be a list');
  const keep = channels.slice(0, 2000).map(c => ({
    id: String(c.id), name: String(c.name || '').slice(0, 100), type: String(c.type || ''),
    parentId: c.parentId ? String(c.parentId) : null, parentName: c.parentName ? String(c.parentName).slice(0, 100) : null,
    guildName: c.guildName ? String(c.guildName).slice(0, 100) : null,
  }));
  await setMeta(prisma, 'channels', keep);
}

// From the bot after each sync: { [devId]: { dot, place: {id, name} | null, problem, tasks: [{identifier, label}] } }
async function setStatus(status, prisma = getPrisma()) {
  await ensureSchema(prisma);
  if (!status || typeof status !== 'object') throw new DevError(400, 'status must be an object');
  await setMeta(prisma, 'status', status);
}

module.exports = { ensureSchema, list, overview, create, update, remove, forDiscord, setChannels, setStatus, DevError };
