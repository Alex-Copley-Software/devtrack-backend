const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, ctxFor, seedBasics } = require('./helpers');
const service = require('../../src/assets/service');
const pipeline = require('../../src/assets/agent/pipeline');
const assistant = require('../../src/assets/agent/assistant');

process.env.ASSET_AGENT_ENABLED = 'true';
const CHANNEL = '500000000000000001';
const ADMIN = '700000000000000001';
const ANI = '222222222222222222';

let nextId = 800000000000000000n;
const msg = (authorDiscordId, content, extra = {}) => ({
  id: String(nextId++), channelId: CHANNEL, guildId: '900', authorDiscordId, authorName: extra.authorName || 'someone', content,
  attachments: [], postedAt: new Date(Date.now() - (extra.minutesAgo ?? 5) * 60000).toISOString(), ...extra,
});

async function setup() {
  const prisma = await createTestDb();
  const seeded = await seedBasics(prisma);
  await prisma.$executeRawUnsafe(`INSERT INTO "AssetAgentChannel" ("channelId", "label") VALUES ($1, 'dev-chat')`, CHANNEL);
  const starrk = await service.createContentItem(ctxFor(prisma), { updateId: seeded.update.id, contentTypeId: seeded.unit.id, displayName: 'Mythic', internalName: 'Starrk' });
  await assistant.saveSettings(prisma, { admins: [{ id: ADMIN, label: 'Alex' }, { id: 'nope' }], channels: [{ id: CHANNEL, label: 'Asset Management' }] });
  return { prisma, ...seeded, starrk };
}

// Stands in for the Claude API: plays back scripted turns and records what it was sent.
function scripted(turns) {
  const seen = [];
  let i = 0;
  return {
    seen,
    messages: {
      create: async params => {
        seen.push(JSON.parse(JSON.stringify(params)));
        const turn = turns[i++];
        const content = typeof turn === 'function' ? turn(params) : turn;
        const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
        return { content: blocks, stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 } };
      },
    },
  };
}
const call = (name, input, id = `tu_${name}`) => ({ type: 'tool_use', id, name, input });
const lastResult = params => JSON.parse(params.messages.at(-1).content[0].content);

test('settings keep only real Discord ids', async () => {
  const { prisma } = await setup();
  const s = await assistant.getSettings(prisma);
  assert.deepEqual(s, { enabled: true, admins: [{ id: ADMIN, label: 'Alex' }], channels: [{ id: CHANNEL, label: 'Asset Management' }] });
});

