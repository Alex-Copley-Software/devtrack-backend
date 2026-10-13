// Teams: groups of disciplines with a Discord category, and the matching of
// each dev's forum in that category to the roster.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDb, ctxFor, seedBasics } = require('./helpers');
const service = require('../../src/assets/service');
const q = require('../../src/assets/queries');
const teams = require('../../src/assets/teams');
const pipeline = require('../../src/assets/agent/pipeline');
const assistant = require('../../src/assets/agent/assistant');

const VFX_CAT = '700000000000000001';
const ART_CAT = '700000000000000002';

test('the four starting teams exist once, and a discipline belongs to one team only', async () => {
  const prisma = await createTestDb();
  const list = await teams.listTeams(prisma);
  assert.deepEqual(list.map(t => [t.name, t.disciplines]), [
    ['Modelers', ['Unit Mesh', 'Unit Texture']], ['Artists', ['Art']], ['Animators', ['Animation', 'Rigging']], ['VFX', ['VFX', 'VFX Scripting']],
  ]);

  const vfx = list.find(t => t.name === 'VFX');
  const saved = await teams.saveTeam(prisma, vfx.id, { discordCategoryId: `https://discord.com/channels/900/${VFX_CAT}` });
  assert.equal(saved.discordCategoryId, VFX_CAT, 'a link is reduced to the id');
  assert.deepEqual(saved.disciplines, ['VFX', 'VFX Scripting'], 'untouched fields stay');
  await assert.rejects(teams.saveTeam(prisma, vfx.id, { discordCategoryId: 'the vfx one' }), /must be its ID/);
  await assert.rejects(teams.saveTeam(prisma, null, { name: 'vfx' }), /already a team called vfx/);
  await assert.rejects(teams.saveTeam(prisma, null, { name: 'Sound', disciplines: ['SFX', 'Animation'] }), /Already on another team: Animation \(Animators\)/);
  await assert.rejects(teams.saveTeam(prisma, null, { name: 'Sound', disciplines: ['Whistling'] }), /Not a discipline/);
  await assert.rejects(teams.saveTeam(prisma, null, { name: 'Sound', discordCategoryId: VFX_CAT }), /already uses that Discord category/);
  const sound = await teams.saveTeam(prisma, null, { name: 'Sound', disciplines: ['SFX'] });
  assert.deepEqual([sound.name, sound.disciplines, sound.discordCategoryId], ['Sound', ['SFX'], null]);

  // The agent reads a team's category without it being added to the allowlist by hand.
  assert.ok((await pipeline.allowedChannelIds(prisma)).has(VFX_CAT));

  // Deleting every team does not bring the defaults back.
  for (const t of await teams.listTeams(prisma)) await teams.deleteTeam(prisma, t.id);
  assert.deepEqual(await teams.listTeams(prisma), []);
  assert.ok(!(await pipeline.allowedChannelIds(prisma)).has(VFX_CAT));
});

