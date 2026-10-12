// personal.js
// The owner's private side of the assistant: notes and reminders that only
// one Discord account can write or read. They are kept apart from the asset
// notes (which the team sees on the Assets page) and are only ever returned
// to that account, in a DM or a reply only they can see.
//
// The account is PERSONAL_OWNER_DISCORD_ID. With it unset, none of this is on.

const crypto = require('crypto');

const TZ = () => process.env.PERSONAL_TIMEZONE || 'America/New_York';
const REPEATS = ['daily', 'weekdays', 'weekly', 'monthly'];

class PersonalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ownerId = () => String(process.env.PERSONAL_OWNER_DISCORD_ID || '').trim();
const isOwner = discordId => !!ownerId() && String(discordId || '') === ownerId();

const ready = new WeakSet();
async function ensureTables(prisma) {
  if (ready.has(prisma)) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PersonalNote" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "ref" SERIAL,
      "ownerId" TEXT NOT NULL,
      "text" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PersonalReminder" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "ref" SERIAL,
      "ownerId" TEXT NOT NULL,
      "text" TEXT NOT NULL,
      "dueAt" TIMESTAMP(3) NOT NULL,
      "repeat" TEXT,
      "status" TEXT NOT NULL DEFAULT 'pending',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "lastSentAt" TIMESTAMP(3)
    )`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PersonalReminder_due_idx" ON "PersonalReminder" ("status", "dueAt")`);
  ready.add(prisma);
}

// ── time ──────────────────────────────────────────────────────────────────────
// Reminders are said and shown in the owner's wall-clock time and stored in UTC.

function localParts(date, tz = TZ()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: parts.weekday };
}
const localText = (date, tz = TZ()) => { const p = localParts(date, tz); return `${p.weekday} ${p.date} ${p.time}`; };

// "2026-10-16 15:00" in the owner's timezone -> the UTC instant. Daylight saving is handled by the zone, not a fixed offset.
function parseLocal(text, tz = TZ()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // Start from that wall time read as UTC, then correct by how far the zone's reading of it is off. Twice settles the DST edges.
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const [py, pmo, pd] = p.date.split('-').map(Number);
    const [ph, pmi] = p.time.split(':').map(Number);
    guess += wanted - Date.UTC(py, pmo - 1, pd, ph, pmi);
  }
  return new Date(guess);
}

// The next time a repeating reminder is due after `from`, at the same wall-clock time.
function nextDue(dueAt, repeat, from = new Date(), tz = TZ()) {
  const p = localParts(dueAt, tz);
  let [y, mo, d] = p.date.split('-').map(Number);
  const step = () => {
    if (repeat === 'monthly') { mo += 1; if (mo > 12) { mo = 1; y += 1; } return; }
    const next = new Date(Date.UTC(y, mo - 1, d + (repeat === 'weekly' ? 7 : 1)));
    [y, mo, d] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
  };
  for (let i = 0; i < 800; i++) {
    step();
    // A month without that day (the 31st) lands on its last day.
    const day = Math.min(d, new Date(Date.UTC(y, mo, 0)).getUTCDate());
    const candidate = parseLocal(`${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')} ${p.time}`, tz);
    const weekday = new Date(Date.UTC(y, mo - 1, day)).getUTCDay();
    if (repeat === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (candidate > from) return candidate;
  }
  return null;
}

// ── notes ─────────────────────────────────────────────────────────────────────

async function saveNote(prisma, owner, text) {
  await ensureTables(prisma);
  const body = String(text || '').trim().slice(0, 4000);
  if (!body) throw new PersonalError(400, 'The note is empty.');
  const id = crypto.randomUUID();
  const [row] = await prisma.$queryRawUnsafe(
    `INSERT INTO "PersonalNote" ("id", "ownerId", "text") VALUES ($1, $2, $3) RETURNING ref, text, "createdAt"`, id, String(owner), body);
  return row;
}

// Newest first. With words, notes holding more of them come first.
async function searchNotes(prisma, owner, { text, limit = 12 } = {}) {
  await ensureTables(prisma);
  const words = [...new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3))].slice(0, 8);
  const cap = Math.min(40, Math.max(1, Number(limit) || 12));
  if (!words.length) {
    return prisma.$queryRawUnsafe(`SELECT ref, text, "createdAt" FROM "PersonalNote" WHERE "ownerId" = $1 ORDER BY "createdAt" DESC, ref DESC LIMIT ${cap}`, String(owner));
  }
  const score = words.map((_, i) => `(CASE WHEN lower(text) LIKE '%' || $${i + 2} || '%' THEN 1 ELSE 0 END)`).join(' + ');
  return prisma.$queryRawUnsafe(
    `SELECT ref, text, "createdAt" FROM (SELECT ref, text, "createdAt", ${score} AS hits FROM "PersonalNote" WHERE "ownerId" = $1) n
     WHERE hits > 0 ORDER BY hits DESC, "createdAt" DESC, ref DESC LIMIT ${cap}`, String(owner), ...words);
}