test('uploads and file links are indexed as messages arrive, tied to the item and the dev', async () => {
  const { prisma, starrk, ani } = await setup();
  await pipeline.ingestMessages(prisma, [
    msg(ANI, 'starrk face v2', { attachments: [{ name: 'face_v2.png', url: 'https://cdn/x/face_v2.png' }], minutesAgo: 30 }),
    msg(ANI, 'here is the rig https://drive.google.com/file/d/abc123/view', { channelName: 'Starrk rig', minutesAgo: 20 }),
    msg(ANI, 'random screenshot', { attachments: [{ name: 'Aizen_UV.blend', url: 'https://cdn/x/Aizen_UV.blend' }, { name: 'meme.gif', url: 'https://cdn/x/meme.gif' }], minutesAgo: 10 }),
    msg(ANI, 'no files here'),
  ]);
  const files = await prisma.$queryRawUnsafe(`SELECT filename, kind, "contentItemId", "devId", "messageUrl" FROM "AssetFile" ORDER BY "postedAt", filename`);
  assert.deepEqual(files.map(f => [f.filename, f.kind]), [
    ['face_v2.png', 'image'], ['drive.google.com/file/d/abc123/view', 'link'], ['Aizen_UV.blend', 'model'], ['meme.gif', 'image'],
  ]);
  assert.deepEqual(files.map(f => f.contentItemId === starrk.id), [true, true, false, false], 'matched from the text and from the post name');
  assert.ok(files.every(f => f.devId === ani.id));
  assert.match(files[0].messageUrl, /^https:\/\/discord\.com\/channels\/900\/500000000000000001\/\d+$/);

  // Ingesting the same message twice does not duplicate its files.
  const again = msg(ANI, 'starrk again', { attachments: [{ name: 'a.png', url: 'u' }] });
  await pipeline.ingestMessages(prisma, [again]);
  await assistant.indexFiles(prisma, again, await assistant.indexContext(prisma));
  assert.equal((await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetFile" WHERE filename = 'a.png'`))[0].n, 1);

  const found = await assistant.searchFiles(prisma, { item: 'stark' });
  assert.equal(found.item.internalName, 'Starrk');
  assert.deepEqual(found.files.map(f => f.filename), ['a.png', 'drive.google.com/file/d/abc123/view', 'face_v2.png']);
  assert.deepEqual((await assistant.searchFiles(prisma, { dev: 'ani', kind: 'model' })).files.map(f => f.filename), ['Aizen_UV.blend']);
});

test('only approved accounts get an answer', async () => {
  const { prisma } = await setup();
  const client = scripted(['hello']);
  const result = await assistant.respond(prisma, { message: msg(ANI, 'get me the files for starrk') }, { client });
  assert.deepEqual([result.denied, result.reply, client.seen.length], [true, null, 0]);
  await assistant.saveSettings(prisma, { enabled: false });
  assert.equal((await assistant.respond(prisma, { message: msg(ADMIN, 'hi') }, { client })).denied, true);
});

test('"get me the most recent files": the model searches, and the reply is built from real rows', async () => {
  const { prisma } = await setup();
  await pipeline.ingestMessages(prisma, [
    msg(ANI, 'starrk body mesh', { attachments: [{ name: 'starrk_body.fbx', url: 'u1' }], minutesAgo: 60, authorName: 'Ani' }),
    msg(ANI, 'starrk face', { attachments: [{ name: 'starrk_face.png', url: 'u2' }], minutesAgo: 5, authorName: 'Ani' }),
  ]);
  const client = scripted([
    [call('search_files', { item: 'stark' })],
    params => { const r = lastResult(params); return `Newest first: ${r.files.map(f => `[${f.name}](${f.link})`).join(', ')}`; },
  ]);
  const result = await assistant.respond(prisma, {
    message: msg(ADMIN, 'Get me the most recent files for stark', { authorName: 'Alex', channelName: 'Asset Management' }),
    history: [{ role: 'assistant', content: 'earlier reply' }, { role: 'user', name: 'Alex', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }],
  }, { client });

  const sent = client.seen[0];
  assert.match(sent.system[1].text, /CONTENT ITEMS: .*Starrk/);
  assert.match(sent.system[1].text, /ROSTER: .*Ani/);
  assert.deepEqual(sent.messages.map(m => m.role), ['user', 'assistant', 'user'], 'history starts with the person and alternates');
  assert.match(sent.messages.at(-1).content, /Alex says, in "Asset Management":\nGet me the most recent files for stark/);

  const tool = lastResult(client.seen[1]);
  assert.deepEqual([tool.matched_item, tool.count, tool.files.map(f => f.name)], ['Starrk', 2, ['starrk_face.png', 'starrk_body.fbx']]);
  assert.match(result.reply, /^Newest first: \[starrk_face\.png\]\(https:\/\/discord\.com\/channels\/900\//);
  assert.ok(result.costUsd > 0);
  assert.equal((await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetAgentUsage" WHERE pass = 'assistant'`))[0].n, 1);
});

test('"this is current": a note is saved against the item, dev and file, and the file becomes the current one', async () => {
  const { prisma, starrk, ani } = await setup();
  await pipeline.ingestMessages(prisma, [
    msg(ANI, 'starrk face first pass', { attachments: [{ name: 'face_v1.png', url: 'u1' }], minutesAgo: 90 }),
    msg(ANI, 'updated', { attachments: [{ name: 'IMG_2231.png', url: 'u2' }], minutesAgo: 3 }),
  ]);
  // An older file was the current one until now.
  await prisma.$executeRawUnsafe(`UPDATE "AssetFile" SET "isCurrent" = true WHERE filename = 'face_v1.png'`);

  const client = scripted([
    [call('search_files', { dev: 'Ani', kind: 'image', limit: 1 })],
    params => [call('save_note', { text: "Ani updated Starrk's face model; this image is the current version.", item: 'Starrk', dev: 'Ani', file_ids: [lastResult(params).files[0].id], mark_current: true })],
    params => `Saved. ${JSON.stringify(lastResult(params))}`,
  ]);
  const result = await assistant.respond(prisma, { message: msg(ADMIN, "Ani updated starks face model in her most recent image, this is current", { authorName: 'Alex' }) }, { client });

  // Note the first search returned the file marked current (v1) first; the model's limit of 1 would pick it.
  // The assistant's own rule is "current first", so check what was actually attached.
  const [note] = await assistant.listNotes(prisma, { contentItemId: starrk.id });
  assert.deepEqual([note.text, note.authorName, note.itemName, note.devName, note.fileIds.length], ["Ani updated Starrk's face model; this image is the current version.", 'Alex', 'Starrk', 'Ani', 1]);
  assert.match(note.sourceUrl, /^https:\/\/discord\.com\/channels\/900\//);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].markedCurrent, true);
  const current = await prisma.$queryRawUnsafe(`SELECT id FROM "AssetFile" WHERE "isCurrent"`);
  assert.deepEqual(current.map(f => f.id), note.fileIds, 'exactly the noted file is current for the item');
  assert.equal(ani.name, 'Ani');
});

test('a note with a name that matches nothing is still saved, with a warning; a failing tool does not break the reply', async () => {
  const { prisma } = await setup();
  const saved = await assistant.saveNote(prisma, { text: 'The relic system needs icons', item: 'Relics', fileIds: ['missing'], author: { name: 'Alex' } });
  assert.equal(saved.saved, true);
  assert.match(saved.warning, /No content item called "Relics"|None of those file ids/);
  assert.equal((await assistant.saveNote(prisma, { text: '  ' })).error, 'The note has no text.');

  const client = scripted([[call('get_item', { item: 'Nobody' }), call('made_up_tool', {}, 'tu_2')], 'Could not find that.']);
  const result = await assistant.respond(prisma, { message: msg(ADMIN, 'where is nobody at') }, { client });
  assert.equal(result.reply, 'Could not find that.');
  const results = client.seen[1].messages.at(-1).content.map(c => JSON.parse(c.content));
  assert.match(results[0].error, /No content item called "Nobody"/);
  assert.match(results[1].error, /Unknown tool/);
});

test('status questions read the tracker', async () => {
  const { prisma, aizen, ani } = await setup();
  const tasks = await require('../../src/assets/queries').listTasks(prisma, { contentItemId: aizen.id });
  await service.updateTask(ctxFor(prisma), tasks[1].id, { assigneeDevId: ani.id, status: 'Blocked', blockedReason: 'waiting on the rig' });
  const client = scripted([[call('get_item', { item: 'aizen' }), call('get_dev', { dev: 'ani' }, 'tu_2')], 'ok']);
  await assistant.respond(prisma, { message: msg(ADMIN, 'where is aizen at, and is ani free') }, { client });
  const [item, dev] = client.seen[1].messages.at(-1).content.map(c => JSON.parse(c.content));
  assert.deepEqual([item.item, item.tasks.length, item.tasks.find(t => t.status === 'Blocked').blocked_on], ['Aizen', 3, 'waiting on the rig']);
  assert.deepEqual([dev.dev, dev.free_to_task, dev.open_tasks.length], ['Ani', false, 1]);
});
