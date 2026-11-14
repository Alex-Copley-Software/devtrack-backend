// triage.js
// Discord for the Assets board.
//
// Messages: the bot sends every message posted in the channels the board reads
// (each dev's place on the Developers page, and any channel picked in the board's
// settings) to addMessage(), images and all.
//
// Updates: every few hours (settings.triageHours), or when asked, Claude goes
// through the new messages against the board and suggests what to change: a task
// finished, started (by whom), back to untasked, a note to keep, or a question that
// needs an answer. They wait on the page as a list to go through; nothing changes
// on the board until it's applied there.
//
// Check-ins: once a day (settings.digestHour, in settings.timezone) the owner gets
// a DM listing the in-progress tasks nobody has heard about for settings.checkInDays,
// and how many updates are waiting.

const Anthropic = require('@anthropic-ai/sdk');
const { getPrisma, newId } = require('../assets/db');
const { fetchWithFreshConnection } = require('../fresh-fetch');
const notifier = require('../discord-notifier');
const devs = require('../devs');
const B = require('./board');

const MODEL = () => process.env.BOARD_MODEL || 'claude-opus-5-5';
const ACTIONS = ['mark_done', 'mark_in_progress', 'mark_untasked', 'add_note', 'needs_reply', 'progress_update'];
const MAX_BATCH = 250;
const DASHBOARD = () => (process.env.DASHBOARD_URL || 'https://lambent-lily-7bf643.netlify.app').replace(/\/+$/, '');

const json = v => (typeof v === 'string' ? JSON.parse(v) : v);

// ── messages from Discord ──

// The channels (and categories, forums) the bot should read.
async function watchList(prisma = getPrisma()) {
  const s = await B.settings(prisma);
  const ids = new Set(s.extraChannels);
  if (s.readDevPlaces) for (const d of await devs.list(prisma)) if (d.channelId) ids.add(d.channelId);
  return [...ids];
}

const snowflake = v => /^\d{15,22}$/.test(String(v || ''));
const MAX_IMAGES = 5;
const MAX_IMAGE = 6 * 1024 * 1024;

// m: { id, channelId, threadId, place, authorId, authorName, content, url, postedAt,
//      attachments: [{ name, url, contentType, size, width, height }] }
async function addMessage(m, prisma = getPrisma(), download = fetch) {
  await B.ensureSchema(prisma);
  if (!snowflake(m?.id) || !snowflake(m.channelId)) throw new B.BoardError(400, 'id and channelId are required');
  const [seen] = await prisma.$queryRawUnsafe(`SELECT id FROM "BoardMessage" WHERE id = $1`, m.id);
  if (seen) return { id: m.id, duplicate: true };
  const attachments = [];
  for (const a of (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 10)) {
    const att = { name: String(a.name || 'file').slice(0, 120), url: String(a.url || ''), contentType: a.contentType || null, size: Number(a.size) || null };
    // Discord's links expire after a day; images are kept so they can still be seen and used as references.
    if (/^image\//.test(att.contentType || '') && att.size && att.size <= MAX_IMAGE && attachments.filter(x => x.imageId).length < MAX_IMAGES) {
      try {
        const res = await download(att.url, { signal: AbortSignal.timeout(30000) });
        if (res.ok) {
          const saved = await B.addImage({ kind: 'msg', data: Buffer.from(await res.arrayBuffer()), width: a.width, height: a.height, caption: att.name, sourceUrl: m.url }, prisma);
          att.imageId = saved.id;
          att.imageUrl = saved.url;
        }
      } catch (err) { console.error('[Board] Could not keep an image from Discord:', err.message); }
    }
    attachments.push(att);
  }
  await prisma.$executeRawUnsafe(`INSERT INTO "BoardMessage" (id, "channelId", "threadId", place, "authorId", "authorName", content, attachments, url, "postedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) ON CONFLICT (id) DO NOTHING`,
  m.id, m.channelId, snowflake(m.threadId) ? m.threadId : null, String(m.place || '').slice(0, 200), String(m.authorId || ''),
  String(m.authorName || '').slice(0, 100), String(m.content || '').slice(0, 4000), JSON.stringify(attachments), m.url || null,
  m.postedAt ? new Date(m.postedAt) : new Date());
  return { id: m.id, images: attachments.filter(a => a.imageId).length };
}

