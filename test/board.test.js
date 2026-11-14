// The Assets board: the one-time copy from Linear, cards, tasks and subtasks, updates, sorting, Send to Assets,
// images, notes, check-ins, the updates from Discord, the daily DM, the Developers tab.
// Linear and Claude are stand-ins; the database is PGlite.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

// Times without a zone come back from PGlite as local time; the servers run in UTC, and so do these tests.
process.env.TZ = 'UTC';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const B = require('../src/board/board');
const T = require('../src/board/triage');
const I = require('../src/board/import-linear');
const devs = require('../src/devs');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  // The dashboard's older "Board Tasks" feature has its own "BoardTask" table in the same database;
  // the Assets board must not trip over it (it did, on its first deploy).
  await pg.exec(`CREATE TABLE "BoardTask" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'todo')`);
  await pg.exec(`INSERT INTO "BoardTask" (id, title) VALUES ('old-1', 'An old board task')`);
  return {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).affectedRows ?? 0,
  };
}

const NOW = new Date('2026-11-13T15:00:00Z');
const ago = days => new Date(NOW - days * 86400000).toISOString();
let n = 0;
const issue = (title, type, parent, extra = {}) => ({
  id: `id-${++n}`, identifier: `ASS-${n}`, title, url: `https://linear.app/x/ASS-${n}`, description: '', createdAt: ago(20), updatedAt: ago(10),
  startedAt: type === 'started' ? ago(5) : null, completedAt: type === 'completed' ? ago(1) : null,
  state: { name: { started: 'In Progress', completed: 'Done', unstarted: 'Todo', backlog: 'Backlog', canceled: 'Canceled' }[type], type },
  parent: parent ? { id: parent.id, identifier: parent.identifier } : null, project: { name: 'Winter Update [6.0]' },
  labels: { nodes: [] }, comments: { nodes: [] }, ...extra,
});

function fakeLinear() {
  n = 0;
  const units = issue('Units', 'backlog');
  const rukia = issue('Rukia', 'backlog', units, { description: '[https://app.notion.com/p/Rukia-9c4c](<https://app.notion.com/p/Rukia-9c4c>)', labels: { nodes: [{ name: 'MYTHIC', parent: { name: 'Rarity' } }] } });
  const texture = issue('Texture - Ruku', 'started', rukia);
  const shiny = issue('Shiny', 'backlog', texture);
  const mesh = issue('Mesh - Lyft', 'completed', rukia, { comments: { nodes: [{ body: 'Files: [rukia.fbx](https://uploads.linear.app/a/b/rukia.fbx)', createdAt: ago(1), user: { name: 'Anime Expeditions' } }] } });
  const aura = issue('Aura', 'backlog', rukia);
  const vfx = issue('VFX - Mauwiscool', 'started', rukia, { startedAt: ago(0.5) });
  const icons = issue('Equipment & Evo Item Icons - Lyft', 'completed', rukia);
  const anim = issue('Animations', 'unstarted', rukia);
  const dropped = issue('Old idea', 'canceled', rukia);
  return { all: [units, rukia, texture, shiny, mesh, aura, vfx, icons, anim, dropped], rukia, texture, shiny, mesh, aura, vfx, icons };
}

async function setup() {
  const prisma = await createDb();
  await devs.create({ name: 'Ruku', discordUserId: '111111111111111111', channelId: '222222222222222222' }, prisma);
  await devs.create({ name: 'Lyft', discordUserId: '333333333333333333' }, prisma);
  await devs.create({ name: 'Mauwiscool' }, prisma);
  const L = fakeLinear();
  const r = await I.importOnce(prisma, async () => L.all);
  return { prisma, L, r };
}

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]);
const rukiaOf = b => b.cards.find(c => c.name === 'Rukia');

