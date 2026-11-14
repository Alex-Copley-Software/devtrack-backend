// board.js
// The Assets board. DevTrack keeps all of it; Linear is no longer involved
// (everything that was on Linear came across once, see import-linear.js).
//
//   update     a game update ("Winter Update [6.0]") that cards are grouped under, to filter by
//   card       a unit (Doumo, Rukia...) or anything else being made; kind 'unit' for the old ones
//   task       a piece of work on a card (Animations, Mesh, Texture...), each with its own status
//   subtask    a piece of a task, tracked on its own (Icons › Equipment, Texture › Shiny...)
//   status     untasked, in_progress (with the dev doing it), done
//   delivery   a link to a Discord message sent with "Send to Assets": where the files are
//
// Plus what was already DevTrack's: images (a card's base image, reference images on
// anything), notes, check-ins, activity seen in Discord, and the board's settings.
// Everything is keyed by id; imported things keep their Linear id and identifier
// ("ASS-40"), and new ones carry on the same numbering.

const crypto = require('crypto');
const { getPrisma, newId } = require('../assets/db');
const devs = require('../devs');

const DEFAULTS = {
  checkInDays: 2, // an in-progress task with no activity for this long needs a check-in
  quietDays: 3, // a dev with nothing in progress and no Discord message for this long shows as quiet
  digestHour: 10, // the daily DM, at this hour...
  timezone: 'America/New_York', // ...here
  digestDm: true,
  triageHours: 3, // how often Discord messages are gone through
  readDevPlaces: true, // read every dev's place on the Developers tab
  extraChannels: [], // and these channels (or categories, forums)
};

const STATUSES = ['untasked', 'in_progress', 'done'];
const PREFIX = 'ASS';

// A new unit starts with these, in this order; the order is also how every card's tasks are sorted.
const UNIT_TEMPLATE = [
  { name: 'Animations' }, { name: 'Mesh' }, { name: 'Texture' }, { name: 'Aura' },
  { name: 'Icons', subtasks: ['Equipment', 'Evo Item'] }, { name: 'VFX' }, { name: 'Cosmetic' },
];
const ORDER = [/anim/, /mesh|model/, /texture/, /aura/, /icon/, /vfx|effect/, /cosmetic|skin/];
const orderOf = name => { const n = String(name || '').toLowerCase(); const i = ORDER.findIndex(re => re.test(n)); return i < 0 ? ORDER.length : i; };
const RANK = { untasked: 0, in_progress: 1, done: 2 };
// Untasked at the top, in progress in the middle, done at the bottom; within each, the template's order.
const byBoardOrder = (a, b) => RANK[a.status] - RANK[b.status] || orderOf(a.name) - orderOf(b.name)
  || a.name.localeCompare(b.name) || String(a.createdAt).localeCompare(String(b.createdAt));

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
    `CREATE TABLE IF NOT EXISTS "BoardUpdate" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "BoardCard" ("id" TEXT PRIMARY KEY, "identifier" TEXT NOT NULL UNIQUE, "name" TEXT NOT NULL,
      "kind" TEXT NOT NULL DEFAULT 'unit', "updateId" TEXT, "rarity" TEXT, "element" TEXT, "notionUrl" TEXT,
      "archived" BOOLEAN NOT NULL DEFAULT false, "createdBy" TEXT, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "BoardTask" ("id" TEXT PRIMARY KEY, "identifier" TEXT NOT NULL UNIQUE, "cardId" TEXT NOT NULL, "parentId" TEXT,
      "name" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'untasked', "devId" TEXT, "devName" TEXT, "startedAt" TIMESTAMP, "completedAt" TIMESTAMP,
      "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "BoardDelivery" ("id" TEXT PRIMARY KEY, "taskId" TEXT NOT NULL, "url" TEXT NOT NULL,
      "files" JSONB NOT NULL DEFAULT '[]'::jsonb, "note" TEXT, "devName" TEXT, "by" TEXT, "at" TIMESTAMP NOT NULL DEFAULT now())`,
    `CREATE INDEX IF NOT EXISTS "BoardImage_issue" ON "BoardImage" ("issueId")`,
    `CREATE INDEX IF NOT EXISTS "BoardActivity_issue" ON "BoardActivity" ("issueId", "at")`,
    `CREATE INDEX IF NOT EXISTS "BoardMessage_triaged" ON "BoardMessage" ("triagedAt")`,
    `CREATE INDEX IF NOT EXISTS "BoardMessage_author" ON "BoardMessage" ("authorId", "postedAt")`,
    `CREATE INDEX IF NOT EXISTS "BoardTask_card" ON "BoardTask" ("cardId")`,
    `CREATE INDEX IF NOT EXISTS "BoardDelivery_task" ON "BoardDelivery" ("taskId", "at")`,
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
  int('quietDays', 1, 60);
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

