// The asset assistant: approved people talk to the bot in Discord and it
// answers from the tracker, the file index and the notes, or writes a note.
//
//   "Get me the most recent files for Stark"
//   "Ruku updated Stark's face model in his most recent image, this is current"
//
// It is separate from the suggestion pipeline. That one reads everybody and
// only ever proposes; this one answers a short list of approved Discord
// accounts directly. It can read the tracker, files and notes, and it can
// write notes and mark a file as the current one. It cannot change tasks.
//
// Three stores back it:
//   AssetFile   every attachment or file link posted where the agent reads,
//               kept for good (raw messages are pruned after 30 days)
//   AssetNote   notes written through the assistant, tied to an item, a dev
//               and files where it can tell
//   AssetSetting 'assistant'   who may use it, and where it answers unprompted

const fs = require('fs');
const path = require('path');
const { newId } = require('../db');
const q = require('../queries');
const settingsStore = require('./settings');

const MODEL = () => process.env.ASSET_AGENT_ASSISTANT_MODEL || process.env.ASSET_AGENT_EXTRACT_MODEL || 'claude-sonnet-5-5';
const MAX_TURNS = 6;
const norm = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const isId = v => /^\d{17,20}$/.test(String(v || ''));

// ── settings ─────────────────────────────────────────────────────────────────

function normalizeSettings(raw = {}) {
  const people = (Array.isArray(raw.admins) ? raw.admins : [])
    .map(a => ({ id: String(a?.id || '').trim(), label: String(a?.label || '').trim().slice(0, 60) }))
    .filter(a => isId(a.id));
  const channels = (Array.isArray(raw.channels) ? raw.channels : [])
    .map(c => ({ id: String(c?.id || '').trim(), label: String(c?.label || '').trim().slice(0, 60) }))
    .filter(c => isId(c.id));
  const unique = list => [...new Map(list.map(x => [x.id, x])).values()];
  return { enabled: raw.enabled !== false, admins: unique(people).slice(0, 50), channels: unique(channels).slice(0, 50) };
}