test('the one-time copy from Linear: cards, tasks, subtasks, statuses, devs, updates; Icons renamed with its subtasks', async () => {
  const { prisma, L, r } = await setup();
  assert.deepEqual([r.cards, r.updates], [1, 1]);
  const b = await B.board(prisma, NOW);
  assert.equal(b.cards.length, 1, 'only the units under "Units"');
  const u = rukiaOf(b);
  assert.equal(u.id, L.rukia.id, 'keeps its id, so images and notes stay attached');
  assert.equal(u.identifier, L.rukia.identifier);
  assert.equal(u.kind, 'unit');
  assert.equal(u.rarity, 'MYTHIC');
  assert.equal(u.update.name, 'Winter Update [6.0]');
  assert.match(u.notionUrl, /notion\.com\/p\/Rukia/);
  // Untasked first, then in progress, then done; each in the template's order.
  assert.deepEqual(u.tasks.map(t => [t.name, t.status]), [
    ['Animations', 'untasked'], ['Aura', 'untasked'], ['Texture', 'in_progress'], ['VFX', 'in_progress'], ['Mesh', 'done'], ['Icons', 'done'],
  ]);
  const tex = u.tasks.find(t => t.name === 'Texture');
  assert.equal(tex.dev.name, 'Ruku');
  assert.equal(tex.subtasks[0].name, 'Shiny');
  assert.equal(tex.needsCheckin, true, 'five days quiet, the default is two');
  assert.equal(u.tasks.find(t => t.name === 'VFX').needsCheckin, false, 'started half a day ago');
  const icons = u.tasks.find(t => t.name === 'Icons');
  assert.deepEqual(icons.subtasks.map(s => [s.name, s.status, s.devName]), [['Equipment', 'done', 'Lyft'], ['Evo Item', 'done', 'Lyft']]);
  assert.deepEqual(u.tasks.find(t => t.name === 'Mesh').deliveries[0].files, ['rukia.fbx'], 'files sent to Linear are kept as a delivery');
  assert.deepEqual(b.counts, { untasked: 3, in_progress: 2, done: 4, checkin: 1 });

  const [old] = await prisma.$queryRawUnsafe(`SELECT title FROM "BoardTask" WHERE id = 'old-1'`);
  assert.equal(old.title, 'An old board task', 'the other feature\'s table is left alone');

  // Once only: a second start copies nothing.
  assert.equal(await I.importOnce(prisma, async () => { throw new Error('should not be asked'); }), null);

  // A check-in stops the reminder for a day.
  await B.addActivity(L.texture.id, 'checkin', { by: 'Alex', at: NOW }, prisma);
  assert.equal((await B.board(prisma, NOW)).counts.checkin, 0);
  await B.setSettings({ checkInDays: 7 }, prisma);
  await assert.rejects(B.setSettings({ checkInDays: 0 }, prisma), /1 to 30/);
  await assert.rejects(B.setSettings({ timezone: 'Mars/Base' }, prisma), /time zone/);
  await assert.rejects(B.setSettings({ extraChannels: ['general'] }, prisma), /channel IDs/);
});

test('no Linear key and nothing to copy: the board starts empty', async () => {
  const prisma = await createDb();
  delete process.env.LINEAR_API_KEY;
  assert.equal(await I.importOnce(prisma), null);
  assert.equal((await B.board(prisma, NOW)).cards.length, 0);
});