// ── starting up: the one-time copy from Linear ──

let importing = null;
function start(prisma = getPrisma()) {
  if (importing) return importing;
  importing = ensureSchema(prisma)
    .then(() => require('./import-linear').importOnce(prisma))
    .then(r => { if (r) console.log(`[Board] Copied from Linear: ${r.cards} cards, ${r.tasks} tasks, ${r.updates} updates`); })
    .catch(err => console.error('[Board] Copying from Linear failed:', err.message));
  return importing;
}

// ── names and numbers ──

const cleanName = (v, what = 'A name') => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new BoardError(400, `${what} is required`);
  if (s.length > 80) throw new BoardError(400, `${what} is too long (80 characters at most)`);
  return s;
};

// The next free number in the ASS-n series, across cards and tasks.
async function nextIdentifier(prisma) {
  const [{ n }] = await prisma.$queryRawUnsafe(`SELECT COALESCE(MAX(num), 0)::int AS n FROM (
    SELECT substring(identifier from '(\\d+)$')::int AS num FROM "BoardCard"
    UNION ALL SELECT substring(identifier from '(\\d+)$')::int FROM "BoardTask") x`);
  return `${PREFIX}-${n + 1}`;
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

// kind: 'base' (a card's image; one per card, a new one replaces it), 'ref' (a reference image),
// 'msg' (an image from a Discord message, kept for the updates list until it's used or dropped)
async function addImage({ issueId, kind = 'ref', data, width, height, caption, sourceUrl, by }, prisma = getPrisma()) {
  await ensureSchema(prisma);
  if (!['base', 'ref', 'msg'].includes(kind)) throw new BoardError(400, 'kind must be base, ref or msg');
  if (!Buffer.isBuffer(data) || !data.length) throw new BoardError(400, 'No image');
  if (data.length > MAX_IMAGE) throw new BoardError(413, 'That image is over 8 MB');
  const mime = sniff(data);
  if (!mime) throw new BoardError(400, 'That is not a JPEG, PNG, WebP or GIF');
  if (kind !== 'msg' && !issueId) throw new BoardError(400, 'Which card or task is it for?');
  if (kind === 'base') await prisma.$executeRawUnsafe(`DELETE FROM "BoardImage" WHERE "issueId" = $1 AND kind = 'base'`, issueId);
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardImage" (id, "issueId", kind, mime, data, width, height, caption, "sourceUrl", by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, id, issueId || null, kind, mime, data,
  Number.isFinite(width) ? Math.round(width) : null, Number.isFinite(height) ? Math.round(height) : null,
  caption ? String(caption).slice(0, 200) : null, sourceUrl || null, by || null);
  return { id, url: imageUrl(id), kind, issueId: issueId || null };
}

// An image from a Discord message, used as a reference (or the base image) on a card or task.
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

// ── developers ──

