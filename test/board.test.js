// The Assets board: units and tasks from Linear, images, notes, check-ins, the updates from Discord, the daily DM.
// Linear and Claude are stand-ins; the database is PGlite.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const B = require('../src/board/board');
const T = require('../src/board/triage');
const devs = require('../src/devs');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
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
  const texture = issue('Texture - Ruku', 'started', rukia, { updatedAt: ago(4) });
  const shiny = issue('Shiny', 'backlog', texture);
  const mesh = issue('Mesh - Lyft', 'completed', rukia, { comments: { nodes: [{ body: 'Files: [rukia.fbx](https://uploads.linear.app/a/b/rukia.fbx)', createdAt: ago(1), user: { name: 'Anime Expeditions' } }] } });
  const aura = issue('Aura', 'backlog', rukia);
  const vfx = issue('VFX - Mauwiscool', 'started', rukia, { updatedAt: ago(0.5), startedAt: ago(0.5) });
  const dropped = issue('Old idea', 'canceled', rukia);
  return { all: [units, rukia, texture, shiny, mesh, aura, vfx, dropped], rukia, texture, shiny, mesh, aura, vfx };
}

async function setup() {
  const prisma = await createDb();
  await devs.create({ name: 'Ruku', discordUserId: '111111111111111111', channelId: '222222222222222222' }, prisma);
  await devs.create({ name: 'Lyft', discordUserId: '333333333333333333' }, prisma);
  await devs.create({ name: 'Mauwiscool' }, prisma);
  const L = fakeLinear();
  await B.sync(prisma, async () => L.all);
  return { prisma, L };
}

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]);

test('units, tasks and Shinies come from Linear, with status, dev and who needs a check-in', async () => {
  const { prisma, L } = await setup();
  const b = await B.board(prisma, NOW);
  assert.equal(b.units.length, 1, 'only the units under "Units"');
  const u = b.units[0];
  assert.equal(u.name, 'Rukia');
  assert.equal(u.rarity, 'MYTHIC');
  assert.match(u.notionUrl, /notion\.com\/p\/Rukia/);
  assert.deepEqual(u.tasks.map(t => t.name), ['Aura', 'Mesh', 'Texture', 'VFX'], 'canceled left out; names without the dev');
  const tex = u.tasks.find(t => t.name === 'Texture');
  assert.equal(tex.status, 'in_progress');
  assert.equal(tex.dev.name, 'Ruku');
  assert.equal(tex.shinies[0].name, 'Shiny');
  assert.equal(tex.needsCheckin, true, 'four days quiet, the default is two');
  assert.equal(u.tasks.find(t => t.name === 'VFX').needsCheckin, false, 'started half a day ago');
  assert.deepEqual(u.tasks.find(t => t.name === 'Mesh').files, ['rukia.fbx'], 'files sent to Linear are listed');
  assert.deepEqual(b.counts, { untasked: 2, in_progress: 2, done: 1, checkin: 1 });
  assert.deepEqual(u.counts, { untasked: 2, in_progress: 2, done: 1, total: 5, checkin: 1 });

  // A check-in stops the reminder for a day.
  await B.addActivity(L.texture.id, 'checkin', { by: 'Alex', at: NOW }, prisma);
  assert.equal((await B.board(prisma, NOW)).counts.checkin, 0);
  // A longer setting stretches it too.
  await B.setSettings({ checkInDays: 7 }, prisma);
  await assert.rejects(B.setSettings({ checkInDays: 0 }, prisma), /1 to 30/);
  await assert.rejects(B.setSettings({ timezone: 'Mars/Base' }, prisma), /time zone/);
  await assert.rejects(B.setSettings({ extraChannels: ['general'] }, prisma), /channel IDs/);
});

test('statuses go to Linear the /linear way, and land in the history', async () => {
  const { prisma, L } = await setup();
  const calls = [];
  const fake = async (i, status, devName) => { calls.push([i.identifier, status, devName]); return { ...i, title: devName ? `Aura - ${devName}` : i.title, state: { name: 'In Progress', type: 'started' } }; };
  await assert.rejects(B.setStatus(L.aura.identifier, 'in_progress', null, 'Alex', prisma, fake), /Pick a developer/);
  await assert.rejects(B.setStatus(L.aura.identifier, 'paused', null, 'Alex', prisma, fake), /status must be/);
  const lyft = (await devs.list(prisma)).find(d => d.name === 'Lyft');
  await B.setStatus(L.aura.identifier, 'in_progress', lyft.id, 'Alex', prisma, fake);
  assert.deepEqual(calls, [[L.aura.identifier, 'in_progress', 'Lyft']]);
  const h = await B.history(L.aura.identifier, prisma);
  assert.equal(h.events[0].to, 'in_progress');
  assert.equal(h.events[0].dev, 'Lyft');
  assert.equal(h.events[0].by, 'Alex');
});

