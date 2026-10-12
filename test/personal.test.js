// The owner's private notes and reminders, and the private mode of the assistant.

const test = require('node:test');
const assert = require('node:assert/strict');

const OWNER = '333333333333333333';
const ADMIN = '111111111111111111';
process.env.PERSONAL_OWNER_DISCORD_ID = OWNER;
const { createTestDb, seedBasics } = require('./assets/helpers');
const personal = require('../src/personal');
const assistant = require('../src/assets/agent/assistant');

const at = local => personal.parseLocal(local);

test('times are US Eastern wall-clock, through daylight saving', () => {
  assert.equal(at('2026-10-16 15:00').toISOString(), '2026-10-16T19:00:00.000Z');   // EDT
  assert.equal(at('2026-12-01 09:00').toISOString(), '2026-12-01T14:00:00.000Z');   // EST
  assert.equal(personal.localText(at('2026-10-16 15:00')), 'Friday 2026-10-16 15:00');
  for (const bad of ['tomorrow', '2026-13-01 09:00', '2026-10-16 25:00', '']) assert.equal(personal.parseLocal(bad), null);

  // Repeats keep the wall-clock time across the clocks going back on 2026-11-01.
  assert.equal(personal.localText(personal.nextDue(at('2026-10-26 08:00'), 'weekly', at('2026-10-26 08:00'))), 'Monday 2026-11-02 08:00');
  assert.equal(personal.localText(personal.nextDue(at('2026-10-30 09:00'), 'weekdays', at('2026-10-30 09:00'))), 'Monday 2026-11-02 09:00');
  assert.equal(personal.localText(personal.nextDue(at('2026-10-30 09:00'), 'daily', at('2026-10-30 09:00'))), 'Saturday 2026-10-31 09:00');
  assert.equal(personal.localText(personal.nextDue(at('2026-01-31 10:00'), 'monthly', at('2026-01-31 10:00'))), 'Saturday 2026-02-28 10:00');
  // A reminder missed for days (the bot was down) moves to the next time still ahead, not one in the past.
  assert.equal(personal.localText(personal.nextDue(at('2026-10-05 09:00'), 'daily', at('2026-10-09 12:00'))), 'Saturday 2026-10-10 09:00');
});

test('notes are kept per owner and found by their words', async () => {
  const prisma = await createTestDb();
  await personal.saveNote(prisma, OWNER, 'Ruku wants 40k for the next rig');
  await personal.saveNote(prisma, OWNER, 'Ask Dana about the Halloween trailer');
  await personal.saveNote(prisma, OWNER, 'Ruku rig is due after the trailer');
  await personal.saveNote(prisma, 'someone-else', 'Ruku secret');
  await assert.rejects(personal.saveNote(prisma, OWNER, '   '), /empty/);

  assert.deepEqual((await personal.searchNotes(prisma, OWNER, {})).map(n => n.ref), [3, 2, 1]);
  assert.deepEqual((await personal.searchNotes(prisma, OWNER, { text: 'ruku rig' })).map(n => n.ref), [3, 1], 'both words first, and never another owner\'s');
  assert.deepEqual((await personal.searchNotes(prisma, OWNER, { text: 'nothing here' })).length, 0);
  await personal.deleteNote(prisma, OWNER, 2);
  await assert.rejects(personal.deleteNote(prisma, OWNER, 4), /no note 4/, 'cannot delete someone else\'s');
  assert.equal((await personal.searchNotes(prisma, OWNER, {})).length, 2);
});

test('a reminder is handed out once when due; a repeating one moves on', async () => {
  const prisma = await createTestDb();
  const now = at('2026-10-12 10:00');
  const once = await personal.addReminder(prisma, OWNER, { text: 'Pay the testers', dueLocal: '2026-10-16 15:00' }, now);
  const weekly = await personal.addReminder(prisma, OWNER, { text: 'Check payouts', dueLocal: '2026-10-12 09:00', repeat: 'weekly' }, now);
  assert.equal(personal.localText(weekly.dueAt), 'Monday 2026-10-19 09:00', 'a repeating one whose first time has passed starts at the next');
  await assert.rejects(personal.addReminder(prisma, OWNER, { text: 'x', dueLocal: '2026-10-12 09:00' }, now), /already passed/);
  await assert.rejects(personal.addReminder(prisma, OWNER, { text: 'x', dueLocal: 'friday' }, now), /not a time/);
  await assert.rejects(personal.addReminder(prisma, OWNER, { text: 'x', dueLocal: '2026-10-16 15:00', repeat: 'hourly' }, now), /Repeat must be/);

  assert.deepEqual(await personal.claimDue(prisma, at('2026-10-16 14:59')), []);
  const due = await personal.claimDue(prisma, at('2026-10-16 15:00'));
  assert.deepEqual(due, [{ ref: once.ref, text: 'Pay the testers', due: 'Friday 2026-10-16 15:00', repeat: null, next: null }]);
  assert.deepEqual(await personal.claimDue(prisma, at('2026-10-16 15:01')), [], 'not sent twice');

  const first = await personal.claimDue(prisma, at('2026-10-19 09:00'));
  assert.deepEqual([first[0].text, first[0].next], ['Check payouts', 'Monday 2026-10-26 09:00']);
  assert.deepEqual((await personal.listReminders(prisma, OWNER)).map(r => personal.localText(r.dueAt)), ['Monday 2026-10-26 09:00']);
  await personal.cancelReminder(prisma, OWNER, weekly.ref);
  assert.deepEqual(await personal.claimDue(prisma, at('2026-10-26 09:00')), []);
  await assert.rejects(personal.cancelReminder(prisma, OWNER, weekly.ref), /no pending reminder/);
});