async function roster(prisma = getPrisma()) {
  const list = (await devs.list(prisma)).map(d => ({
    id: d.id, name: d.name, discordUserId: d.discordUserId || null, channelId: d.channelId || null, away: !!d.away,
  }));
  const byName = new Map(list.map(d => [d.name.toLowerCase(), d]));
  const byId = new Map(list.map(d => [d.id, d]));
  const byDiscord = new Map(list.filter(d => d.discordUserId).map(d => [d.discordUserId, d]));
  return { list, byName, byId, byDiscord };
}

// Days, to one decimal, since a date.
const daysSince = (d, now) => (d ? Math.max(0, (now - new Date(d)) / 86400000) : null);

// ── the board ──

async function rows(prisma) {
  const cards = await prisma.$queryRawUnsafe(`SELECT * FROM "BoardCard" WHERE NOT archived ORDER BY "createdAt", identifier`);
  const tasks = await prisma.$queryRawUnsafe(`SELECT t.* FROM "BoardTask" t JOIN "BoardCard" c ON c.id = t."cardId" WHERE NOT c.archived`);
  const updates = await prisma.$queryRawUnsafe(`SELECT * FROM "BoardUpdate" ORDER BY "createdAt", name`);
  return { cards, tasks, updates };
}

// Everything the page shows.
async function board(prisma = getPrisma(), now = new Date()) {
  await ensureSchema(prisma);
  if (importing) await importing;
  const set = await settings(prisma);
  const { list: devList, byName, byId } = await roster(prisma);
  const { cards: cardRows, tasks: taskRows, updates } = await rows(prisma);
  const images = await prisma.$queryRawUnsafe(`SELECT id, "issueId", kind, caption, width, height, "createdAt" FROM "BoardImage" WHERE kind <> 'msg' ORDER BY "createdAt"`);
  const notes = new Map((await prisma.$queryRawUnsafe(`SELECT "issueId", text, by, "updatedAt" FROM "BoardNote"`)).map(n => [n.issueId, n]));
  const last = new Map((await prisma.$queryRawUnsafe(`SELECT DISTINCT ON ("issueId", kind) "issueId", kind, text, url, by, at FROM "BoardActivity"
    ORDER BY "issueId", kind, at DESC`)).map(a => [`${a.issueId}:${a.kind}`, a]));
  const deliveries = new Map();
  for (const d of await prisma.$queryRawUnsafe(`SELECT * FROM "BoardDelivery" ORDER BY at`)) {
    deliveries.set(d.taskId, [...(deliveries.get(d.taskId) || []), { id: d.id, url: d.url, files: json(d.files), note: d.note, devName: d.devName, by: d.by, at: d.at }]);
  }
  const imgsOf = new Map();
  for (const im of images) imgsOf.set(im.issueId, [...(imgsOf.get(im.issueId) || []), { id: im.id, url: imageUrl(im.id), kind: im.kind, caption: im.caption, width: im.width, height: im.height }]);
  const kids = new Map();
  for (const t of taskRows) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) || []), t]);

  const item = (t, depth) => {
    const dev = (t.devId && byId.get(t.devId)) || (t.devName && byName.get(t.devName.toLowerCase())) || null;
    const checkin = last.get(`${t.id}:checkin`), discord = last.get(`${t.id}:discord`), ping = last.get(`${t.id}:ping`);
    const sent = deliveries.get(t.id) || [];
    const activity = [t.startedAt, sent.at(-1)?.at, checkin?.at, discord?.at].filter(Boolean).map(d => new Date(d)).sort((a, b) => b - a)[0] || null;
    const quiet = t.status === 'in_progress' ? daysSince(activity, now) : null;
    const checkedRecently = checkin && daysSince(checkin.at, now) < 1;
    const out = {
      id: t.id, identifier: t.identifier, name: t.name, status: t.status, parentId: t.parentId || null,
      devId: dev?.id || null, devName: dev?.name || t.devName || null, dev,
      startedAt: t.startedAt, completedAt: t.completedAt, updatedAt: t.updatedAt, createdAt: t.createdAt, lastActivity: activity,
      quietDays: quiet == null ? null : Math.round(quiet * 10) / 10,
      needsCheckin: t.status === 'in_progress' && quiet != null && quiet >= set.checkInDays && !checkedRecently,
      checkedInAt: checkin?.at || null, pingedAt: ping?.at || null, lastDiscord: discord ? { at: discord.at, text: discord.text, url: discord.url } : null,
      images: imgsOf.get(t.id) || [], notes: notes.get(t.id)?.text || '', deliveries: sent,
    };
    if (depth === 1) out.subtasks = (kids.get(t.id) || []).map(s => item(s, 2)).sort(byBoardOrder);
    return out;
  };

  const updateName = new Map(updates.map(u => [u.id, u.name]));
  const cards = cardRows.map(c => {
    const tasks = taskRows.filter(t => t.cardId === c.id && !t.parentId).map(t => item(t, 1)).sort(byBoardOrder);
    const all = tasks.flatMap(t => [t, ...t.subtasks]);
    const cardImages = imgsOf.get(c.id) || [];
    return {
      id: c.id, identifier: c.identifier, name: c.name, kind: c.kind,
      update: c.updateId && updateName.has(c.updateId) ? { id: c.updateId, name: updateName.get(c.updateId) } : null,
      rarity: c.rarity || null, element: c.element || null, notionUrl: c.notionUrl || null, createdAt: c.createdAt,
      baseImage: cardImages.filter(im => im.kind === 'base').at(-1) || null,
      images: cardImages.filter(im => im.kind === 'ref'), notes: notes.get(c.id)?.text || '',
      tasks,
      counts: {
        untasked: all.filter(x => x.status === 'untasked').length, in_progress: all.filter(x => x.status === 'in_progress').length,
        done: all.filter(x => x.status === 'done').length, total: all.length, checkin: all.filter(x => x.needsCheckin).length,
      },
    };
  });
  const everything = cards.flatMap(c => c.tasks.flatMap(t => [t, ...t.subtasks]));

  // The Developers tab: who's on what, and who's gone quiet.
  const seen = new Map((await prisma.$queryRawUnsafe(`SELECT "authorId", MAX("postedAt") AS at FROM "BoardMessage" GROUP BY "authorId"`)).map(r => [r.authorId, r.at]));
  const devsOut = devList.map(d => {
    const mine = cards.flatMap(c => c.tasks.flatMap(t => [t, ...t.subtasks].filter(x => x.devId === d.id).map(x => ({
      id: x.id, identifier: x.identifier, card: c.name, cardId: c.id, task: x === t ? t.name : `${t.name} › ${x.name}`, status: x.status,
      startedAt: x.startedAt, completedAt: x.completedAt, needsCheckin: x.needsCheckin,
    }))));
    const working = mine.filter(x => x.status === 'in_progress');
    const lastSeen = [d.discordUserId && seen.get(d.discordUserId), ...mine.map(x => x.completedAt || x.startedAt)].filter(Boolean)
      .map(x => new Date(x)).sort((a, b) => b - a)[0] || null;
    const quietFor = daysSince(lastSeen, now);
    const state = d.away ? 'away' : working.length ? 'working' : quietFor == null || quietFor >= set.quietDays ? 'quiet' : 'free';
    return {
      ...d, state, lastSeen, quietDays: quietFor == null ? null : Math.floor(quietFor),
      working, doneCount: mine.filter(x => x.status === 'done').length,
      recentDone: mine.filter(x => x.status === 'done' && x.completedAt).sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt)).slice(0, 3),
    };
  });

  const [inbox] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "BoardSuggestion" WHERE status = 'open'`);
  return {
    cards, updates: updates.map(u => ({ id: u.id, name: u.name, cards: cards.filter(c => c.update?.id === u.id).length })),
    devs: devsOut, settings: set, template: UNIT_TEMPLATE,
    counts: {
      untasked: everything.filter(x => x.status === 'untasked').length, in_progress: everything.filter(x => x.status === 'in_progress').length,
      done: everything.filter(x => x.status === 'done').length, checkin: everything.filter(x => x.needsCheckin).length,
    },
    inbox: { open: inbox.n, triage: await getMeta('triage', prisma) },
    imported: await getMeta('linearImport', prisma),
  };
}

// ── looking things up ──

async function findTask(ref, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [t] = await prisma.$queryRawUnsafe(`SELECT t.*, c.name AS "cardName" FROM "BoardTask" t JOIN "BoardCard" c ON c.id = t."cardId"
    WHERE (t.id = $1 OR upper(t.identifier) = upper($1)) AND NOT c.archived`, String(ref || ''));
  if (!t) throw new BoardError(404, `No task ${ref} on the board`);
  return t;
}
async function findCard(ref, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [c] = await prisma.$queryRawUnsafe(`SELECT * FROM "BoardCard" WHERE (id = $1 OR upper(identifier) = upper($1)) AND NOT archived`, String(ref || ''));
  if (!c) throw new BoardError(404, `No card ${ref} on the board`);
  return c;
}
// A card's or a task's id, for what both can have (notes, images, check-ins).
async function idOf(ref, prisma = getPrisma()) {
  try { return (await findTask(ref, prisma)).id; } catch (err) { if (err.status !== 404) throw err; }
  return (await findCard(ref, prisma)).id;
}

// "Doumo › Icons › Equipment", for lists in Discord.
async function labels(prisma = getPrisma()) {
  const { cards, tasks } = await rows(prisma);
  const card = new Map(cards.map(c => [c.id, c]));
  const task = new Map(tasks.map(t => [t.id, t]));
  return tasks.map(t => {
    const parent = t.parentId ? task.get(t.parentId) : null;
    return { ...t, card: card.get(t.cardId), parent, label: [card.get(t.cardId)?.name, parent?.name, t.name].filter(Boolean).join(' › ') };
  });
}

const pick = t => ({ id: t.id, identifier: t.identifier, label: t.label, name: t.name, card: t.card?.name, status: t.status, devName: t.devName });

// For /assets and the right-click menus: an identifier ("ASS-12", or "12"), or words that all
// have to be in the card's, the parent's or the task's name ("doumo icons equipment").
async function search(text, { withDone = false, limit = 25 } = {}, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const q = String(text || '').trim();
  const all = await labels(prisma);
  const ident = /^\d+$/.test(q) ? `${PREFIX}-${q}` : /^[a-z]+-\d+$/i.test(q) ? q.toUpperCase() : null;
  if (ident) return all.filter(t => t.identifier.toUpperCase() === ident).map(pick);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  return all.filter(t => (withDone || t.status !== 'done') && words.every(w => t.label.toLowerCase().includes(w)))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || a.label.localeCompare(b.label)).slice(0, limit).map(pick);
}

// A dev's tasks to send files for: in progress, and done in the last two weeks, each followed by its subtasks.
async function tasksOf(devId, prisma = getPrisma(), now = new Date()) {
  const all = await labels(prisma);
  const recent = t => t.status === 'in_progress' || (t.status === 'done' && t.completedAt && daysSince(t.completedAt, now) <= 14);
  const mine = all.filter(t => t.devId === devId && recent(t)).sort((a, b) => RANK[a.status] - RANK[b.status] || a.label.localeCompare(b.label));
  const out = [];
  for (const t of mine) {
    if (!out.includes(t)) out.push(t);
    for (const s of all.filter(x => x.parentId === t.id && x.status !== 'done')) if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 25).map(pick);
}

// ── changing things ──

async function event(prisma, issueId, from, to, dev, by) {
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardEvent" (id, "issueId", "from", "to", dev, by) VALUES ($1, $2, $3, $4, $5, $6)`,
    newId(), issueId, from, to, dev || null, by || null);
}

