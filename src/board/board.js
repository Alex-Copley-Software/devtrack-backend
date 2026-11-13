// board.js
// The Assets board: units and their tasks, straight from Linear, plus what only
// DevTrack keeps: images (a unit's base image, reference images on anything),
// notes, check-ins, activity seen in Discord, and the board's settings.
//
// Linear is the truth for what exists, its status and who's on it:
//   a unit     an issue under the team's "Units" issue (Doumo, Rukia...)
//   a task     an issue under a unit (Mesh, Texture, Aura...), and a Shiny under a task
//   status     Untasked (Backlog, Todo), In progress (In Progress), Done; Canceled and Duplicate are left out
//   dev        the name on the end of the title ("Texture - Ruku"), matched to the Developers page
// It's read every minute (and right after a change from here or from /linear), and a
// change made here goes to Linear the same way /linear makes it.

const crypto = require('crypto');
const { getPrisma, newId } = require('../assets/db');
const linear = require('./linear');
const devs = require('../devs');

const SYNC_MS = 60 * 1000;
const DEFAULTS = {
  checkInDays: 2, // an in-progress task with no activity for this long needs a check-in
  digestHour: 10, // the daily DM, at this hour...
  timezone: 'America/New_York', // ...here
  digestDm: true,
  triageHours: 3, // how often Discord messages are gone through
  readDevPlaces: true, // read every dev's place on the Developers page
  extraChannels: [], // and these channels (or categories, forums)
};

class BoardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ready = new WeakSet();
async function ensureSchema(prisma = getPrisma()) {
  if (ready.has(prisma)) return;
  const tables = [
    `CREATE TABLE IF NOT EXISTS "BoardImage" ("id" TEXT PRIMARY KEY, "issueId" TEXT, "kind" TEXT NOT NULL, "mime" TEXT NOT NULL,
      "data" BYTEA NOT NULL, "width" INTEGER, "height" INTEGER, "caption" TEXT, "sourceUrl" TEXT, "by" TEXT,
      "createdAt" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "BoardNote" ("issueId" TEXT PRIMARY KEY, "text" TEXT NOT NULL, "by" TEXT, "updatedAt" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "BoardActivity" ("id" TEXT PRIMARY KEY, "issueId" TEXT NOT NULL, "kind" TEXT NOT NULL, "text" TEXT,
      "url" TEXT, "by" TEXT, "at" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "BoardEvent" ("id" TEXT PRIMARY KEY, "issueId" TEXT NOT NULL, "from" TEXT, "to" TEXT, "dev" TEXT,
      "by" TEXT, "at" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "BoardSetting" ("key" TEXT PRIMARY KEY, "value" JSONB NOT NULL, "updatedAt" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "BoardMessage" ("id" TEXT PRIMARY KEY, "channelId" TEXT, "threadId" TEXT, "place" TEXT, "authorId" TEXT,
      "authorName" TEXT, "content" TEXT, "attachments" JSONB NOT NULL DEFAULT '[]'::jsonb, "url" TEXT, "postedAt" TIMESTAMP NOT NULL,
      "triagedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "BoardSuggestion" ("id" TEXT PRIMARY KEY, "issueId" TEXT, "action" TEXT NOT NULL, "dev" TEXT,
      "summary" TEXT NOT NULL, "confidence" TEXT, "messageIds" JSONB NOT NULL DEFAULT '[]'::jsonb, "status" TEXT NOT NULL DEFAULT 'open',
      "decidedBy" TEXT, "decidedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE INDEX IF NOT EXISTS "BoardImage_issue" ON "BoardImage" ("issueId")`,
    `CREATE INDEX IF NOT EXISTS "BoardActivity_issue" ON "BoardActivity" ("issueId", "at")`,
    `CREATE INDEX IF NOT EXISTS "BoardMessage_triaged" ON "BoardMessage" ("triagedAt")`,
  ];
  for (const sql of tables) await prisma.$executeRawUnsafe(sql);
  ready.add(prisma);
}

const json = v => (typeof v === 'string' ? JSON.parse(v) : v);

// ── settings ──