test('images: one base image per unit, references on anything, links that only work signed', async () => {
  const { prisma, L } = await setup();
  await assert.rejects(B.addImage({ issueId: L.rukia.id, kind: 'base', data: Buffer.from('not an image') }, prisma), /JPEG, PNG/);
  const first = await B.addImage({ issueId: L.rukia.id, kind: 'base', data: PNG, by: 'Alex' }, prisma);
  const second = await B.addImage({ issueId: L.rukia.id, kind: 'base', data: PNG, by: 'Alex' }, prisma);
  await B.addImage({ issueId: L.texture.id, kind: 'ref', data: PNG, caption: 'palette' }, prisma);
  const b = await B.board(prisma, NOW);
  assert.equal(b.units[0].baseImage.id, second.id, 'a new base image replaces the old');
  assert.equal(b.units[0].tasks.find(t => t.name === 'Texture').images[0].caption, 'palette');
  const sig = new URL(second.url, 'http://x').searchParams.get('s');
  assert.equal((await B.image(second.id, sig, prisma)).mime, 'image/png');
  await assert.rejects(B.image(second.id, 'wrong', prisma), /Bad image link/);
  await assert.rejects(B.image(first.id, new URL(first.url, 'http://x').searchParams.get('s'), prisma), /No such image/);
  await B.setNotes(L.texture.id, 'Use the darker blue from the concept.', 'Alex', prisma);
  assert.match((await B.board(prisma, NOW)).units[0].tasks.find(t => t.name === 'Texture').notes, /darker blue/);
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
  assert.match(asked, /\[900000000000000001\].*Ruku.*\[files: rukia\.png, rukia\.psd\]/, 'and the messages');
  const box = await T.inbox(prisma);
  assert.equal(box.items.length, 3);
  const done = box.items.find(i => i.action === 'mark_done');
  assert.ok(done.messages[0].files[0].imageUrl, 'the kept image can be shown and used');
  assert.equal((await B.board(prisma, NOW)).units[0].tasks.find(t => t.name === 'Texture').lastDiscord.text, 'Ruku says the Rukia texture is finished.');

  const calls = [];
  const fake = async (i, status, devName) => { calls.push([i.identifier, status, devName]); return i; };
  await T.decide(done.id, 'apply', 'Alex', prisma, { setInLinear: fake });
  await T.decide(box.items.find(i => i.action === 'mark_in_progress').id, 'apply', 'Alex', prisma, { setInLinear: fake });
  await T.decide(box.items.find(i => i.action === 'needs_reply').id, 'dismiss', 'Alex', prisma);
  await assert.rejects(T.decide(done.id, 'apply', 'Alex', prisma, { setInLinear: fake }), /Already done/);
  assert.deepEqual(calls, [[L.texture.identifier, 'done', null], [L.aura.identifier, 'in_progress', 'Lyft']], 'the dev comes from the update');
  assert.equal((await T.inbox(prisma)).items.length, 0);

  // A kept image becomes a reference on the task.
  const used = await B.useImage(done.messages[0].files[0].imageId, L.texture.id, 'ref', 'Alex', prisma);
  assert.equal(used.kind, 'ref');

  // Nothing new: nothing asked.
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
  assert.equal((await B.getMeta('triage', prisma)).error, 'ANTHROPIC_API_KEY is not set');
});

test('the daily DM: once a day, after the hour, only with something to say', async () => {
  const { prisma } = await setup();
  const sent = [];
  const send = async p => { sent.push(p); return true; };
  const at = iso => new Date(iso);
  assert.deepEqual(T.localNow('America/New_York', at('2026-11-13T14:30:00Z')), { date: '2026-11-13', hour: 9 });
  assert.equal(await T.digest(prisma, send, at('2026-11-13T14:30:00Z')), null, '9 am in New York: too early');
  const d = await T.digest(prisma, send, at('2026-11-13T15:05:00Z'));
  assert.equal(d.sent, true);
  assert.deepEqual(sent[0].stale.map(s => [s.unit, s.task, s.dev, s.days]), [['Rukia', 'Texture', 'Ruku', 4]]);
  assert.match(sent[0].url, /\/assets\/\?show=checkin$/);
  assert.equal(await T.digest(prisma, send, at('2026-11-13T22:00:00Z')), null, 'once a day');
  await B.setSettings({ digestDm: false }, prisma);
  assert.equal(await T.digest(prisma, send, at('2026-11-14T15:05:00Z')), null, 'switched off');
  assert.equal(sent.length, 1);
});

test('the bot reads each dev\'s place and the channels picked', async () => {
  const { prisma } = await setup();
  assert.deepEqual(await T.watchList(prisma), ['222222222222222222']);
  await B.setSettings({ extraChannels: ['444444444444444444'] }, prisma);
  assert.deepEqual((await T.watchList(prisma)).sort(), ['222222222222222222', '444444444444444444']);
  await B.setSettings({ readDevPlaces: false }, prisma);
  assert.deepEqual(await T.watchList(prisma), ['444444444444444444']);
});