test('new cards start from the unit template; tasks and subtasks can be added, renamed and removed', async () => {
  const { prisma } = await setup();
  const upd = await B.createUpdate('Update 7', prisma);
  await assert.rejects(B.createUpdate('update 7', prisma), /already an update/);
  const card = await B.createCard({ name: 'Doumo', updateId: upd.id, rarity: 'Secret' }, 'Alex', prisma);
  assert.match(card.identifier, /^ASS-\d+$/);
  let b = await B.board(prisma, NOW);
  let doumo = b.cards.find(c => c.id === card.id);
  assert.deepEqual(doumo.tasks.map(t => t.name), ['Animations', 'Mesh', 'Texture', 'Aura', 'Icons', 'VFX', 'Cosmetic']);
  assert.deepEqual(doumo.tasks.find(t => t.name === 'Icons').subtasks.map(s => s.name), ['Equipment', 'Evo Item']);
  assert.equal(doumo.update.name, 'Update 7');
  assert.equal(b.updates.find(u => u.id === upd.id).cards, 1);

  const icons = doumo.tasks.find(t => t.name === 'Icons');
  const title = await B.addTask(card.id, { name: 'Title Card', parentId: icons.id }, 'Alex', prisma);
  await assert.rejects(B.addTask(card.id, { name: 'Deeper', parentId: title.id }, 'Alex', prisma), /subtasks of its own/);
  await B.renameTask(title.identifier, 'Title', 'Alex', prisma);
  const extra = await B.addTask(card.id, { name: 'Emotes' }, 'Alex', prisma);
  b = await B.board(prisma, NOW);
  doumo = b.cards.find(c => c.id === card.id);
  assert.deepEqual(doumo.tasks.find(t => t.name === 'Icons').subtasks.map(s => s.name), ['Equipment', 'Evo Item', 'Title']);
  assert.equal(doumo.tasks.at(-1).name, 'Emotes', 'tasks outside the template go after it');
  await B.removeTask(icons.id, prisma);
  b = await B.board(prisma, NOW);
  assert.equal(b.cards.find(c => c.id === card.id).tasks.some(t => t.name === 'Icons'), false);
  await B.removeTask(extra.id, prisma);

  // A blank card that isn't a unit, and filtering by update is the page's: removing an update keeps its cards.
  const other = await B.createCard({ name: 'Lobby props', kind: 'other' }, 'Alex', prisma);
  assert.equal((await B.board(prisma, NOW)).cards.find(c => c.id === other.id).tasks.length, 0);
  await B.removeUpdate(upd.id, prisma);
  assert.equal((await B.board(prisma, NOW)).cards.find(c => c.id === card.id).update, null);
  await B.archiveCard(card.identifier, prisma);
  assert.equal((await B.board(prisma, NOW)).cards.some(c => c.id === card.id), false);
});

test('statuses are DevTrack\'s own, re-sort the card, and land in the history', async () => {
  const { prisma, L } = await setup();
  await assert.rejects(B.setStatus(L.aura.identifier, 'in_progress', null, 'Alex', prisma), /Pick a developer/);
  await assert.rejects(B.setStatus(L.aura.identifier, 'paused', null, 'Alex', prisma), /status must be/);
  const lyft = (await devs.list(prisma)).find(d => d.name === 'Lyft');
  await B.setStatus(L.aura.identifier, 'in_progress', lyft.id, 'Alex', prisma);
  let u = rukiaOf(await B.board(prisma, NOW));
  const aura = u.tasks.find(t => t.name === 'Aura');
  assert.equal(aura.status, 'in_progress');
  assert.equal(aura.devName, 'Lyft');
  assert.ok(aura.startedAt);
  assert.deepEqual(u.tasks.map(t => t.name).slice(0, 4), ['Animations', 'Texture', 'Aura', 'VFX'], 'in progress, after untasked, in template order');
  // A subtask is tracked on its own.
  await B.setStatus(L.shiny.identifier, 'done', null, 'Alex', prisma);
  u = rukiaOf(await B.board(prisma, NOW));
  assert.equal(u.tasks.find(t => t.name === 'Texture').subtasks[0].status, 'done');
  assert.equal(u.tasks.find(t => t.name === 'Texture').status, 'in_progress');
  await B.setStatus(L.aura.identifier, 'untasked', null, 'Alex', prisma);
  u = rukiaOf(await B.board(prisma, NOW));
  assert.equal(u.tasks.find(t => t.name === 'Aura').devName, null, 'untasked takes the dev off');
  const h = await B.history(L.aura.identifier, prisma);
  assert.deepEqual(h.events.map(e => [e.from, e.to, e.dev, e.by]), [['in_progress', 'untasked', 'Lyft', 'Alex'], ['untasked', 'in_progress', 'Lyft', 'Alex']]);
});