async function settings(prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT value FROM "BoardSetting" WHERE key = 'settings'`);
  return { ...DEFAULTS, ...(row ? json(row.value) : {}) };
}

async function setSettings(body = {}, prisma = getPrisma()) {
  const cur = await settings(prisma);
  const next = { ...cur };
  const int = (k, lo, hi) => {
    if (!(k in body)) return;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new BoardError(400, `${k} must be a whole number from ${lo} to ${hi}`);
    next[k] = n;
  };
  int('checkInDays', 1, 30);
  int('digestHour', 0, 23);
  int('triageHours', 1, 24);
  if ('timezone' in body) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }); } catch { throw new BoardError(400, 'Unknown time zone'); }
    next.timezone = body.timezone;
  }
  for (const k of ['digestDm', 'readDevPlaces']) if (k in body) next[k] = body[k] === true;
  if ('extraChannels' in body) {
    if (!Array.isArray(body.extraChannels) || body.extraChannels.some(id => !/^\d{15,22}$/.test(String(id)))) {
      throw new BoardError(400, 'extraChannels must be a list of Discord channel IDs');
    }
    next.extraChannels = [...new Set(body.extraChannels.map(String))].slice(0, 200);
  }
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardSetting" (key, value, "updatedAt") VALUES ('settings', $1::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`, JSON.stringify(next));
  return next;
}

async function setMeta(key, value, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardSetting" (key, value, "updatedAt") VALUES ($1, $2::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now()`, key, JSON.stringify(value));
}
async function getMeta(key, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT value FROM "BoardSetting" WHERE key = $1`, key);
  return row ? json(row.value) : null;
}

// ── the Linear snapshot ──

const snap = { issues: [], at: null, error: null, running: null };

// The status a Linear state stands for here (null: left off the board).
const statusOf = type => (type === 'started' ? 'in_progress' : type === 'completed' ? 'done'
  : type === 'canceled' || type === 'duplicate' ? null : 'untasked');

async function sync(prisma = getPrisma(), fetchAll = linear.allIssues) {
  if (snap.running) return snap.running;
  snap.running = (async () => {
    try {
      const issues = await fetchAll();
      await recordChanges(snap.issues, issues, prisma);
      snap.issues = issues;
      snap.at = new Date();
      snap.error = null;
    } catch (err) {
      snap.error = err.message;
      console.error('[Board] Linear sync failed:', err.message);
    } finally {
      snap.running = null;
    }
  })();
  return snap.running;
}

// Status changes between two reads go into the history (the first read only sets the baseline).
async function recordChanges(before, after, prisma) {
  if (!before.length) return;
  const old = new Map(before.map(i => [i.id, i]));
  for (const i of after) {
    const was = old.get(i.id);
    if (!was) continue;
    const from = statusOf(was.state.type), to = statusOf(i.state.type);
    if (from !== to || linear.nameOf(was.title) !== linear.nameOf(i.title)) {
      await prisma.$executeRawUnsafe(`INSERT INTO "BoardEvent" (id, "issueId", "from", "to", dev) VALUES ($1, $2, $3, $4, $5)`,
        newId(), i.id, from, to, linear.nameOf(i.title)).catch(() => {});
    }
  }
}

let timer = null;
function start() {
  if (timer || !linear.enabled()) return;
  ensureSchema().then(() => sync()).catch(err => console.error('[Board]', err.message));
  timer = setInterval(() => sync().catch(() => {}), SYNC_MS);
  console.log('[Board] Reading Linear every minute for the Assets board');
}

// ── images ──

const SIGN = id => crypto.createHmac('sha256', process.env.JWT_SECRET || 'devtrack').update(`board-image:${id}`).digest('base64url').slice(0, 22);
const imageUrl = id => `/api/board/img/${id}?s=${SIGN(id)}`;
const MIMES = { ffd8ff: 'image/jpeg', '89504e': 'image/png', 524946: 'image/webp', 474946: 'image/gif' };
const MAX_IMAGE = 8 * 1024 * 1024;

function sniff(buf) {
  const mime = MIMES[buf.subarray(0, 3).toString('hex')];
  if (!mime || (mime === 'image/webp' && buf.subarray(8, 12).toString('latin1') !== 'WEBP')) return null;
  return mime;
}

// kind: 'base' (a unit's card image; one per unit, a new one replaces it), 'ref' (a reference image),
// 'msg' (an image from a Discord message, kept for the updates list until it's used or dropped)
async function addImage({ issueId, kind = 'ref', data, width, height, caption, sourceUrl, by }, prisma = getPrisma()) {
  await ensureSchema(prisma);
  if (!['base', 'ref', 'msg'].includes(kind)) throw new BoardError(400, 'kind must be base, ref or msg');
  if (!Buffer.isBuffer(data) || !data.length) throw new BoardError(400, 'No image');
  if (data.length > MAX_IMAGE) throw new BoardError(413, 'That image is over 8 MB');
  const mime = sniff(data);
  if (!mime) throw new BoardError(400, 'That is not a JPEG, PNG, WebP or GIF');
  if (kind !== 'msg' && !issueId) throw new BoardError(400, 'Which unit or task is it for?');
  if (kind === 'base') await prisma.$executeRawUnsafe(`DELETE FROM "BoardImage" WHERE "issueId" = $1 AND kind = 'base'`, issueId);
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardImage" (id, "issueId", kind, mime, data, width, height, caption, "sourceUrl", by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, id, issueId || null, kind, mime, data,
  Number.isFinite(width) ? Math.round(width) : null, Number.isFinite(height) ? Math.round(height) : null,
  caption ? String(caption).slice(0, 200) : null, sourceUrl || null, by || null);
  return { id, url: imageUrl(id), kind, issueId: issueId || null };
}

// An image from a Discord message, used as a reference (or the base image) on a unit or task.
async function useImage(id, issueId, kind = 'ref', by, prisma = getPrisma()) {
  await ensureSchema(prisma);
  if (!['base', 'ref'].includes(kind)) throw new BoardError(400, 'kind must be base or ref');
  const [row] = await prisma.$queryRawUnsafe(`SELECT data, width, height, caption, "sourceUrl" FROM "BoardImage" WHERE id = $1`, id);
  if (!row) throw new BoardError(404, 'No such image');
  return addImage({ issueId, kind, data: Buffer.from(row.data), width: row.width, height: row.height, caption: row.caption, sourceUrl: row.sourceUrl, by }, prisma);
}

async function image(id, sig, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const a = Buffer.from(String(sig || '')), b = Buffer.from(SIGN(id));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new BoardError(403, 'Bad image link');
  const [row] = await prisma.$queryRawUnsafe(`SELECT mime, data FROM "BoardImage" WHERE id = $1`, id);
  if (!row) throw new BoardError(404, 'No such image');
  return { mime: row.mime, data: Buffer.from(row.data) };
}

async function removeImage(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM "BoardImage" WHERE id = $1`, id);
}