// Plays back scripted model turns and records what the model was offered.
function scripted(turns) {
  const seen = [];
  let i = 0;
  return { seen, messages: { create: async params => {
    seen.push(JSON.parse(JSON.stringify(params)));
    const turn = turns[i++];
    const blocks = typeof turn === 'function' ? turn(params) : turn;
    const content = Array.isArray(blocks) ? blocks : [{ type: 'text', text: blocks }];
    return { content, stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  } } };
}
const call = (name, input) => ({ type: 'tool_use', id: `tu_${name}`, name, input });
const lastResult = params => JSON.parse(params.messages.at(-1).content[0].content);
let n = 0;
const msg = (author, content) => ({ id: `99${++n}`, channelId: '555', guildId: null, authorDiscordId: author, authorName: 'Alex', content, attachments: [], postedAt: new Date().toISOString() });

test('private mode is the owner only, and only there do the private tools exist', async () => {
  const prisma = await createTestDb();
  await seedBasics(prisma);
  await assistant.saveSettings(prisma, { admins: [{ id: ADMIN, label: 'Lead' }], channels: [] });
  const names = client => client.seen[0].tools.map(t => t.name);

  // The owner in private: not on the approved list, still answered, with notes and reminders on offer.
  const mine = scripted([
    [call('save_private_note', { text: 'Ruku wants 40k for the next rig' }), { ...call('set_reminder', { text: 'Pay the testers', due_local: '2099-01-02 15:00' }), id: 'tu_2' }],
    params => JSON.stringify(params.messages.at(-1).content.map(c => JSON.parse(c.content))),
  ]);
  const result = await assistant.respond(prisma, { message: msg(OWNER, 'note that ruku wants 40k, and remind me jan 2 at 3 to pay testers'), private: true }, { client: mine });
  assert.ok(names(mine).includes('save_private_note') && names(mine).includes('set_reminder') && names(mine).includes('get_item'));
  assert.match(mine.seen[0].system.at(-1).text, /PRIVATE MODE/);
  assert.match(mine.seen[0].messages.at(-1).content, /^It is now \w+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} US Eastern/);
  const [noted, reminded] = JSON.parse(result.reply);
  assert.deepEqual([noted.saved, reminded.reminder.due], [true, 'Friday 2099-01-02 15:00']);
  assert.equal((await personal.searchNotes(prisma, OWNER, { text: 'ruku' })).length, 1);

  // An approved admin claiming private mode gets the ordinary assistant, without the private tools...
  const lead = scripted(['ok']);
  await assistant.respond(prisma, { message: msg(ADMIN, 'what did Alex note about ruku'), private: true }, { client: lead });
  assert.ok(!names(lead).some(t => personal.TOOL_NAMES.has(t)));
  assert.ok(!lead.seen[0].system.some(s => /PRIVATE MODE/.test(s.text)));
  // ...and cannot reach them even if the model were to call one.
  const sneaky = scripted([[call('search_private_notes', { text: 'ruku' })], params => JSON.stringify(lastResult(params))]);
  const blocked = await assistant.respond(prisma, { message: msg(ADMIN, 'x'), private: true }, { client: sneaky });
  assert.match(JSON.parse(blocked.reply).error, /only available to the owner/);

  // The owner in a team channel (not private) is treated like anyone else: no private tools.
  await assistant.saveSettings(prisma, { admins: [{ id: ADMIN, label: 'Lead' }, { id: OWNER, label: 'Alex' }], channels: [] });
  const open = scripted(['ok']);
  await assistant.respond(prisma, { message: msg(OWNER, 'hello') }, { client: open });
  assert.ok(!names(open).some(t => personal.TOOL_NAMES.has(t)));

  // Somebody else entirely is refused.
  assert.equal((await assistant.respond(prisma, { message: msg('444444444444444444', 'hi'), private: true }, { client: scripted(['no']) })).denied, true);
});