// Untasked / In progress (with a dev from the Developers tab) / Done.
async function setStatus(ref, status, devId, by, prisma = getPrisma()) {
  if (!STATUSES.includes(status)) throw new BoardError(400, 'status must be untasked, in_progress or done');
  const t = await findTask(ref, prisma);
  let dev = null;
  if (status === 'in_progress') {
    const { byId } = await roster(prisma);
    dev = byId.get(devId);
    if (!dev) throw new BoardError(400, 'Pick a developer from the Developers tab');
  }
  if (status === 'in_progress') {
    await prisma.$executeRawUnsafe(`UPDATE "BoardTask" SET status = 'in_progress', "devId" = $2, "devName" = $3,
      "startedAt" = CASE WHEN status = 'in_progress' AND "devId" = $2 THEN "startedAt" ELSE now() END, "completedAt" = NULL, "updatedAt" = now() WHERE id = $1`,
    t.id, dev.id, dev.name);
  } else if (status === 'done') {
    await prisma.$executeRawUnsafe(`UPDATE "BoardTask" SET status = 'done', "completedAt" = CASE WHEN status = 'done' THEN "completedAt" ELSE now() END,
      "updatedAt" = now() WHERE id = $1`, t.id);
  } else {
    await prisma.$executeRawUnsafe(`UPDATE "BoardTask" SET status = 'untasked', "devId" = NULL, "devName" = NULL, "startedAt" = NULL,
      "completedAt" = NULL, "updatedAt" = now() WHERE id = $1`, t.id);
  }
  if (t.status !== status || (dev && dev.id !== t.devId)) await event(prisma, t.id, t.status, status, dev?.name || t.devName, by);
  return findTask(t.id, prisma);
}