// ── notes, check-ins, activity ──

async function setNotes(issueId, text, by, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const t = String(text ?? '').slice(0, 20000);
  if (!t.trim()) { await prisma.$executeRawUnsafe(`DELETE FROM "BoardNote" WHERE "issueId" = $1`, issueId); return null; }
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardNote" ("issueId", text, by, "updatedAt") VALUES ($1, $2, $3, now())
    ON CONFLICT ("issueId") DO UPDATE SET text = EXCLUDED.text, by = EXCLUDED.by, "updatedAt" = now()`, issueId, t, by || null);
  return t;
}

// kind: 'checkin' (you looked in on it), 'discord' (a message about it), 'ping' (the dev was asked how it's going)
async function addActivity(issueId, kind, { text, url, by, at } = {}, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardActivity" (id, "issueId", kind, text, url, by, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    newId(), issueId, kind, text ? String(text).slice(0, 500) : null, url || null, by || null, at ? new Date(at) : new Date());
}

// ── the board ──

const FILE_LINK = /\[([^\]]+)\]\((https:\/\/uploads\.linear\.app\/[^)\s]+)\)/g;
const NOTION_LINK = /(https:\/\/(?:app\.|www\.)?notion\.(?:so|com)\/[^\s)>\]]+)/;

async function roster(prisma) {
  const list = await devs.list(prisma);
  const saved = await prisma.$queryRawUnsafe(`SELECT "discordId", name FROM "LinearDevName"`).catch(() => []);
  const byName = new Map();
  for (const d of list) {
    const dev = { id: d.id, name: d.name, discordUserId: d.discordUserId || null, channelId: d.channelId || null };
    byName.set(d.name.toLowerCase(), dev);
    for (const s of saved) if (s.discordId === d.discordUserId) byName.set(s.name.toLowerCase(), dev);
  }
  return { list: list.map(d => ({ id: d.id, name: d.name, discordUserId: d.discordUserId || null, channelId: d.channelId || null })), byName };
}

// Days, to one decimal, since a date.
const daysSince = (d, now) => (d ? Math.max(0, (now - new Date(d)) / 86400000) : null);

// Everything the page shows, built from the snapshot and the board's own tables.
async function board(prisma = getPrisma(), now = new Date()) {
  await ensureSchema(prisma);
  if (!snap.at && !snap.running && linear.enabled()) await sync(prisma);
  if (snap.running) await snap.running;
  const set = await settings(prisma);
  const { list: devList, byName } = await roster(prisma);
  const images = await prisma.$queryRawUnsafe(`SELECT id, "issueId", kind, caption, width, height, "createdAt" FROM "BoardImage" WHERE kind <> 'msg' ORDER BY "createdAt"`);
  const notes = new Map((await prisma.$queryRawUnsafe(`SELECT "issueId", text, by, "updatedAt" FROM "BoardNote"`)).map(n => [n.issueId, n]));
  const last = new Map((await prisma.$queryRawUnsafe(`SELECT DISTINCT ON ("issueId", kind) "issueId", kind, text, url, by, at FROM "BoardActivity"
    ORDER BY "issueId", kind, at DESC`)).map(a => [`${a.issueId}:${a.kind}`, a]));
  const imgsOf = new Map();
  for (const im of images) imgsOf.set(im.issueId, [...(imgsOf.get(im.issueId) || []), { id: im.id, url: imageUrl(im.id), kind: im.kind, caption: im.caption, width: im.width, height: im.height }]);

  const issues = snap.issues;
  const kids = new Map();
  for (const i of issues) if (i.parent) kids.set(i.parent.id, [...(kids.get(i.parent.id) || []), i]);
  const root = issues.find(i => !i.parent && /^units?$/i.test(i.title.trim()));
  const unitIssues = root ? (kids.get(root.id) || []) : issues.filter(i => !i.parent && (kids.get(i.id) || []).length);

  const item = (i, depth) => {
    const status = statusOf(i.state.type);
    const devName = linear.nameOf(i.title);
    const dev = devName ? byName.get(devName.toLowerCase()) || null : null;
    const checkin = last.get(`${i.id}:checkin`), discord = last.get(`${i.id}:discord`), ping = last.get(`${i.id}:ping`);
    const comments = (i.comments?.nodes || []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const files = [];
    for (const text of [i.description || '', ...comments.map(c => c.body)]) for (const [, name] of text.matchAll(FILE_LINK)) if (!files.includes(name)) files.push(name);
    const activity = [i.updatedAt, i.startedAt, comments.at(-1)?.createdAt, checkin?.at, discord?.at].filter(Boolean).map(d => new Date(d)).sort((a, b) => b - a)[0] || null;
    const quiet = status === 'in_progress' ? daysSince(activity, now) : null;
    const checkedRecently = checkin && daysSince(checkin.at, now) < 1;
    const out = {
      id: i.id, identifier: i.identifier, title: i.title, name: linear.withoutName(i.title), url: i.url, status, state: i.state.name,
      devName, dev, startedAt: i.startedAt, completedAt: i.completedAt, updatedAt: i.updatedAt, lastActivity: activity,
      quietDays: quiet == null ? null : Math.round(quiet * 10) / 10,
      needsCheckin: status === 'in_progress' && quiet != null && quiet >= set.checkInDays && !checkedRecently,
      checkedInAt: checkin?.at || null, pingedAt: ping?.at || null, lastDiscord: discord ? { at: discord.at, text: discord.text, url: discord.url } : null,
      images: imgsOf.get(i.id) || [], notes: notes.get(i.id)?.text || '', files,
      comments: comments.slice(-5).map(c => ({ at: c.createdAt, by: c.user?.name || '', text: c.body.replace(FILE_LINK, '📎 $1').slice(0, 400) })),
    };
    if (depth === 1) out.shinies = (kids.get(i.id) || []).filter(s => statusOf(s.state.type)).map(s => item(s, 2));
    return out;
  };

  const units = unitIssues.filter(u => statusOf(u.state.type) !== null).map(u => {
    const tasks = (kids.get(u.id) || []).filter(t => statusOf(t.state.type)).map(t => item(t, 1))
      .sort((a, b) => a.name.localeCompare(b.name));
    const all = tasks.flatMap(t => [t, ...t.shinies]);
    const labels = (u.labels?.nodes || []).map(l => ({ name: l.name, group: l.parent?.name || null }));
    const unitImages = imgsOf.get(u.id) || [];
    return {
      id: u.id, identifier: u.identifier, title: u.title, name: linear.withoutName(u.title), url: u.url,
      rarity: labels.find(l => /rarity/i.test(l.group || ''))?.name || null,
      element: labels.find(l => /element/i.test(l.group || ''))?.name || null,
      labels: labels.map(l => l.name), project: u.project?.name || null,
      notionUrl: (NOTION_LINK.exec(u.description || '') || [])[1] || null,
      baseImage: unitImages.filter(im => im.kind === 'base').at(-1) || null,
      images: unitImages.filter(im => im.kind === 'ref'), notes: notes.get(u.id)?.text || '',
      tasks,
      counts: {
        untasked: all.filter(x => x.status === 'untasked').length, in_progress: all.filter(x => x.status === 'in_progress').length,
        done: all.filter(x => x.status === 'done').length, total: all.length, checkin: all.filter(x => x.needsCheckin).length,
      },
    };
  });
  const everything = units.flatMap(u => u.tasks.flatMap(t => [t, ...t.shinies]));
  const [inbox] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BoardSuggestion" WHERE status = 'open'`);
  return {
    syncedAt: snap.at, error: snap.error, linear: linear.enabled(), root: root ? { identifier: root.identifier, url: root.url } : null,
    units, devs: devList, settings: set,
    counts: {
      untasked: everything.filter(x => x.status === 'untasked').length, in_progress: everything.filter(x => x.status === 'in_progress').length,
      done: everything.filter(x => x.status === 'done').length, checkin: everything.filter(x => x.needsCheckin).length,
    },
    inbox: { open: inbox.n, triage: await getMeta('triage', prisma) },
  };
}