// ── going through them ──

const SYSTEM = `You help Alex, who runs asset production for a Roblox game, keep the asset board up to date.
The board lists cards (mostly units: characters) and their tasks (Animations, Mesh, Texture, Aura, Icons, VFX, Cosmetic...), some with subtasks of their own (Icons › Equipment, Texture › Shiny...), each Untasked, In progress (with the developer doing it) or Done.
You get the board as it stands and the developers' recent Discord messages. Suggest the changes the messages clearly support, for Alex to approve:
- mark_done: the developer says a task is finished or posts its final files.
- mark_in_progress: a developer says they have started a task that is Untasked (dev: their name exactly as on the roster).
- mark_untasked: a developer says they have stopped or dropped a task.
- add_note: something worth keeping on a task: an ETA, a requirement, feedback, a decision.
- needs_reply: a question, request or blocker that needs Alex's answer.
- progress_update: work in progress on a task (a screenshot, "almost done", "working on the shading").
Rules: refer to people by name; never assume anyone's gender (no he/she). Use only issue identifiers from the board ("ASS-40"), or "" when no task fits (needs_reply only). Put all messages about the same task in one suggestion. Skip greetings, chatter and anything that changes nothing. Don't suggest a status a task already has. summary: one short plain sentence to Alex, naming the developer and the unit, e.g. "Ruku says the Rukia texture is finished and posted 2 images." confidence: how sure you are the messages mean this.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['message_ids', 'issue', 'action', 'dev', 'summary', 'confidence'],
        properties: {
          message_ids: { type: 'array', items: { type: 'string' }, description: 'The [ids] of the messages this comes from' },
          issue: { type: 'string', description: 'The task identifier, e.g. ASS-40, or "" when none fits' },
          action: { type: 'string', enum: ACTIONS },
          dev: { type: 'string', description: 'For mark_in_progress, the roster name; else ""' },
          summary: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

let client = null;
function claude() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, fetch: fetchWithFreshConnection });
  return client;
}

// One call: the board and the messages in, { suggestions } out (structured output, strict schema).
async function askClaude(userText) {
  const res = await claude().beta.messages.create({
    model: MODEL(),
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // on a policy decline the API re-runs the request on a fallback model
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: userText }],
  });
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined this batch (${res.stop_details?.category || 'no category'})`);
  if (res.stop_reason === 'max_tokens') throw new Error('Claude ran out of room on this batch');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return { ...JSON.parse(text), model: res.model, usage: res.usage };
}

const day = d => new Date(d).toISOString().slice(0, 10);

function boardText(b) {
  const lines = ['BOARD (identifier | card › task | status | developer | in progress since)'];
  for (const u of b.cards) {
    for (const t of u.tasks) {
      for (const x of [t, ...t.subtasks]) {
        const label = x === t ? t.name : `${t.name} › ${x.name}`;
        lines.push(`${x.identifier} | ${u.name} › ${label} | ${x.status.replace('_', ' ')} | ${x.devName || '-'} | ${x.status === 'in_progress' && x.startedAt ? day(x.startedAt) : '-'}`);
      }
    }
  }
  lines.push('', 'ROSTER (developer | Discord id)', ...b.devs.map(d => `${d.name} | ${d.discordUserId || '-'}`));
  return lines.join('\n');
}

function messagesText(msgs) {
  return ['MESSAGES', ...msgs.map(m => {
    const files = json(m.attachments).map(a => a.name).join(', ');
    return `[${m.id}] ${new Date(m.postedAt).toISOString().slice(0, 16).replace('T', ' ')} ${m.place ? `#${m.place} ` : ''}${m.authorName} (${m.authorId}): ${(m.content || '').replace(/\s+/g, ' ').slice(0, 1200)}${files ? ` [files: ${files}]` : ''}`;
  })].join('\n');
}