async function renameTask(ref, name, by, prisma = getPrisma()) {
  const t = await findTask(ref, prisma);
  await prisma.$executeRawUnsafe(`UPDATE "BoardTask" SET name = $2, "updatedAt" = now() WHERE id = $1`, t.id, cleanName(name, 'A task name'));
  return findTask(t.id, prisma);
}

// A task (on a card), or a subtask (under a task).
async function addTask(cardRef, { name, parentId } = {}, by, prisma = getPrisma()) {
  const c = await findCard(cardRef, prisma);
  let parent = null;
  if (parentId) {
    parent = await findTask(parentId, prisma);
    if (parent.cardId !== c.id) throw new BoardError(400, 'That task is on another card');
    if (parent.parentId) throw new BoardError(400, 'A subtask can\'t have subtasks of its own');
  }
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardTask" (id, identifier, "cardId", "parentId", name) VALUES ($1, $2, $3, $4, $5)`,
    id, await nextIdentifier(prisma), c.id, parent?.id || null, cleanName(name, 'A task name'));
  return findTask(id, prisma);
}

async function removeTask(ref, prisma = getPrisma()) {
  const t = await findTask(ref, prisma);
  const ids = [t.id, ...(await prisma.$queryRawUnsafe(`SELECT id FROM "BoardTask" WHERE "parentId" = $1`, t.id)).map(r => r.id)];
  await prisma.$executeRawUnsafe(`DELETE FROM "BoardTask" WHERE id = ANY($1::text[])`, ids);
  await prisma.$executeRawUnsafe(`DELETE FROM "BoardDelivery" WHERE "taskId" = ANY($1::text[])`, ids);
  await prisma.$executeRawUnsafe(`DELETE FROM "BoardImage" WHERE "issueId" = ANY($1::text[])`, ids);
  await prisma.$executeRawUnsafe(`DELETE FROM "BoardNote" WHERE "issueId" = ANY($1::text[])`, ids);
  return { removed: ids.length };
}