async function deleteNote(prisma, owner, ref) {
  await ensureTables(prisma);
  const gone = await prisma.$queryRawUnsafe(`DELETE FROM "PersonalNote" WHERE "ownerId" = $1 AND ref = $2 RETURNING text`, String(owner), Number(ref) || 0);
  if (!gone.length) throw new PersonalError(404, `There is no note ${ref}.`);
  return gone[0];
}

// ── reminders ─────────────────────────────────────────────────────────────────

const REMINDER_FIELDS = `ref, text, "dueAt", repeat, status`;
const shown = r => ({ ref: r.ref, text: r.text, due: localText(r.dueAt), repeat: r.repeat || undefined, status: r.status === 'pending' ? undefined : r.status });

async function addReminder(prisma, owner, { text, dueLocal, repeat } = {}, now = new Date()) {
  await ensureTables(prisma);
  const body = String(text || '').trim().slice(0, 1000);
  if (!body) throw new PersonalError(400, 'Say what the reminder is for.');
  const dueAt = parseLocal(dueLocal);
  if (!dueAt) throw new PersonalError(400, `"${dueLocal}" is not a time. Use YYYY-MM-DD HH:MM in 24-hour time.`);
  const every = repeat ? String(repeat).toLowerCase() : null;
  if (every && !REPEATS.includes(every)) throw new PersonalError(400, `Repeat must be one of: ${REPEATS.join(', ')}.`);
  if (dueAt <= now && !every) throw new PersonalError(400, `${localText(dueAt)} has already passed. It is now ${localText(now)}.`);
  const first = dueAt <= now ? nextDue(dueAt, every, now) : dueAt;
  const [row] = await prisma.$queryRawUnsafe(
    `INSERT INTO "PersonalReminder" ("id", "ownerId", "text", "dueAt", "repeat") VALUES ($1, $2, $3, $4::timestamp, $5) RETURNING ${REMINDER_FIELDS}`,
    crypto.randomUUID(), String(owner), body, first.toISOString(), every);
  return row;
}

async function listReminders(prisma, owner) {
  await ensureTables(prisma);
  return prisma.$queryRawUnsafe(`SELECT ${REMINDER_FIELDS} FROM "PersonalReminder" WHERE "ownerId" = $1 AND status = 'pending' ORDER BY "dueAt", ref LIMIT 50`, String(owner));
}

