// The asset assistant: approved people talk to the bot in Discord and it
// answers from the tracker, the file index and the notes, or writes a note.
//
//   "Get me the most recent files for Stark"
//   "Ruku updated Stark's face model in his most recent image, this is current"
//
// It is separate from the suggestion pipeline. That one reads everybody and
// only ever proposes; this one answers a short list of approved Discord
// accounts directly. It can read the tracker, files and notes, and it can
// write notes and mark a file as the current one. It cannot change tasks
// itself: when a person explicitly tells it to, it proposes the change and
// a confirmation card with Accept / Reject is posted for them to approve.
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
  // What an approved person starts a message with to talk to the bot in a
  // channel the agent reads (a dev's forum, say). Empty turns that off.
  const prefix = raw.prefix === undefined || raw.prefix === null ? '--' : String(raw.prefix).trim().slice(0, 6);
  return { enabled: raw.enabled !== false, prefix, admins: unique(people).slice(0, 50), channels: unique(channels).slice(0, 50) };
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
// An update by its number or its name: "5", "update 3.5", "#4", "halloween", "the halloween update".
function findUpdate(updates, typed) {
  const text = String(typed || '').trim().replace(/^the\s+/i, '');
  const number = text.match(/^(?:update\s*)?#?\s*(\d+(?:\.\d+)?)$/i);
  if (number) return updates.find(u => Number(u.number) === Number(number[1])) || null;
  const name = text.replace(/\bupdate\b/ig, ' ');
  // The whole name first, then one word of it ("haloween" for "Halloween Event"), when only one update has that word.
  return findByName(updates, name, u => [u.name])
    || findByName(updates, name, u => String(u.name || '').split(/\s+/).filter(w => w.length >= 4), { tieBreak: false });
}

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

// query: { item, dev, text, kind, updateId, limit }. Newest first, files marked current on top.
async function searchFiles(prisma, query = {}, ctx) {
  const { items, devs } = ctx || await indexContext(prisma);
  const where = [];
  const values = [];
  const add = (sql, value) => { values.push(value); where.push(sql.replace(/\?/g, `$${values.length}`)); };
  let item = null;
  let dev = null;
  if (query.contentItemId) add(`f."contentItemId" = ?`, String(query.contentItemId));
  if (query.updateId) add(`ci."updateId" = ?`, String(query.updateId));
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
        update: str('Only files for content items in this update, by number or name, e.g. "5" or "halloween". Files not tied to an item are left out. Optional.'),
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
    name: 'propose_task_change',
    description: 'Propose a change to ONE tracker task. Nothing is changed by this call: a confirmation card is posted and a person must press Accept. Only call it when the person has explicitly told you to make the change (see the rules). Find the task ref first with get_item or get_dev.',
    input_schema: {
      type: 'object',
      properties: {
        task_ref: str('The task ref number, without the #.'),
        status: { type: 'string', enum: ['Not Started', 'In Progress', 'Review', 'Done', 'Blocked', 'N/A'], description: 'New status. Optional.' },
        blocked_reason: str('What it is waiting on. Required when status is Blocked.'),
        assignee: str('Roster name of the dev to assign it to. Optional.'),
        due_date: str('Due date as YYYY-MM-DD. Optional.'),
        note: str('A note to add to the task (asset id, link, decision). Optional.'),
      },
      required: ['task_ref'],
    },
  },
  {
    name: 'propose_new_item',
    description: 'Propose adding ONE new content item (a unit, map, boss, skin and so on) to an update. Nothing is created by this call: a confirmation card is posted and a person must press Accept. On Accept the item is created with the full task checklist for its content type. Only call it when the person has explicitly told you to add it.',
    input_schema: {
      type: 'object',
      properties: {
        name: str('The item\'s internal name, e.g. "Byakuya".'),
        content_type: str('One of the content types you were given, e.g. "Unit".'),
        update_number: str('The update number it goes in, e.g. "4" or "3.5". Use the update in development if they did not say and there is exactly one.'),
        display_name: str('Display name or rarity if they gave one, e.g. "Mythic". Optional.'),
      },
      required: ['name', 'content_type', 'update_number'],
    },
  },
  {
    name: 'propose_expenses',
    description: 'Propose logging payments as expenses on the Revenue page, one expense per person, all with the same description, category and date. Nothing is logged by this call: one confirmation card is posted listing every payment, and an approved admin must press Accept. Only call it when the person has explicitly told you to log the payments. Amounts are Robux.',
    input_schema: {
      type: 'object',
      properties: {
        description: str('What the payments are for, as it should read on each expense, e.g. "3.5 Tester payout".'),
        category: str('Expense category. One of the categories in use (the tool lists them if this is wrong). Tester and contractor pay has been logged as "Contractor", asset work as "Art/Assets".'),
        date: str('Date paid as YYYY-MM-DD. Leave empty for today.'),
        payments: {
          type: 'array',
          description: 'One entry per person paid.',
          items: {
            type: 'object',
            properties: {
              name: str('Who was paid: their username or name exactly as written.'),
              roblox_id: str('Their Roblox user id if one was given, else empty.'),
              amount: str('The amount exactly as written, e.g. "100k" or "45000".'),
            },
            required: ['name', 'amount'],
          },
        },
        split_between: { type: 'array', items: { type: 'string' }, description: 'Names of the people who split the cost, when the person named specific people. Leave empty when it is split across everyone on the roster (the default).' },
      },
      required: ['description', 'category', 'payments'],
    },
  },
  {
    name: 'get_payments',
    description: 'Payments logged on the Revenue page (the expense log): who was paid, how many Robux, what for, and when, newest first, with a total. Use it for "how much have we paid Ruku", "was the Aizen shiny model paid for", "what did we pay for last week".',
    input_schema: {
      type: 'object',
      properties: {
        name: str('Who was paid: a dev or payee name. Optional.'),
        text: str('Words that must appear in what the payment was for, e.g. "Aizen". Optional.'),
        limit: { type: 'integer', description: 'How many payments to return, 1 to 40. Default 15.' },
      },
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
    name: 'get_update',
    description: 'An update by its number or its name ("5", "3.5", "halloween"): its status, lead, target release and progress, and every content item in it with its type, owner and progress. Released updates can be looked up too. Use it for "what is in update 5", "how is the halloween update going", "what is left for 3.5".',
    input_schema: { type: 'object', properties: { update: str('The update number or name, e.g. "5" or "halloween".') }, required: ['update'] },
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
  const updateList = async () => (state.updates ||= await q.listUpdates(prisma));
  const noUpdate = async typed => ({ error: `No update matches "${typed}".`, updates: (await updateList()).map(u => `${u.number} ${u.name} (${u.status})`) });
  if (name === 'search_files') {
    const update = input.update ? findUpdate(await updateList(), input.update) : null;
    if (input.update && !update) return noUpdate(input.update);
    const { files, item, dev } = await searchFiles(prisma, { ...input, updateId: update?.id }, ctx);
    return {
      matched_item: item?.internalName || null, matched_dev: dev?.name || null, ...(update ? { matched_update: `${update.number} ${update.name}` } : {}),
      count: files.length, files: files.map(fileLine),
    };
  }
  if (name === 'get_update') {
    const update = findUpdate(await updateList(), input.update);
    if (!update) return noUpdate(input.update);
    const items = ctx.items.filter(i => i.updateId === update.id && !i.archived);
    return {
      update: `${update.number} ${update.name}`, status: update.status, lead: update.leadName || null, target_release: update.targetRelease || null,
      done: update.done, of: update.countable, blocked: update.blocked,
      items: items.slice(0, 80).map(i => ({ item: i.internalName, display_name: i.displayName, type: i.contentType, owner: i.ownerName || null, done: i.done, of: i.countable, blocked: i.blocked || undefined })),
      ...(items.length > 80 ? { more_items: items.length - 80 } : {}),
    };
  }
  if (name === 'save_note') {
    const result = await saveNote(prisma, {
      text: input.text, item: input.item, dev: input.dev, fileIds: input.file_ids, markCurrent: input.mark_current === true,
      author: state.author, sourceUrl: state.sourceUrl,
    }, ctx);
    if (result.saved) state.notes.push(result);
    return result;
  }
  // Both kinds of proposal go through the suggestion checks the agent uses,
  // and wait on a card posted where the person asked.
  const propose = async actions => {
    const { validateActions } = require('./validate');
    const suggestions = require('./suggestions');
    state.snapshot = state.snapshot || await require('./context').buildSnapshot(prisma);
    const { accepted, dropped } = validateActions(actions, { snapshot: state.snapshot, labels: new Map([['m1', state.message]]) });
    const { stored, skipped } = await suggestions.storeSuggestions(prisma, accepted, {
      batchId: null,
      evidenceFor: () => [{
        messageId: state.message.id, channelId: state.message.channelId, url: state.sourceUrl, authorName: state.author.name,
        authorDiscordId: state.author.discordId, postedAt: new Date(state.message.postedAt || Date.now()).toISOString(),
        excerpt: String(state.message.content || '').slice(0, 240),
      }],
    });
    if (stored.length) {
      // The card goes where the person asked, not to the review channel as well.
      await prisma.$executeRawUnsafe(`UPDATE "AssetAgentSuggestion" SET "needsDiscordPost" = false WHERE id = ANY($1::text[])`, stored.map(s => s.id));
      state.proposals.push(...stored);
    }
    return {
      awaiting_approval: stored.map(s => s.summary),
      not_proposed: [...dropped.map(d => d.why), ...skipped.map(s => `${s.action.summary}: ${s.why}`)],
      note: stored.length ? 'A confirmation card with Accept and Reject is posted under your reply. Nothing has changed yet.' : 'Nothing was proposed.',
    };
  };
  const asked = { confidence: 1, reason: `Asked for by ${state.author.name || 'an admin'} in Discord`, evidence: ['m1'] };

  if (name === 'propose_expenses') {
    const revenue = require('../../revenue/sync');
    const prepared = await revenue.prepareExpenses(prisma, {
      description: input.description, category: input.category, date: input.date, entries: input.payments, splitBetween: input.split_between,
    });
    if (prepared.error) return prepared;
    // Not a tracker change, so it skips the tracker checks; the same list asked for twice is still caught as already pending.
    const key = `log_expenses:${require('crypto').createHash('sha1').update(JSON.stringify([prepared.payload.description, prepared.payload.date, prepared.payload.entries.map(e => [e.name.toLowerCase(), e.amount])])).digest('hex').slice(0, 24)}`;
    const { stored, skipped } = await require('./suggestions').storeSuggestions(prisma, [{
      type: 'log_expenses', confidence: 1, reason: asked.reason, evidence: ['m1'],
      payload: prepared.payload, before: null, after: prepared.after, summary: prepared.summary, dedupeKey: key,
    }], {
      batchId: null,
      evidenceFor: () => [{
        messageId: state.message.id, channelId: state.message.channelId, url: state.sourceUrl, authorName: state.author.name,
        authorDiscordId: state.author.discordId, postedAt: new Date(state.message.postedAt || Date.now()).toISOString(),
        excerpt: String(state.message.content || '').slice(0, 240),
      }],
    });
    if (stored.length) {
      await prisma.$executeRawUnsafe(`UPDATE "AssetAgentSuggestion" SET "needsDiscordPost" = false WHERE id = ANY($1::text[])`, stored.map(s => s.id));
      state.proposals.push(...stored);
    }
    return {
      awaiting_approval: stored.map(s => s.summary),
      not_proposed: skipped.map(s => (s.why === 'already pending' ? 'This exact list is already waiting on a card.' : `This exact list was ${s.why}.`)),
      payments: prepared.payload.entries.length, total_robux: prepared.payload.total, category: prepared.payload.category,
      split_between: prepared.payload.audience, things_to_mention: prepared.notes,
      note: stored.length ? 'One confirmation card listing every payment is posted under your reply. Nothing is logged until an approved admin presses Accept.' : 'Nothing was proposed.',
    };
  }

  if (name === 'propose_new_item') {
    state.snapshot = state.snapshot || await require('./context').buildSnapshot(prisma);
    const types = state.snapshot.contentTypes;
    const type = findByName(types, input.content_type, t => [t.name]);
    const result = await propose([{
      ...asked, type: 'create_content_item', task_ref: '',
      item_internal_name: String(input.name || '').trim(), display_name: String(input.display_name || '').trim(),
      content_type: type?.name || String(input.content_type || ''), update_number: String(input.update_number || ''),
    }]);
    if (!result.awaiting_approval.length) {
      result.content_types = types.map(t => t.name);
      result.open_updates = state.snapshot.openUpdates.map(u => `${u.number} ${u.name} (${u.status})`);
    }
    return result;
  }
  if (name === 'propose_task_change') {
    const ref = String(input.task_ref || '').replace(/^#/, '');
    const common = { ...asked, task_ref: ref };
    const actions = [];
    if (input.status === 'Blocked') {
      if (!String(input.blocked_reason || '').trim()) return { error: 'A blocked task needs a reason. Ask what it is waiting on.' };
      actions.push({ ...common, type: 'mark_blocked', blocker_reason: input.blocked_reason });
    } else if (input.status) actions.push({ ...common, type: 'update_task_status', status: input.status });
    if (input.assignee) actions.push({ ...common, type: 'assign_task', assignee: findDev(ctx.devs, input.assignee)?.name || input.assignee });
    if (input.due_date) actions.push({ ...common, type: 'set_due_date', due_date: input.due_date });
    if (input.note) actions.push({ ...common, type: 'add_task_note', note: input.note });
    if (!actions.length) return { error: 'Say what to change: a status, an assignee, a due date or a note.' };

    return propose(actions);
  }
  if (name === 'get_payments') {
    // Roster names and payee names are kept separately; try the name as typed, then the roster's spelling.
    const revenue = require('../../revenue/sync');
    let result = await revenue.paymentsTo(prisma, { name: input.name, text: input.text, limit: input.limit });
    const dev = input.name ? findDev(ctx.devs, input.name) : null;
    if (result.error && dev && dev.name !== input.name) result = await revenue.paymentsTo(prisma, { name: dev.name, text: input.text, limit: input.limit });
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
  const [allUpdates, allTypes] = await Promise.all([q.listUpdates(prisma), q.listContentTypes(prisma)]);
  const updates = allUpdates.filter(u => !['Released', 'Cancelled'].includes(u.status)).map(u => `${u.number} ${u.name} (${u.status})`).join(', ');
  const typeNames = allTypes.filter(t => t.active).map(t => t.name).join(', ');
  const place = ctx.devs.find(d => d.discordThreadId && [message.channelId, message.parentChannelId].map(String).includes(d.discordThreadId));
  const system = [
    { type: 'text', text: systemPrompt() },
    { type: 'text', text: `CONTENT ITEMS: ${itemNames || 'none yet'}\n\nROSTER: ${roster || 'nobody yet'}\n\nUPDATES: ${updates || 'none yet'}\n\nCONTENT TYPES: ${typeNames || 'none yet'}` },
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
    proposals: [],
    message,
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
  return { reply: (reply || 'I have nothing to add.').slice(0, 1900), notes: state.notes, proposals: state.proposals, costUsd: settingsStore.costOf(model, usage) };
}

module.exports = {
  getSettings, saveSettings, normalizeSettings,
  indexFiles, indexContext, backfillFiles, searchFiles, matchItem, findItem, findDev, findUpdate, kindOf,
  listNotes, saveNote, respond, TOOLS,
};