const RARITY = v => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, 40));
const URLISH = v => {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (!/^https?:\/\/\S+$/.test(s)) throw new BoardError(400, 'That link must start with http:// or https://');
  return s.slice(0, 500);
};

async function checkUpdate(prisma, updateId) {
  if (!updateId) return null;
  const [u] = await prisma.$queryRawUnsafe(`SELECT id FROM "BoardUpdate" WHERE id = $1`, updateId);
  if (!u) throw new BoardError(400, 'No such update');
  return u.id;
}

// tasks: [{ name, subtasks: [names] }]; left out, a unit gets UNIT_TEMPLATE and anything else starts empty.
async function createCard(body = {}, by, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const kind = body.kind === 'other' ? 'other' : 'unit';
  const tasks = Array.isArray(body.tasks) ? body.tasks : kind === 'unit' ? UNIT_TEMPLATE : [];
  if (tasks.length > 40) throw new BoardError(400, 'That is too many tasks for one card');
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardCard" (id, identifier, name, kind, "updateId", rarity, "notionUrl", "createdBy") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    id, await nextIdentifier(prisma), cleanName(body.name, 'A card name'), kind, await checkUpdate(prisma, body.updateId), RARITY(body.rarity), URLISH(body.notionUrl), by || null);
  for (const t of tasks) {
    const task = await addTask(id, { name: typeof t === 'string' ? t : t.name }, by, prisma);
    for (const s of (Array.isArray(t.subtasks) ? t.subtasks : []).slice(0, 20)) await addTask(id, { name: s, parentId: task.id }, by, prisma);
  }
  return findCard(id, prisma);
}