test('Send to Assets: a link to the message, the files named, the task done and the dev on it; search and a dev\'s tasks for Discord', async () => {
  const { prisma, L } = await setup();
  const ruku = (await devs.list(prisma)).find(d => d.name === 'Ruku');
  const mine = await B.tasksOf(ruku.id, prisma, NOW);
  assert.deepEqual(mine.map(t => t.label), ['Rukia › Texture', 'Rukia › Texture › Shiny'], 'in progress first, with its open subtasks');
  assert.deepEqual((await B.search('rukia shiny', {}, prisma)).map(t => t.label), ['Rukia › Texture › Shiny']);
  assert.deepEqual((await B.search(L.aura.identifier.split('-')[1], {}, prisma)).map(t => t.name), ['Aura'], 'just the number works');
  assert.equal((await B.search('mesh', {}, prisma)).length, 0, 'done ones only when asked for');
  assert.equal((await B.search('mesh', { withDone: true }, prisma)).length, 1);

  await assert.rejects(B.deliver(L.texture.id, { url: 'https://example.com/x' }, prisma), /Discord message/);
  const url = 'https://discord.com/channels/1/2/3';
  const r = await B.deliver(L.texture.identifier, { url, files: ['rukia_tex.png'], devId: ruku.id, by: 'Alex' }, prisma);
  assert.equal(r.was, 'in_progress');
  const tex = rukiaOf(await B.board(prisma, NOW)).tasks.find(t => t.name === 'Texture');
  assert.equal(tex.status, 'done');
  assert.deepEqual([tex.deliveries[0].url, tex.deliveries[0].files, tex.deliveries[0].devName], [url, ['rukia_tex.png'], 'Ruku']);
  assert.equal((await B.deliveriesOf(L.texture.identifier, prisma)).deliveries.length, 1);

  // Someone else's untasked task becomes theirs as it's delivered.
  const lyft = (await devs.list(prisma)).find(d => d.name === 'Lyft');
  await B.deliver(L.aura.id, { url, devId: lyft.id, by: 'Alex' }, prisma);
  const aura = rukiaOf(await B.board(prisma, NOW)).tasks.find(t => t.name === 'Aura');
  assert.deepEqual([aura.status, aura.devName], ['done', 'Lyft']);

  // Someone given a task from Discord who isn't listed yet is added.
  const added = await devs.forDiscord('555555555555555555', 'Nova', prisma);
  assert.equal(added.name, 'Nova');
  assert.equal((await devs.forDiscord('555555555555555555', 'Somebody else', prisma)).id, added.id);
  const named = await devs.forDiscord('666666666666666666', 'Mauwiscool', prisma);
  assert.equal(named.name, 'Mauwiscool', 'a listed name without a Discord account is them');
});

test('the Developers tab: working, free, quiet and away', async () => {
  const { prisma } = await setup();
  await devs.create({ name: 'Idle Ida', discordUserId: '444444444444444444' }, prisma);
  await T.addMessage({ id: '900000000000000020', channelId: '222222222222222222', authorId: '444444444444444444', authorName: 'Ida', content: 'hi', postedAt: ago(1) }, prisma);
  let b = await B.board(prisma, NOW);
  const state = name => b.devs.find(d => d.name === name).state;
  assert.equal(state('Ruku'), 'working');
  assert.equal(b.devs.find(d => d.name === 'Ruku').working[0].task, 'Texture');
  assert.equal(state('Idle Ida'), 'free', 'nothing in progress, but heard from yesterday');
  assert.equal(state('Lyft'), 'free', 'finished something yesterday');
  await B.setSettings({ quietDays: 1 }, prisma);
  b = await B.board(prisma, NOW);
  assert.equal(state('Lyft'), 'quiet');
  const ida = (await devs.list(prisma)).find(d => d.name === 'Idle Ida');
  await devs.update(ida.id, { away: true }, prisma);
  b = await B.board(prisma, NOW);
  assert.equal(state('Idle Ida'), 'away');
});