test('a forum in a team category is given to the dev it is named after', async () => {
  const prisma = await createTestDb();
  const ctx = ctxFor(prisma);
  const list = await teams.listTeams(prisma);
  await teams.saveTeam(prisma, list.find(t => t.name === 'VFX').id, { discordCategoryId: VFX_CAT });
  await teams.saveTeam(prisma, list.find(t => t.name === 'Artists').id, { discordCategoryId: ART_CAT });
  const drunken = await service.createDev(ctx, { name: 'Drunken', discipline: 'Art' });
  const don = await service.createDev(ctx, { name: 'Don', discipline: 'Art' });
  const ice = await service.createDev(ctx, { name: 'Ice', discipline: 'VFX' });
  const rein = await service.createDev(ctx, { name: 'Rein', discipline: 'VFX' });
  const reina = await service.createDev(ctx, { name: 'Reina', discipline: 'VFX' });
  const linked = async id => (await q.listDevs(prisma)).find(d => d.id === id).discordThreadId;

  const result = await teams.syncChannels(prisma, [
    { id: '710000000000000001', name: '🟡-drnken', categoryId: ART_CAT },      // a near miss, inside the team
    { id: '710000000000000002', name: 'ICE', categoryId: VFX_CAT },            // exact, whatever the case or decoration
    { id: '710000000000000003', name: 'qwinkle', categoryId: VFX_CAT },        // nobody
    { id: '710000000000000004', name: '🔵admin', categoryId: VFX_CAT },        // not a person
    { id: '710000000000000005', name: 'reins', categoryId: VFX_CAT },          // could be Rein or Reina: not guessed
    { id: '710000000000000006', name: 'don', categoryId: '799999999999999999' }, // not a team category
    { id: '710000000000000007', name: 'drunkn', categoryId: VFX_CAT },         // a near miss for an Artist, but in the VFX category
  ]);
  assert.deepEqual(result.linked.map(l => [l.channelId, l.dev, l.team]), [['710000000000000001', 'Drunken', 'Artists'], ['710000000000000002', 'Ice', 'VFX']]);
  assert.deepEqual(result.unlinked.map(u => [u.channelId, u.channelName, u.team]), [['710000000000000003', 'qwinkle', 'VFX'], ['710000000000000004', '🔵admin', 'VFX'], ['710000000000000005', 'reins', 'VFX'], ['710000000000000007', 'drunkn', 'VFX']]);
  assert.deepEqual([await linked(drunken.id), await linked(ice.id), await linked(don.id), await linked(rein.id), await linked(reina.id)], ['710000000000000001', '710000000000000002', null, null, null]);
  assert.ok((await pipeline.allowedChannelIds(prisma)).has('710000000000000001'), 'a linked forum is read like any dev channel');

  // Running it again changes nothing and logs nothing new.
  const audit = async () => (await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "AssetActivity"`))[0].n;
  const before = await audit();
  const again = await teams.syncChannels(prisma, [{ id: '710000000000000001', name: '🟢-drnken', categoryId: ART_CAT }, { id: '710000000000000003', name: 'qwinkle', categoryId: VFX_CAT }]);
  assert.deepEqual([again.linked, again.unlinked.map(u => u.channelId), await audit()], [[], ['710000000000000003'], before]);

  // A person settles the rest: this one is Rein's, that one is nobody's.
  await teams.syncChannels(prisma, [{ id: '710000000000000003', name: 'qwinkle', categoryId: VFX_CAT }, { id: '710000000000000004', name: '🔵admin', categoryId: VFX_CAT }, { id: '710000000000000005', name: 'reins', categoryId: VFX_CAT }]);
  await teams.resolveChannel(prisma, '710000000000000005', { devId: rein.id }, ctx);
  const left = await teams.resolveChannel(prisma, '710000000000000004', { ignore: true }, ctx);
  assert.deepEqual(left.unlinked.map(u => u.channelId), ['710000000000000003']);
  assert.equal(await linked(rein.id), '710000000000000005');
  const later = await teams.syncChannels(prisma, [{ id: '710000000000000003', name: 'qwinkle', categoryId: VFX_CAT }, { id: '710000000000000004', name: '🔵admin', categoryId: VFX_CAT }, { id: '710000000000000005', name: 'reins', categoryId: VFX_CAT }]);
  assert.deepEqual(later.unlinked.map(u => u.channelId), ['710000000000000003'], 'an ignored channel stays ignored');
  await assert.rejects(teams.resolveChannel(prisma, '710000000000000003', {}, ctx), /Choose a dev/);
});

test('the assistant can answer for a team', async () => {
  const prisma = await createTestDb();
  const { ani, aizen, update } = await seedBasics(prisma);
  await assistant.saveSettings(prisma, { admins: [{ id: '111111111111111111', label: 'Alex' }], channels: [] });
  const [task] = (await q.listTasksDetailed(prisma, { contentItemId: aizen.id })).filter(t => t.discipline === 'Animation');
  await service.updateTask(ctxFor(prisma), task.id, { assigneeDevId: ani.id, status: 'In Progress' });

  let turn = 0;
  const seen = [];
  const client = { messages: { create: async params => {
    seen.push(params);
    const blocks = turn++ === 0 ? [{ type: 'tool_use', id: 'tu', name: 'get_team', input: { team: 'the animator team', update: 'bleach' } }] : [{ type: 'text', text: params.messages.at(-1).content[0].content }];
    return { content: blocks, stop_reason: turn === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  } } };
  const result = await assistant.respond(prisma, { message: { id: '710000000000000001', channelId: '710000000000000002', guildId: '900', authorDiscordId: '111111111111111111', authorName: 'Alex', content: 'how are the animators doing on bleach', attachments: [] } }, { client });
  const told = JSON.parse(result.reply);
  assert.deepEqual([told.team, told.disciplines, told.scope], ['Animators', ['Animation', 'Rigging'], `update ${update.number} Bleach`]);
  assert.deepEqual(told.tasks, { total: 1, done: 0, in_progress: 1, review: 0, blocked: 0, not_started: 0 });
  assert.deepEqual(told.members, [{ dev: 'Ani', status: 'Active', open_tasks: 1, free_to_task: false }]);
  assert.match(seen[0].system[1].text, /TEAMS: Modelers \(Unit Mesh, Unit Texture\); Artists \(Art\); Animators \(Animation, Rigging\); VFX \(VFX, VFX Scripting\)/);
});