async function updateCard(ref, body = {}, prisma = getPrisma()) {
  const c = await findCard(ref, prisma);
  const sets = {};
  if ('name' in body) sets.name = cleanName(body.name, 'A card name');
  if ('updateId' in body) sets.updateId = await checkUpdate(prisma, body.updateId);
  if ('rarity' in body) sets.rarity = RARITY(body.rarity);
  if ('element' in body) sets.element = RARITY(body.element);
  if ('notionUrl' in body) sets.notionUrl = URLISH(body.notionUrl);
  const keys = Object.keys(sets);
  if (keys.length) {
    await prisma.$executeRawUnsafe(`UPDATE "BoardCard" SET ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')}, "updatedAt" = now() WHERE id = $1`, c.id, ...Object.values(sets));
  }
  return findCard(c.id, prisma);
}

// Cards are archived rather than deleted, so nothing about them is lost by a slip.
async function archiveCard(ref, prisma = getPrisma()) {
  const c = await findCard(ref, prisma);
  await prisma.$executeRawUnsafe(`UPDATE "BoardCard" SET archived = true, "updatedAt" = now() WHERE id = $1`, c.id);
  return { ok: true };
}

// Game updates, to group and filter cards by.
async function createUpdate(name, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const n = cleanName(name, 'An update name');
  const [dup] = await prisma.$queryRawUnsafe(`SELECT id FROM "BoardUpdate" WHERE lower(name) = lower($1)`, n);
  if (dup) throw new BoardError(409, `There is already an update called ${n}`);
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardUpdate" (id, name) VALUES ($1, $2)`, id, n);
  return { id, name: n };
}
async function renameUpdate(id, name, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const n = cleanName(name, 'An update name');
  const [dup] = await prisma.$queryRawUnsafe(`SELECT id FROM "BoardUpdate" WHERE lower(name) = lower($1) AND id <> $2`, n, id);
  if (dup) throw new BoardError(409, `There is already an update called ${n}`);
  await prisma.$executeRawUnsafe(`UPDATE "BoardUpdate" SET name = $2 WHERE id = $1`, id, n);
  return { id, name: n };
}
// Its cards stay, with no update.
async function removeUpdate(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`UPDATE "BoardCard" SET "updateId" = NULL WHERE "updateId" = $1`, id);
  await prisma.$executeRawUnsafe(`DELETE FROM "BoardUpdate" WHERE id = $1`, id);
  return { ok: true };
}