let running = null;
async function triage(prisma = getPrisma(), ask = askClaude) {
  if (running) return running;
  running = (async () => {
    await B.ensureSchema(prisma);
    const msgs = await prisma.$queryRawUnsafe(`SELECT * FROM "BoardMessage" WHERE "triagedAt" IS NULL ORDER BY "postedAt" LIMIT ${MAX_BATCH}`);
    const started = new Date();
    if (!msgs.length) {
      await B.setMeta('triage', { at: started, messages: 0, suggestions: 0, error: null }, prisma);
      return { messages: 0, suggestions: 0 };
    }
    const b = await B.board(prisma);
    const ids = new Set(msgs.map(m => m.id));
    const byIdent = new Map(b.cards.flatMap(u => u.tasks.flatMap(t => [t, ...t.subtasks])).map(x => [x.identifier, x]));
    const roster = new Set(b.devs.map(d => d.name));
    let suggestions = [], error = null, model = null;
    try {
      const out = await ask(`${boardText(b)}\n\n${messagesText(msgs)}`);
      model = out.model;
      suggestions = (out.suggestions || []).map(s => ({
        ...s, message_ids: (s.message_ids || []).filter(id => ids.has(id)),
        issue: byIdent.has(s.issue) ? s.issue : '', dev: roster.has(s.dev) ? s.dev : '',
      })).filter(s => ACTIONS.includes(s.action) && s.message_ids.length && (s.issue || s.action === 'needs_reply')
        && !(s.action === 'mark_in_progress' && !s.dev));
    } catch (err) {
      // Without Claude the messages still reach the list: one item per person per place, to read through.
      error = err.message;
      console.error('[Board] Going through messages failed:', err.message);
      const groups = new Map();
      for (const m of msgs) {
        const k = `${m.authorId}:${m.threadId || m.channelId}`;
        groups.set(k, [...(groups.get(k) || []), m]);
      }
      suggestions = [...groups.values()].map(g => ({
        message_ids: g.map(m => m.id), issue: '', action: 'needs_reply', dev: '', confidence: 'low',
        summary: `${g[0].authorName}${g[0].place ? ` in #${g[0].place}` : ''}: ${(g.at(-1).content || '(files)').replace(/\s+/g, ' ').slice(0, 180)}`,
      }));
    }
    for (const s of suggestions) {
      const task = s.issue ? byIdent.get(s.issue) : null;
      await prisma.$executeRawUnsafe(`INSERT INTO "BoardSuggestion" (id, "issueId", action, dev, summary, confidence, "messageIds")
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`, newId(), task?.id || null, s.action, s.dev || null, String(s.summary).slice(0, 500),
      s.confidence, JSON.stringify(s.message_ids));
      // A message about a task is news of it: the check-in clock starts again.
      if (task) {
        const first = msgs.find(m => m.id === s.message_ids[0]);
        await B.addActivity(task.id, 'discord', { text: s.summary, url: first?.url, by: first?.authorName, at: msgs.filter(m => s.message_ids.includes(m.id)).map(m => m.postedAt).sort().at(-1) }, prisma);
      }
    }
    await prisma.$executeRawUnsafe(`UPDATE "BoardMessage" SET "triagedAt" = now() WHERE id = ANY($1::text[])`, [...ids]);
    await B.setMeta('triage', { at: started, messages: msgs.length, suggestions: suggestions.length, error, model }, prisma);
    console.log(`[Board] Went through ${msgs.length} message(s): ${suggestions.length} update(s) to look at${error ? ' (without Claude)' : ''}`);
    return { messages: msgs.length, suggestions: suggestions.length, error };
  })().finally(() => { running = null; });
  return running;
}

// ── the list on the page ──