async function getSettings(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT "value" FROM "AssetSetting" WHERE "key" = 'assistant'`);
  return normalizeSettings(rows[0]?.value || {});
}

async function saveSettings(prisma, patch) {
  const next = normalizeSettings({ ...(await getSettings(prisma)), ...patch });
  await prisma.$executeRawUnsafe(`
    INSERT INTO "AssetSetting" ("key", "value") VALUES ('assistant', $1::jsonb)
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
  `, JSON.stringify(next));
  return next;
}

// ── file index ───────────────────────────────────────────────────────────────

const FILE_LINK = /https?:\/\/(?:[\w-]+\.)*(?:drive\.google\.com|docs\.google\.com|dropbox\.com|mega\.nz|figma\.com|sketchfab\.com|mediafire\.com|we\.tl|wetransfer\.com|gofile\.io|create\.roblox\.com|roblox\.com\/library)\/\S+/gi;
const KINDS = [
  ['image', /\.(png|jpe?g|gif|webp|bmp|tga|psd|exr|tiff?)$/i],
  ['video', /\.(mp4|mov|webm|mkv|avi)$/i],
  ['model', /\.(blend|fbx|obj|glb|gltf|ma|mb|max|ztl|zpr|spp|rbxm|rbxmx|rbxl|rbxlx|stl|dae)$/i],
  ['audio', /\.(mp3|wav|ogg|flac)$/i],
  ['archive', /\.(zip|rar|7z)$/i],
];
const kindOf = name => (KINDS.find(([, re]) => re.test(name || '')) || ['file'])[0];

// Which content item a message is about, from its text, file names and the
// name of the channel or post it is in. Longest names win, so "Ichigo (VL)"
// beats "Ichigo". Names shorter than three letters are too risky to match.
function matchItem(items, ...texts) {
  const hay = norm(texts.filter(Boolean).join(' '));
  if (!hay) return null;
  const names = [];
  for (const item of items) {
    for (const name of [item.internalName, item.displayName]) {
      const key = norm(name);
      if (key.length >= 3) names.push({ key, item });
    }
  }
  names.sort((a, b) => b.key.length - a.key.length);
  // Internal names are specific ("Starrk"); display names are often a rarity ("Mythic") shared by many.
  const hit = names.find(n => hay.includes(n.key) && items.filter(i => norm(i.internalName) === n.key || norm(i.displayName) === n.key).length === 1);
  return hit ? hit.item : null;
}

// People type names loosely ("stark" for Starrk, "rabbit" for Rabbit3D).
// Exact first, then one name containing the other, then a near miss by
// spelling. A near miss only counts when exactly one name is that close.
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
function findByName(list, typed, names, { tieBreak = true } = {}) {
  const key = norm(typed);
  if (key.length < 2) return null;
  const all = list.flatMap(entry => names(entry).filter(Boolean).map(n => ({ entry, key: norm(n) }))).filter(n => n.key);
  const pick = hits => { const unique = [...new Set(hits.map(h => h.entry))]; return unique.length === 1 ? unique[0] : null; };
  const exact = all.filter(n => n.key === key);
  if (exact.length) return pick(exact) || (tieBreak ? exact[0].entry : null);
  const partial = key.length >= 3 ? all.filter(n => n.key.includes(key) || (n.key.length >= 3 && key.includes(n.key))) : [];
  if (partial.length) {
    const only = pick(partial);
    if (only || !tieBreak) return only;
    // Several contain it: the one closest in length is the likeliest.
    return partial.sort((a, b) => Math.abs(a.key.length - key.length) - Math.abs(b.key.length - key.length))[0].entry;
  }
  const allowed = key.length >= 8 ? 2 : key.length >= 4 ? 1 : 0;
  if (!allowed) return null;
  const scored = all.map(n => ({ ...n, d: distance(key, n.key) })).filter(n => n.d <= allowed).sort((a, b) => a.d - b.d);
  if (!scored.length) return null;
  return pick(scored.filter(n => n.d === scored[0].d));
}
// Internal names first: display names are often a rarity ("Mythic") that many items share.
const findItem = (items, typed) => findByName(items, typed, i => [i.internalName]) || findByName(items, typed, i => [i.displayName], { tieBreak: false });
const findDev = (devs, typed) => findByName(devs, typed, d => [d.name]);

// Called for every message stored by the pipeline, and for assistant
// messages. Records each upload and file link once.
async function indexFiles(prisma, message, { items, devs }) {
  const attachments = (Array.isArray(message.attachments) ? message.attachments : []).filter(a => a && (a.name || a.url));
  const links = [...String(message.content || '').matchAll(FILE_LINK)].map(m => m[0].replace(/[)>.,]+$/, '')).slice(0, 5);
  if (!attachments.length && !links.length) return 0;
  const dev = devs.find(d => d.discordUserId && d.discordUserId === String(message.authorDiscordId))
    // A post in a dev's own forum by someone else (a lead uploading for them) is still that dev's work.
    || devs.find(d => d.discordThreadId && [message.channelId, message.parentChannelId].map(String).includes(d.discordThreadId)) || null;
  const messageUrl = message.guildId ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}` : null;
  const rows = [
    ...attachments.map((a, i) => ({ key: `${message.id}:${i}`, filename: String(a.name || 'file').slice(0, 200), url: a.url || null })),
    ...links.map((url, i) => ({ key: `${message.id}:link${i}`, filename: url.replace(/^https?:\/\//, '').slice(0, 200), url, link: true })),
  ];
  let stored = 0;
  for (const row of rows) {
    const item = matchItem(items, row.link ? '' : row.filename, message.content, message.channelName);
    stored += await prisma.$executeRawUnsafe(`
      INSERT INTO "AssetFile" ("id", "messageId", "channelId", "channelName", "guildId", "messageUrl", "fileUrl", "filename", "kind",
        "authorDiscordId", "authorName", "devId", "contentItemId", "context", "postedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)
      ON CONFLICT ("id") DO NOTHING`,
    row.key, String(message.id), String(message.channelId), message.channelName ? String(message.channelName).slice(0, 120) : null,
    message.guildId ? String(message.guildId) : null, messageUrl, row.url, row.filename, row.link ? 'link' : kindOf(row.filename),
    String(message.authorDiscordId), String(message.authorName || '').slice(0, 100), dev?.id || null, item?.id || null,
    String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 400) || null, new Date(message.postedAt || Date.now()).toISOString());
  }
  return stored;
}

async function indexContext(prisma) {
  const [items, devs] = await Promise.all([q.listItems(prisma, { includeArchived: true }), q.listDevs(prisma)]);
  return { items, devs };
}

// Messages stored before the file index existed still hold their uploads.
// Index those once per process, before they are pruned.
const backfilled = new WeakSet();
async function backfillFiles(prisma) {
  if (backfilled.has(prisma)) return 0;
  backfilled.add(prisma);
  const rows = await prisma.$queryRawUnsafe(`
    SELECT m.id, m."channelId", m."parentChannelId", m."guildId", m."authorDiscordId", m."authorName", m.content, m.attachments, m."postedAt"
    FROM "AssetAgentMessage" m
    WHERE (jsonb_array_length(m.attachments) > 0 OR m.content ILIKE '%http%')
      AND NOT EXISTS (SELECT 1 FROM "AssetFile" f WHERE f."messageId" = m.id)
    ORDER BY m."postedAt" LIMIT 5000`);
  if (!rows.length) return 0;
  const ctx = await indexContext(prisma);
  let n = 0;
  for (const m of rows) n += await indexFiles(prisma, m, ctx);
  if (n) console.log(`[AssetAssistant] indexed ${n} file(s) from messages stored earlier`);
  return n;
}

const FILE_FIELDS = `f.id, f.filename, f.kind, f."messageUrl", f."fileUrl", f."channelName", f."authorName", f."devId", f."contentItemId",
  f.context, f."isCurrent", f."postedAt", d.name AS "devName", ci."internalName" AS "itemName"`;

// query: { item, dev, text, kind, limit }. Newest first, files marked current on top.
async function searchFiles(prisma, query = {}, ctx) {
  const { items, devs } = ctx || await indexContext(prisma);
  const where = [];
  const values = [];
  const add = (sql, value) => { values.push(value); where.push(sql.replace(/\?/g, `$${values.length}`)); };
  let item = null;
  let dev = null;
  if (query.contentItemId) add(`f."contentItemId" = ?`, String(query.contentItemId));
  if (query.item) {
    item = findItem(items, query.item);
    // Files the indexer could not tie to an item are still found by name.
    if (item) add(`(f."contentItemId" = ? OR (f."contentItemId" IS NULL AND (f.filename ILIKE '%' || $${values.length + 2} || '%' OR f.context ILIKE '%' || $${values.length + 2} || '%' OR f."channelName" ILIKE '%' || $${values.length + 2} || '%')))`, item.id), values.push(item.internalName);
    else add(`(f.filename ILIKE '%' || ? || '%' OR f.context ILIKE '%' || ? || '%' OR f."channelName" ILIKE '%' || ? || '%')`, String(query.item));
  }
  if (query.dev) {
    dev = findDev(devs, query.dev);
    if (dev) add(`(f."devId" = ? OR f."authorDiscordId" = $${values.length + 2})`, dev.id), values.push(dev.discordUserId || '-');
    else add(`f."authorName" ILIKE '%' || ? || '%'`, String(query.dev));
  }
  if (query.text) add(`(f.filename ILIKE '%' || ? || '%' OR f.context ILIKE '%' || ? || '%')`, String(query.text));
  if (query.kind && query.kind !== 'any') add(`f.kind = ?`, String(query.kind));
  const limit = Math.min(25, Math.max(1, Number(query.limit) || 8));
  const rows = await prisma.$queryRawUnsafe(`
    SELECT ${FILE_FIELDS}
    FROM "AssetFile" f
    LEFT JOIN "AssetDev" d ON d.id = f."devId"
    LEFT JOIN "AssetContentItem" ci ON ci.id = f."contentItemId"
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY f."isCurrent" DESC, f."postedAt" DESC
    LIMIT ${limit}`, ...values);
  return { files: rows, item, dev };
}

// ── notes ────────────────────────────────────────────────────────────────────

const NOTE_FIELDS = `n.id, n.text, n."authorName", n."contentItemId", n."devId", n."fileIds", n."sourceUrl", n."createdAt",
  d.name AS "devName", ci."internalName" AS "itemName"`;

async function listNotes(prisma, { contentItemId, devId, text, limit = 20 } = {}) {
  const where = [];
  const values = [];
  if (contentItemId) { values.push(contentItemId); where.push(`n."contentItemId" = $${values.length}`); }
  if (devId) { values.push(devId); where.push(`n."devId" = $${values.length}`); }
  if (text) { values.push(String(text)); where.push(`n.text ILIKE '%' || $${values.length} || '%'`); }
  return prisma.$queryRawUnsafe(`
    SELECT ${NOTE_FIELDS}
    FROM "AssetNote" n
    LEFT JOIN "AssetDev" d ON d.id = n."devId"
    LEFT JOIN "AssetContentItem" ci ON ci.id = n."contentItemId"
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY n."createdAt" DESC
    LIMIT ${Math.min(100, Math.max(1, Number(limit) || 20))}`, ...values);
}

async function saveNote(prisma, { text, item, dev, fileIds = [], markCurrent = false, author, sourceUrl }, ctx) {
  const body = String(text || '').trim().slice(0, 2000);
  if (!body) return { error: 'The note has no text.' };
  const { items, devs } = ctx || await indexContext(prisma);
  const theItem = item ? findItem(items, item) : matchItem(items, body);
  const theDev = dev ? findDev(devs, dev) : null;
  const ids = [...new Set((Array.isArray(fileIds) ? fileIds : []).map(String))].slice(0, 10);
  const files = ids.length ? await prisma.$queryRawUnsafe(`SELECT id, "contentItemId" FROM "AssetFile" WHERE id = ANY($1::text[])`, ids) : [];
  const id = newId();
  await prisma.$executeRawUnsafe(`
    INSERT INTO "AssetNote" ("id", "text", "authorDiscordId", "authorName", "contentItemId", "devId", "fileIds", "sourceUrl")
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
  id, body, author?.discordId || null, author?.name || 'Assistant', theItem?.id || null, theDev?.id || null, JSON.stringify(files.map(f => f.id)), sourceUrl || null);

  // Files named in a note belong to that note's item from now on.
  if (theItem && files.length) {
    await prisma.$executeRawUnsafe(`UPDATE "AssetFile" SET "contentItemId" = $1 WHERE id = ANY($2::text[])`, theItem.id, files.map(f => f.id));
  }
  // "This is current": these files become the current ones for the item, replacing whatever was.
  if (markCurrent && files.length) {
    if (theItem) await prisma.$executeRawUnsafe(`UPDATE "AssetFile" SET "isCurrent" = false WHERE "contentItemId" = $1 AND "isCurrent"`, theItem.id);
    await prisma.$executeRawUnsafe(`UPDATE "AssetFile" SET "isCurrent" = true WHERE id = ANY($1::text[])`, files.map(f => f.id));
  }
  return {
    saved: true, noteId: id, item: theItem?.internalName || null, dev: theDev?.name || null,
    filesAttached: files.length, markedCurrent: !!(markCurrent && files.length),
    ...(item && !theItem ? { warning: `No content item called "${item}" was found, so the note is not tied to one.` } : {}),
    ...(ids.length && !files.length ? { warning: 'None of those file ids exist, so no file was attached.' } : {}),
  };
}

// ── the conversation with the model ──────────────────────────────────────────

const str = description => ({ type: 'string', description });
const TOOLS = [
  {
    name: 'search_files',
    description: 'Find files (uploads and file links) people posted in the channels the agent reads. Newest first; files marked as current come first. Use it for any request for files, images, models or "the latest" of something.',
    input_schema: {
      type: 'object',
      properties: {
        item: str('Content item name, e.g. "Starrk". Optional.'),
        dev: str('Roster name of the person who posted or made it, e.g. "Ruku". Optional.'),
        text: str('Words that must appear in the file name or the message it came with, e.g. "face". Optional.'),
        kind: { type: 'string', enum: ['any', 'image', 'video', 'model', 'audio', 'archive', 'link', 'file'], description: 'Limit to one kind of file. Optional.' },
        limit: { type: 'integer', description: 'How many to return, 1 to 25. Default 8.' },
      },
    },
  },
  {
    name: 'save_note',
    description: 'Write a note to the asset log. Use it when the person tells you something to remember ("X updated Y, this is current"). If the note is about a specific file, find it with search_files first and pass its id.',
    input_schema: {
      type: 'object',
      properties: {
        text: str('The note, in plain words, complete enough to make sense on its own later.'),
        item: str('Content item the note is about, if any.'),
        dev: str('Roster name of the dev the note is about, if any.'),
        file_ids: { type: 'array', items: { type: 'string' }, description: 'Ids of files from search_files that the note refers to.' },
        mark_current: { type: 'boolean', description: 'True when the person says these files are the current / latest / final version.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_notes',
    description: 'Read notes saved earlier, newest first.',
    input_schema: { type: 'object', properties: { item: str('Content item name. Optional.'), dev: str('Roster name. Optional.'), text: str('Words to search for. Optional.') } },
  },
  {
    name: 'get_item',
    description: "A content item's tasks with status, assignee, due date and any blocker, plus its progress.",
    input_schema: { type: 'object', properties: { item: str('Content item name.') }, required: ['item'] },
  },
  {
    name: 'get_dev',
    description: "A dev's open tasks, and whether they are free to take work.",
    input_schema: { type: 'object', properties: { dev: str('Roster name.') }, required: ['dev'] },
  },
];

let prompt = null;
const systemPrompt = () => (prompt ||= fs.readFileSync(path.join(__dirname, '../prompts/assistant.md'), 'utf8').trim());

const when = ts => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
const fileLine = f => ({
  id: f.id, name: f.filename, kind: f.kind, link: f.messageUrl || f.fileUrl, posted: `${when(f.postedAt)} UTC`,
  by: f.devName || f.authorName, item: f.itemName || null, where: f.channelName || null,
  current: f.isCurrent || undefined, said: f.context || undefined,
});

async function runTool(prisma, name, input, ctx, state) {
  if (name === 'search_files') {
    const { files, item, dev } = await searchFiles(prisma, input, ctx);
    return { matched_item: item?.internalName || null, matched_dev: dev?.name || null, count: files.length, files: files.map(fileLine) };
  }
  if (name === 'save_note') {
    const result = await saveNote(prisma, {
      text: input.text, item: input.item, dev: input.dev, fileIds: input.file_ids, markCurrent: input.mark_current === true,
      author: state.author, sourceUrl: state.sourceUrl,
    }, ctx);
    if (result.saved) state.notes.push(result);
    return result;
  }
  if (name === 'get_notes') {
    const item = input.item ? findItem(ctx.items, input.item) : null;
    const dev = input.dev ? findDev(ctx.devs, input.dev) : null;
    const notes = await listNotes(prisma, { contentItemId: item?.id, devId: dev?.id, text: input.text });
    return { count: notes.length, notes: notes.map(n => ({ text: n.text, by: n.authorName, when: `${when(n.createdAt)} UTC`, item: n.itemName, dev: n.devName })) };
  }
  if (name === 'get_item') {
    const item = findItem(ctx.items, input.item);
    if (!item) return { error: `No content item called "${input.item}".`, items: ctx.items.filter(i => !i.archived).map(i => i.internalName).slice(0, 80) };
    const tasks = await q.listTasksDetailed(prisma, { contentItemId: item.id });
    return {
      item: item.internalName, display_name: item.displayName, type: item.contentType, owner: item.ownerName || null, done: item.done, of: item.countable,
      tasks: tasks.map(t => ({ ref: t.ref, discipline: t.discipline, task: t.deliverable, status: t.status, assignee: t.assigneeName || null, due: t.dueDate || null, blocked_on: t.blockedReason || undefined })),
    };
  }
  if (name === 'get_dev') {
    const dev = findDev(ctx.devs, input.dev);
    if (!dev) return { error: `Nobody on the roster is called "${input.dev}".` };
    const tasks = (await q.listTasksDetailed(prisma, { assigneeDevId: dev.id })).filter(t => ['Not Started', 'In Progress', 'Review', 'Blocked'].includes(t.status));
    return {
      dev: dev.name, disciplines: dev.disciplines, status: dev.status, free_to_task: dev.status === 'Active' && !dev.openTasks,
      open_tasks: tasks.slice(0, 40).map(t => ({ ref: t.ref, item: t.internalName, task: t.deliverable, status: t.status, due: t.dueDate || null, blocked_on: t.blockedReason || undefined })),
    };
  }
  return { error: `Unknown tool ${name}` };
}

function getClient() {
  const Anthropic = require('@anthropic-ai/sdk');
  const { fetchWithFreshConnection } = require('../../fresh-fetch');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: fetchWithFreshConnection });
}

// message: { id, channelId, parentChannelId, guildId, channelName, authorDiscordId, authorName, content, attachments, postedAt }
// history: earlier turns in the same channel, oldest first: [{ role: 'user' | 'assistant', name, content }]
async function respond(prisma, { message, history = [] }, { client } = {}) {
  const settings = await getSettings(prisma);
  if (!settings.enabled || !settings.admins.some(a => a.id === String(message.authorDiscordId))) {
    return { reply: null, denied: true };
  }
  await backfillFiles(prisma).catch(err => console.error('[AssetAssistant] backfill failed:', err.message));
  const ctx = await indexContext(prisma);
  // Files the person attached to this very message are indexed first, so "this file" can be found.
  await indexFiles(prisma, message, ctx);

  const roster = ctx.devs.filter(d => d.status !== 'Inactive').map(d => d.name).join(', ');
  const itemNames = ctx.items.filter(i => !i.archived).map(i => i.internalName).join(', ');
  const place = ctx.devs.find(d => d.discordThreadId && [message.channelId, message.parentChannelId].map(String).includes(d.discordThreadId));
  const system = [
    { type: 'text', text: systemPrompt() },
    { type: 'text', text: `CONTENT ITEMS: ${itemNames || 'none yet'}\n\nROSTER: ${roster || 'nobody yet'}` },
  ];
  const turns = history.slice(-10).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: `${h.role === 'assistant' ? '' : `${h.name || 'someone'}: `}${String(h.content || '').slice(0, 1500)}` }))
    // The API wants the conversation to start with the person and alternate.
    .reduce((list, t) => { const last = list[list.length - 1]; if (last && last.role === t.role) last.content += `\n${t.content}`; else list.push(t); return list; }, []);
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (turns.length && turns[turns.length - 1].role === 'user') turns.pop(); // the current message is added below
  const attached = (message.attachments || []).map(a => a.name).filter(Boolean);
  const messages = [...turns, {
    role: 'user',
    content: [
      `Today is ${new Date().toISOString().slice(0, 10)}. ${message.authorName || 'An admin'} says, in ${message.channelName ? `"${message.channelName}"` : 'Discord'}${place ? ` (${place.name}'s work channel)` : ''}:`,
      '', String(message.content || '').slice(0, 3000),
      attached.length ? `\n(They attached: ${attached.join(', ')})` : '',
    ].filter(l => l !== '').join('\n'),
  }];

  const state = {
    author: { discordId: String(message.authorDiscordId), name: message.authorName || null },
    sourceUrl: message.guildId ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}` : null,
    notes: [],
  };
  const api = client || getClient();
  const model = MODEL();
  const usage = {};
  let reply = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const params = { model, max_tokens: 2000, system, tools: TOOLS, messages };
    const effort = process.env.ASSET_AGENT_ASSISTANT_EFFORT || 'low';
    if (effort !== 'off') params.output_config = { effort };
    const response = await api.messages.create(params, { timeout: 120000 });
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) usage[key] = (usage[key] || 0) + (response.usage?.[key] || 0);
    if (response.stop_reason === 'refusal') { reply = 'I cannot help with that one.'; break; }
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const calls = response.content.filter(b => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) { reply = text; break; }
    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const call of calls) {
      let result;
      try { result = await runTool(prisma, call.name, call.input || {}, ctx, state); }
      catch (err) { result = { error: `That lookup failed: ${err.message}` }; }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
    }
    messages.push({ role: 'user', content: results });
    if (turn === MAX_TURNS - 1) reply = text || 'I ran out of steps before I could finish that. Try asking for one thing at a time.';
  }
  await settingsStore.logUsage(prisma, { batchId: null, pass: 'assistant', model, usage });
  return { reply: (reply || 'I have nothing to add.').slice(0, 1900), notes: state.notes, costUsd: settingsStore.costOf(model, usage) };
}

module.exports = {
  getSettings, saveSettings, normalizeSettings,
  indexFiles, indexContext, backfillFiles, searchFiles, matchItem, findItem, findDev, kindOf,
  listNotes, saveNote, respond, TOOLS,
};