test('images: one base image per card, references on anything, links that only work signed', async () => {
  const { prisma, L } = await setup();
  await assert.rejects(B.addImage({ issueId: L.rukia.id, kind: 'base', data: Buffer.from('not an image') }, prisma), /JPEG, PNG/);
  const first = await B.addImage({ issueId: L.rukia.id, kind: 'base', data: PNG, by: 'Alex' }, prisma);
  const second = await B.addImage({ issueId: L.rukia.id, kind: 'base', data: PNG, by: 'Alex' }, prisma);
  await B.addImage({ issueId: L.texture.id, kind: 'ref', data: PNG, caption: 'palette' }, prisma);
  const b = await B.board(prisma, NOW);
  assert.equal(rukiaOf(b).baseImage.id, second.id, 'a new base image replaces the old');
  assert.equal(rukiaOf(b).tasks.find(t => t.name === 'Texture').images[0].caption, 'palette');
  const sig = new URL(second.url, 'http://x').searchParams.get('s');
  assert.equal((await B.image(second.id, sig, prisma)).mime, 'image/png');
  await assert.rejects(B.image(second.id, 'wrong', prisma), /Bad image link/);
  await assert.rejects(B.image(first.id, new URL(first.url, 'http://x').searchParams.get('s'), prisma), /No such image/);
  await B.setNotes(await B.idOf(L.texture.identifier, prisma), 'Use the darker blue from the concept.', 'Alex', prisma);
  await B.setNotes(await B.idOf(L.rukia.identifier, prisma), 'Ice theme.', 'Alex', prisma);
  const b2 = await B.board(prisma, NOW);
  assert.match(rukiaOf(b2).tasks.find(t => t.name === 'Texture').notes, /darker blue/);
  assert.equal(rukiaOf(b2).notes, 'Ice theme.');
});

test('Discord messages are kept (images too), gone through by Claude, and the updates applied or dismissed', async () => {
  const { prisma, L } = await setup();
  const fetches = [];
  const download = async url => { fetches.push(url); return { ok: true, arrayBuffer: async () => PNG }; };
  const m1 = { id: '900000000000000001', channelId: '222222222222222222', threadId: '222222222222222299', place: 'ruku', authorId: '111111111111111111', authorName: 'Ruku',
    content: 'Rukia texture is finished!', url: 'https://discord.com/channels/1/2/3', postedAt: ago(0.2),
    attachments: [{ name: 'rukia.png', url: 'https://cdn.discordapp.com/rukia.png', contentType: 'image/png', size: 2000 }, { name: 'rukia.psd', url: 'https://cdn/x.psd', contentType: 'application/octet-stream', size: 9 }] };
  const m2 = { ...m1, id: '900000000000000002', authorId: '333333333333333333', authorName: 'Lyft', content: 'starting the aura for rukia now', attachments: [] };
  const m3 = { ...m1, id: '900000000000000003', authorName: 'Ruku', content: 'Alex, do you want the shiny in gold or silver?', attachments: [] };
  for (const m of [m1, m2, m3]) await T.addMessage(m, prisma, download);
  assert.equal((await T.addMessage(m1, prisma, download)).duplicate, true);
  assert.deepEqual(fetches, ['https://cdn.discordapp.com/rukia.png'], 'only images are downloaded');

  let asked = null;
  const ask = async text => {
    asked = text;
    return { model: 'claude-opus-5-5', suggestions: [
      { message_ids: [m1.id], issue: L.texture.identifier, action: 'mark_done', dev: '', summary: 'Ruku says the Rukia texture is finished.', confidence: 'high' },
      { message_ids: [m2.id], issue: L.aura.identifier, action: 'mark_in_progress', dev: 'Lyft', summary: 'Lyft started the Rukia aura.', confidence: 'high' },
      { message_ids: [m3.id], issue: '', action: 'needs_reply', dev: '', summary: 'Ruku asks: gold or silver for the shiny?', confidence: 'medium' },
      { message_ids: ['999'], issue: L.aura.identifier, action: 'add_note', dev: '', summary: 'made up', confidence: 'low' }, // no such message: dropped
      { message_ids: [m1.id], issue: 'ASS-999', action: 'mark_done', dev: '', summary: 'unknown task', confidence: 'low' }, // no such task: dropped
    ] };
  };
  const r = await T.triage(prisma, ask);
  assert.deepEqual([r.messages, r.suggestions], [3, 3]);
  assert.match(asked, /ASS-\d+ \| Rukia › Texture \| in progress \| Ruku/, 'Claude sees the board');
  assert.match(asked, /ASS-\d+ \| Rukia › Texture › Shiny \| untasked/, 'subtasks too');
  assert.match(asked, /\[900000000000000001\].*Ruku.*\[files: rukia\.png, rukia\.psd\]/, 'and the messages');
  const box = await T.inbox(prisma);
  assert.equal(box.items.length, 3);
  const done = box.items.find(i => i.action === 'mark_done');
  assert.ok(done.messages[0].files[0].imageUrl, 'the kept image can be shown and used');
  assert.equal(rukiaOf(await B.board(prisma, NOW)).tasks.find(t => t.name === 'Texture').lastDiscord.text, 'Ruku says the Rukia texture is finished.');

  await T.decide(done.id, 'apply', 'Alex', prisma);
  await T.decide(box.items.find(i => i.action === 'mark_in_progress').id, 'apply', 'Alex', prisma);
  await T.decide(box.items.find(i => i.action === 'needs_reply').id, 'dismiss', 'Alex', prisma);
  await assert.rejects(T.decide(done.id, 'apply', 'Alex', prisma), /Already done/);
  const u = rukiaOf(await B.board(prisma, NOW));
  assert.equal(u.tasks.find(t => t.name === 'Texture').status, 'done');
  assert.deepEqual([u.tasks.find(t => t.name === 'Aura').status, u.tasks.find(t => t.name === 'Aura').devName], ['in_progress', 'Lyft'], 'the dev comes from the update');
  assert.equal((await T.inbox(prisma)).items.length, 0);

  const used = await B.useImage(done.messages[0].files[0].imageId, L.texture.id, 'ref', 'Alex', prisma);
  assert.equal(used.kind, 'ref');
  assert.equal((await T.triage(prisma, async () => { throw new Error('should not be asked'); })).messages, 0);
});