async function inbox(prisma = getPrisma()) {
  await B.ensureSchema(prisma);
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "BoardSuggestion" WHERE status = 'open' ORDER BY "createdAt" DESC LIMIT 300`);
  const msgIds = [...new Set(rows.flatMap(r => json(r.messageIds)))];
  const msgs = msgIds.length ? await prisma.$queryRawUnsafe(`SELECT id, place, "authorName", content, attachments, url, "postedAt" FROM "BoardMessage" WHERE id = ANY($1::text[])`, msgIds) : [];
  const byId = new Map(msgs.map(m => [m.id, m]));
  return {
    triage: await B.getMeta('triage', prisma),
    items: rows.map(r => ({
      id: r.id, issueId: r.issueId, action: r.action, dev: r.dev, summary: r.summary, confidence: r.confidence, createdAt: r.createdAt,
      messages: json(r.messageIds).map(id => byId.get(id)).filter(Boolean).map(m => ({
        id: m.id, place: m.place, author: m.authorName, text: m.content, url: m.url, at: m.postedAt,
        files: json(m.attachments).map(a => ({ name: a.name, imageId: a.imageId || null, imageUrl: a.imageUrl || null })),
      })),
    })),
  };
}

// Apply: a status, or a note onto the task; either way it leaves the list.
async function decide(id, decision, by, prisma = getPrisma(), opts = {}) {
  await B.ensureSchema(prisma);
  const [s] = await prisma.$queryRawUnsafe(`SELECT * FROM "BoardSuggestion" WHERE id = $1`, id);
  if (!s) throw new B.BoardError(404, 'No such update');
  if (s.status !== 'open') throw new B.BoardError(409, 'Already done');
  if (decision === 'apply') {
    const status = { mark_done: 'done', mark_in_progress: 'in_progress', mark_untasked: 'untasked' }[s.action];
    if (status) {
      if (!s.issueId) throw new B.BoardError(400, 'This update is not tied to a task');
      let devId = opts.devId;
      if (status === 'in_progress' && !devId) {
        const { byName } = await B.roster(prisma);
        devId = byName.get(String(s.dev || '').toLowerCase())?.id;
      }
      await B.setStatus(s.issueId, status, devId, by, prisma);
    } else if (s.action === 'add_note' && s.issueId) {
      const [cur] = await prisma.$queryRawUnsafe(`SELECT text FROM "BoardNote" WHERE "issueId" = $1`, s.issueId);
      const [m] = await prisma.$queryRawUnsafe(`SELECT url FROM "BoardMessage" WHERE id = $1`, json(s.messageIds)[0] || '');
      const line = `${new Date().toISOString().slice(0, 10)}: ${s.summary}${m?.url ? ` (${m.url})` : ''}`;
      await B.setNotes(s.issueId, cur?.text ? `${cur.text.trimEnd()}\n${line}` : line, by, prisma);
    }
  } else if (decision !== 'dismiss') {
    throw new B.BoardError(400, 'decision must be apply or dismiss');
  }
  await prisma.$executeRawUnsafe(`UPDATE "BoardSuggestion" SET status = $2, "decidedBy" = $3, "decidedAt" = now() WHERE id = $1`,
    id, decision === 'apply' ? 'applied' : 'dismissed', by || null);
}

// ── the daily check-in DM ──

// The local date and hour in a time zone.
function localNow(tz, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

async function digest(prisma = getPrisma(), send = notifier.boardDigest, now = new Date(), force = false) {
  const s = await B.settings(prisma);
  const local = localNow(s.timezone, now);
  const lastSent = await B.getMeta('digest', prisma);
  if (!force && (!s.digestDm || local.hour < s.digestHour || lastSent?.date === local.date)) return null;
  const b = await B.board(prisma, now);
  const stale = b.cards.flatMap(u => u.tasks.flatMap(t => [t, ...t.subtasks].filter(x => x.needsCheckin).map(x => ({
    unit: u.name, task: x === t ? t.name : `${t.name} › ${x.name}`, dev: x.devName, days: Math.floor(x.quietDays),
    url: `${DASHBOARD()}/assets/?item=${encodeURIComponent(x.identifier)}`,
  })))).sort((a, b2) => b2.days - a.days);
  const payload = { date: local.date, stale, updates: b.inbox.open, url: `${DASHBOARD()}/assets/?show=checkin`, updatesUrl: `${DASHBOARD()}/assets/?show=updates` };
  await B.setMeta('digest', { date: local.date, at: now, stale: stale.length, updates: b.inbox.open }, prisma);
  if (!stale.length && !b.inbox.open) return { ...payload, sent: false };
  await send(payload);
  return { ...payload, sent: true };
}

let timers = [];
function start() {
  if (timers.length) return;
  // Updates: on the hour mark set in the settings, measured from the last run.
  timers.push(setInterval(async () => {
    try {
      const s = await B.settings();
      const last = await B.getMeta('triage');
      if (!last?.at || Date.now() - new Date(last.at) >= s.triageHours * 3600000) await triage();
    } catch (err) { console.error('[Board] Updates check failed:', err.message); }
  }, 10 * 60 * 1000));
  timers.push(setInterval(() => digest().catch(err => console.error('[Board] Daily check-in failed:', err.message)), 10 * 60 * 1000));
}

module.exports = { watchList, addMessage, triage, inbox, decide, digest, localNow, start, boardText, SCHEMA, ACTIONS };