// The Linear issue for an id or identifier, from the snapshot.
function issue(ref) {
  const i = snap.issues.find(x => x.id === ref || x.identifier === ref);
  if (!i) throw new BoardError(404, `No issue ${ref} on the board`);
  return i;
}

// Untasked / In progress (with a dev from the Developers page) / Done, made in Linear.
async function setStatus(ref, status, devId, by, prisma = getPrisma(), setInLinear = linear.setStatus) {
  if (!['untasked', 'in_progress', 'done'].includes(status)) throw new BoardError(400, 'status must be untasked, in_progress or done');
  const i = issue(ref);
  let devName = null;
  if (status === 'in_progress') {
    const { list } = await roster(prisma);
    const dev = list.find(d => d.id === devId);
    if (!dev) throw new BoardError(400, 'Pick a developer from the Developers page');
    devName = dev.name;
  }
  const updated = await setInLinear(i, status, devName);
  const from = statusOf(i.state.type);
  Object.assign(i, updated);
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardEvent" (id, "issueId", "from", "to", dev, by) VALUES ($1, $2, $3, $4, $5, $6)`,
    newId(), i.id, from, status, devName, by || null);
  sync(prisma).catch(() => {});
  return i;
}

async function history(ref, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const i = issue(ref);
  const events = await prisma.$queryRawUnsafe(`SELECT "from", "to", dev, by, at FROM "BoardEvent" WHERE "issueId" = $1 ORDER BY at DESC LIMIT 30`, i.id);
  const acts = await prisma.$queryRawUnsafe(`SELECT kind, text, url, by, at FROM "BoardActivity" WHERE "issueId" = $1 ORDER BY at DESC LIMIT 30`, i.id);
  return { events, activity: acts };
}

module.exports = {
  ensureSchema, settings, setSettings, getMeta, setMeta, start, sync, board, issue, setStatus, history, statusOf,
  addImage, useImage, image, removeImage, imageUrl, setNotes, addActivity, roster, snap, BoardError, DEFAULTS,
};