// "Send to Assets": a link to the Discord message with the work in it, and the task is done.
async function deliver(ref, { url, files = [], note, devId, devName, by } = {}, prisma = getPrisma()) {
  const t = await findTask(ref, prisma);
  if (!/^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/\S+$/.test(String(url || ''))) throw new BoardError(400, 'That is not a link to a Discord message');
  const { byId } = await roster(prisma);
  const dev = devId ? byId.get(devId) : null;
  const name = dev?.name || (devName ? String(devName).slice(0, 80) : null);
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardDelivery" (id, "taskId", url, files, note, "devName", by) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    newId(), t.id, url, JSON.stringify((Array.isArray(files) ? files : []).slice(0, 10).map(f => String(f).slice(0, 120))), note ? String(note).slice(0, 1000) : null, name, by || null);
  // Someone who isn't on it yet gets it: their name is on the delivery, so it's theirs.
  if (dev && t.devId !== dev.id) {
    await prisma.$executeRawUnsafe(`UPDATE "BoardTask" SET "devId" = $2, "devName" = $3, "startedAt" = COALESCE("startedAt", now()) WHERE id = $1`, t.id, dev.id, dev.name);
  } else if (!t.devId && !t.devName && name) {
    await prisma.$executeRawUnsafe(`UPDATE "BoardTask" SET "devName" = $2 WHERE id = $1`, t.id, name);
  }
  const was = t.status;
  if (was !== 'done') {
    await prisma.$executeRawUnsafe(`UPDATE "BoardTask" SET status = 'done', "completedAt" = now(), "updatedAt" = now() WHERE id = $1`, t.id);
    await event(prisma, t.id, was, 'done', name, by);
  }
  return { task: await findTask(t.id, prisma), was };
}

async function removeDelivery(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM "BoardDelivery" WHERE id = $1`, id);
}

async function deliveriesOf(ref, prisma = getPrisma()) {
  const t = await findTask(ref, prisma);
  const list = await prisma.$queryRawUnsafe(`SELECT * FROM "BoardDelivery" WHERE "taskId" = $1 ORDER BY at DESC LIMIT 25`, t.id);
  return { task: pick({ ...t, label: t.cardName ? `${t.cardName} › ${t.name}` : t.name }), deliveries: list.map(d => ({ ...d, files: json(d.files) })) };
}

async function history(ref, prisma = getPrisma()) {
  const id = await idOf(ref, prisma);
  const events = await prisma.$queryRawUnsafe(`SELECT "from", "to", dev, by, at FROM "BoardEvent" WHERE "issueId" = $1 ORDER BY at DESC LIMIT 30`, id);
  const acts = await prisma.$queryRawUnsafe(`SELECT kind, text, url, by, at FROM "BoardActivity" WHERE "issueId" = $1 ORDER BY at DESC LIMIT 30`, id);
  return { events, activity: acts };
}

// Each dev with a place on Discord and what they have in progress, for the dots.
async function working(prisma = getPrisma()) {
  const { list } = await roster(prisma);
  const all = await labels(prisma);
  return list.map(d => ({ ...d, tasks: all.filter(t => t.devId === d.id && t.status === 'in_progress').map(pick) }));
}

module.exports = {
  ensureSchema, settings, setSettings, getMeta, setMeta, start, board, roster, findTask, findCard, idOf,
  setStatus, renameTask, addTask, removeTask, createCard, updateCard, archiveCard,
  createUpdate, renameUpdate, removeUpdate, deliver, removeDelivery, deliveriesOf, history, search, tasksOf, working,
  addImage, useImage, image, removeImage, imageUrl, setNotes, addActivity, nextIdentifier,
  BoardError, DEFAULTS, UNIT_TEMPLATE, byBoardOrder, orderOf,
};