async function cancelReminder(prisma, owner, ref) {
  await ensureTables(prisma);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE "PersonalReminder" SET status = 'cancelled' WHERE "ownerId" = $1 AND ref = $2 AND status = 'pending' RETURNING ${REMINDER_FIELDS}`, String(owner), Number(ref) || 0);
  if (!rows.length) throw new PersonalError(404, `There is no pending reminder ${ref}.`);
  return rows[0];
}

// Reminders that are due. Each is handed out once: a one-off is finished, a
// repeating one moves to its next time. The bot calls this every minute.
async function claimDue(prisma, now = new Date()) {
  if (!ownerId()) return [];
  await ensureTables(prisma);
  const due = await prisma.$queryRawUnsafe(
    `SELECT id, ${REMINDER_FIELDS} FROM "PersonalReminder" WHERE "ownerId" = $1 AND status = 'pending' AND "dueAt" <= $2::timestamp ORDER BY "dueAt" LIMIT 20`,
    ownerId(), now.toISOString());
  const out = [];
  for (const r of due) {
    const next = r.repeat ? nextDue(r.dueAt, r.repeat, now) : null;
    const claimed = await prisma.$executeRawUnsafe(
      `UPDATE "PersonalReminder" SET status = $2, "dueAt" = $3::timestamp, "lastSentAt" = $4::timestamp WHERE id = $1 AND status = 'pending' AND "dueAt" <= $4::timestamp`,
      r.id, next ? 'pending' : 'sent', (next || r.dueAt).toISOString(), now.toISOString());
    if (claimed) out.push({ ref: r.ref, text: r.text, due: localText(r.dueAt), repeat: r.repeat || null, next: next ? localText(next) : null });
  }
  return out;
}

// ── for the assistant ────────────────────────────────────────────────────────

const str = description => ({ type: 'string', description });
const TOOLS = [
  {
    name: 'save_private_note',
    description: "Save a private note for the owner. Only they can ever read it back. Use it when they tell you to note, remember or jot something down in a personal way, or when they are talking to you in private and say \"note\".",
    input_schema: { type: 'object', properties: { text: str('The note, complete enough to make sense on its own later.') }, required: ['text'] },
  },
  {
    name: 'search_private_notes',
    description: "The owner's private notes, newest first. Pass words to find notes about something; pass nothing for the most recent ones.",
    input_schema: { type: 'object', properties: { text: str('Words to look for. Optional.'), limit: { type: 'integer', description: 'How many, 1 to 40. Default 12.' } } },
  },
  {
    name: 'delete_private_note',
    description: 'Delete one private note by its number, when the owner asks for that.',
    input_schema: { type: 'object', properties: { ref: { type: 'integer', description: 'The note number from search_private_notes.' } }, required: ['ref'] },
  },
  {
    name: 'set_reminder',
    description: "Set a reminder. The owner gets a direct message from the bot at that time. Work out the date and time from what they said and the current local time you were given.",
    input_schema: {
      type: 'object',
      properties: {
        text: str('What to remind them of, written as the reminder they will read.'),
        due_local: str('When, in their local time, as YYYY-MM-DD HH:MM in 24-hour time. For a repeating reminder, the first time.'),
        repeat: { type: 'string', enum: REPEATS, description: 'Only when they asked for it to repeat.' },
      },
      required: ['text', 'due_local'],
    },
  },
  { name: 'list_reminders', description: "The owner's pending reminders, soonest first.", input_schema: { type: 'object', properties: {} } },
  {
    name: 'cancel_reminder',
    description: 'Cancel one pending reminder by its number. Find the number with list_reminders first.',
    input_schema: { type: 'object', properties: { ref: { type: 'integer', description: 'The reminder number.' } }, required: ['ref'] },
  },
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

const PROMPT = `
PRIVATE MODE. You are talking with the owner alone (a direct message, or a command only they can use). In this mode you are also their personal assistant:

- They can keep private notes with you ("note that...", "remember...", "jot down..."). In private mode a note is private unless it is plainly about a tracked asset file or task and they ask for it on the asset log. Save with \`save_private_note\` and confirm in one line.
- When they ask what they noted, or ask a question their notes might answer, look with \`search_private_notes\`. For anything about the game's assets, updates, devs or payments, use the asset tools as usual. If a question could be answered by either, check both and say which each fact came from.
- Reminders: "remind me Friday at 3 to pay the testers" becomes \`set_reminder\`. Times are US Eastern, their local time; you are told the current local time and weekday. "Tomorrow" with no time means 9:00. "Tonight" means 20:00. A bare "at 3" means the next 3 that makes sense in the daytime (15:00). If the time is truly unclear, ask. After setting one, confirm the exact day, date and time. Use \`list_reminders\` and \`cancel_reminder\` for "what reminders do I have" and "cancel the testers one".
- Money actions (logging expenses) and tracker changes work here the same way: they still go on a confirmation card that the owner accepts.
- Keep replies short. Never mention private notes or reminders outside private mode.`;

async function runTool(prisma, owner, name, input) {
  try {
    if (name === 'save_private_note') { const n = await saveNote(prisma, owner, input.text); return { saved: true, note_number: n.ref }; }
    if (name === 'search_private_notes') {
      const notes = await searchNotes(prisma, owner, input);
      return { count: notes.length, notes: notes.map(n => ({ number: n.ref, text: n.text, written: localText(n.createdAt) })) };
    }
    if (name === 'delete_private_note') { const n = await deleteNote(prisma, owner, input.ref); return { deleted: true, text: n.text.slice(0, 200) }; }
    if (name === 'set_reminder') return { set: true, reminder: shown(await addReminder(prisma, owner, { text: input.text, dueLocal: input.due_local, repeat: input.repeat })) };
    if (name === 'list_reminders') { const list = await listReminders(prisma, owner); return { count: list.length, reminders: list.map(shown) }; }
    if (name === 'cancel_reminder') return { cancelled: true, reminder: shown(await cancelReminder(prisma, owner, input.ref)) };
  } catch (err) {
    if (err instanceof PersonalError) return { error: err.message };
    throw err;
  }
  return { error: `Unknown tool ${name}` };
}

module.exports = {
  PersonalError, ownerId, isOwner, ensureTables, TZ, REPEATS,
  localParts, localText, parseLocal, nextDue,
  saveNote, searchNotes, deleteNote, addReminder, listReminders, cancelReminder, claimDue,
  TOOLS, TOOL_NAMES, PROMPT, runTool,
};