test('without Claude the messages still reach the list, one per person and place', async () => {
  const { prisma } = await setup();
  for (const id of ['900000000000000011', '900000000000000012']) {
    await T.addMessage({ id, channelId: '222222222222222222', authorId: '111111111111111111', authorName: 'Ruku', content: `wip ${id}`, postedAt: ago(0.1) }, prisma);
  }
  const r = await T.triage(prisma, async () => { throw new Error('ANTHROPIC_API_KEY is not set'); });
  assert.equal(r.suggestions, 1);
  assert.match(r.error, /ANTHROPIC_API_KEY/);
  const [item] = (await T.inbox(prisma)).items;
  assert.equal(item.messages.length, 2);
});

test('the daily DM: once a day, after the hour, only with something to say, linking to DevTrack', async () => {
  const { prisma } = await setup();
  const sent = [];
  const send = async p => { sent.push(p); return true; };
  const at = iso => new Date(iso);
  assert.equal(await T.digest(prisma, send, at('2026-11-13T14:30:00Z')), null, '9 am in New York: too early');
  const d = await T.digest(prisma, send, at('2026-11-13T15:05:00Z'));
  assert.equal(d.sent, true);
  assert.deepEqual(sent[0].stale.map(s => [s.unit, s.task, s.dev, s.days]), [['Rukia', 'Texture', 'Ruku', 5]]);
  assert.match(sent[0].stale[0].url, /\/assets\/\?item=ASS-\d+$/);
  assert.equal(await T.digest(prisma, send, at('2026-11-13T22:00:00Z')), null, 'once a day');
  assert.equal(sent.length, 1);
});

test('the bot reads each dev\'s place and the channels picked; the dots know who is working', async () => {
  const { prisma } = await setup();
  assert.deepEqual(await T.watchList(prisma), ['222222222222222222']);
  await B.setSettings({ extraChannels: ['444444444444444444'] }, prisma);
  assert.deepEqual((await T.watchList(prisma)).sort(), ['222222222222222222', '444444444444444444']);
  const w = await B.working(prisma);
  assert.deepEqual(w.find(d => d.name === 'Ruku').tasks.map(t => t.label), ['Rukia › Texture']);
  assert.deepEqual(w.find(d => d.name === 'Lyft').tasks, []);
});
