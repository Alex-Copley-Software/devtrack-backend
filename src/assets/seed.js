// Demo data for the Assets page: two fake updates, a roster and task
// templates, so the page can be shown without importing the real sheet.
// Everything it creates is marked so removeDemo() can take it out again.

const q = require('./queries');
const service = require('./service');

const DEMO_NOTE = 'Demo seed';
const DEMO_UPDATE_NUMBERS = [900, 901];

const TEMPLATES = {
  'Unit': [
    ['Design', 'Unit design brief', 'Kit, role, rarity, element, archetype, attack type and placement type locked'],
    ['Art', 'Concept art', 'Front, side and back views approved by the lead'],
    ['Unit Mesh', 'Unit mesh', 'Mesh under triangle budget and imported to Studio'],
    ['Unit Texture', 'Unit textures', 'Textures applied and matching concept'],
    ['Rigging', 'Rig', 'Rig passes the standard pose test'],
    ['Animation', 'Idle, walk and attack animations', 'All animations exported with asset IDs in notes'],
    ['VFX', 'Ability VFX', 'Each ability has VFX approved in game'],
    ['VFX Scripting', 'VFX hookup', 'VFX fire on the right animation events', false],
    ['SFX', 'Ability sounds', 'Sounds mixed and attached', false],
    ['Data', 'Stats and upgrade table', 'Stats entered for every upgrade level'],
    ['Engineers', 'Ability scripting', 'Abilities work in a test place with no errors'],
    ['UI', 'Unit icon and card', 'Icon and card art in the inventory'],
    ['QA', 'Balance and bug pass', 'Tested on live-like settings, no blockers'],
  ],
  'Map / Stage': [
    ['Design', 'Stage layout brief', 'Path, placement zones and wave plan locked'],
    ['Builder', 'Blockout', 'Playable blockout with final path'],
    ['Builder', 'Final build', 'Detail pass complete and optimized'],
    ['Art', 'Skybox and lighting', 'Lighting matches the reference mood'],
    ['Data', 'Wave data', 'All waves entered and tuned'],
    ['QA', 'Playthrough', 'Full clear on every difficulty'],
  ],
  'Boss': [
    ['Design', 'Boss design brief', 'Phases, attacks and weaknesses locked'],
    ['Unit Mesh', 'Boss mesh', 'Mesh imported and scaled'],
    ['Rigging', 'Boss rig', 'Rig supports every attack'],
    ['Animation', 'Boss animations', 'Intro, attacks, stagger and death'],
    ['VFX', 'Boss VFX', 'Telegraphs readable at a glance'],
    ['Engineers', 'Boss AI', 'All phases scripted'],
    ['QA', 'Boss fight pass', 'Beatable, no soft locks'],
  ],
  'Enemy': [
    ['Design', 'Enemy brief', 'Role and stats locked'],
    ['Unit Mesh', 'Enemy mesh', 'Mesh imported'],
    ['Animation', 'Enemy animations', 'Walk and death'],
    ['Data', 'Enemy stats', 'Entered in the wave table'],
  ],
  'Portal': [
    ['Design', 'Portal rules', 'Modifiers and rewards locked'],
    ['Data', 'Portal data', 'Drop table entered'],
    ['QA', 'Portal pass', 'Rewards verified'],
  ],
  'Skin': [
    ['Art', 'Skin concept', 'Approved by the lead'],
    ['Unit Texture', 'Skin textures', 'Applied in game'],
    ['VFX', 'Skin VFX recolor', 'Recolored and approved', false],
    ['UI', 'Skin icon', 'Icon in the shop'],
  ],
  'Update Launch': [
    ['Manager', 'Patch notes', 'Published to Discord'],
    ['Engineers', 'Release build', 'Published to the live place'],
    ['QA', 'Smoke test', 'Core loop verified on live'],
    ['Manager', 'Announcement', 'Trailer and codes posted'],
  ],
};

const DEVS = [
  ['MrBee', 'Manager', 'Design'], ['Kaido', 'Design', 'Data'], ['Sora', 'Art', 'UI'], ['Mesh', 'Unit Mesh', 'Rigging'],
  ['Tex', 'Unit Texture', 'Art'], ['Ani', 'Animation', 'Rigging'], ['Vex', 'VFX', 'VFX Scripting'], ['Echo', 'SFX', null],
  ['Ricky', 'Engineers', 'Data'], ['Brick', 'Builder', 'Art'], ['Quinn', 'QA', null], ['Juno', 'Animation', 'VFX'],
];

const ITEMS = [
  // [update, type, display, internal, owner, priority, done ratio]
  [900, 'Unit', 'Mythic', 'Aizen', 'Kaido', 'High', 0.7],
  [900, 'Unit', 'Secret', 'Ulquiorra', 'Kaido', 'High', 0.45],
  [900, 'Unit', 'Legendary', 'Ichigo', 'MrBee', 'Medium', 0.9],
  [900, 'Unit', 'Epic', 'Rukia', null, 'Low', 0.1],
  [900, 'Map / Stage', 'Story stage', 'HuecoMundo', 'Brick', 'High', 0.5],
  [900, 'Boss', 'Raid boss', 'Yhwach', 'MrBee', 'High', 0.3],
  [900, 'Enemy', 'Hollow', 'HollowGrunt', 'Kaido', 'Low', 1],
  [900, 'Portal', 'Soul portal', 'SoulPortal', null, 'Medium', 0],
  [900, 'Skin', 'Aizen (Hogyoku)', 'AizenHogyoku', 'Sora', 'Low', 0.25],
  [900, 'Update Launch', 'Launch', 'BleachLaunch', 'MrBee', 'High', 0],
  [901, 'Unit', 'Mythic', 'Gojo', 'Kaido', 'High', 0.05],
  [901, 'Unit', 'Secret', 'Sukuna', null, 'High', 0],
  [901, 'Map / Stage', 'Story stage', 'Shibuya', 'Brick', 'Medium', 0],
];

// Small deterministic generator so the demo looks the same every time.
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function hasDemo(prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT id FROM "AssetUpdate" WHERE "number" = ANY($1::int[])`, DEMO_UPDATE_NUMBERS);
  return rows.length > 0;
}

// big: adds enough filler items to push the task table past 6,000 rows.
async function seedDemo(prisma, { big = false } = {}) {
  const ctx = { prisma, source: 'import', actor: { userId: null, name: DEMO_NOTE }, silent: true };
  if (await hasDemo(prisma)) throw new Error('Demo data already exists. Remove it first.');

  const types = await q.listContentTypes(prisma);
  const typeId = name => types.find(t => t.name === name)?.id;
  for (const [typeName, rows] of Object.entries(TEMPLATES)) {
    const type = types.find(t => t.name === typeName);
    if (!type || type.templateCount) continue; // never add to a checklist that already exists
    for (const [discipline, deliverable, definitionOfDone, required] of rows) {
      await service.createTemplate(ctx, { contentTypeId: type.id, discipline, deliverable, definitionOfDone, required: required !== false });
    }
  }

  const existingDevs = await q.listDevs(prisma);
  const devId = {};
  for (const [i, [name, discipline, secondaryDiscipline]] of DEVS.entries()) {
    const found = existingDevs.find(d => d.name.toLowerCase() === name.toLowerCase());
    devId[name] = found ? found.id : (await service.createDev(ctx, {
      name, discipline, secondaryDiscipline, notes: DEMO_NOTE,
      status: name === 'Echo' ? 'On Break' : 'Active',
      discordProfileUrl: `https://discord.com/users/9000000000000000${String(i).padStart(2, '0')}`,
    })).id;
  }

  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const updates = {
    900: await service.createUpdate(ctx, { number: 900, name: 'Soul Society (demo)', status: 'In Development', targetRelease: day(21), leadDevId: devId.MrBee, notionUrl: 'https://www.notion.so/demo/Soul-Society', notes: 'Demo data. Safe to delete.' }),
    901: await service.createUpdate(ctx, { number: 901, name: 'Cursed City (demo)', status: 'Planning', targetRelease: day(70), leadDevId: devId.Kaido, notes: 'Demo data. Safe to delete.' }),
  };

  const items = [...ITEMS];
  if (big) {
    for (let i = 0; i < 480; i++) items.push([i % 2 ? 900 : 901, 'Unit', 'Filler', `FillerUnit${String(i + 1).padStart(3, '0')}`, null, 'Low', (i % 10) / 10]);
  }

  const devs = await q.listDevs(prisma);
  const byDiscipline = discipline => devs.filter(d => d.disciplines.includes(discipline) && d.status !== 'Inactive');
  const rand = rng(42);
  const patches = [];
  for (const [number, typeName, displayName, internalName, owner, priority, doneRatio] of items) {
    const item = await service.createContentItem(ctx, {
      updateId: updates[number].id, contentTypeId: typeId(typeName), displayName, internalName, priority,
      ownerDevId: owner ? devId[owner] : null,
      notionUrl: internalName === 'Aizen' ? 'https://www.notion.so/demo/Aizen' : null,
    });
    const tasks = await q.listTasksDetailed(prisma, { contentItemId: item.id });
    tasks.forEach((task, index) => {
      const position = (index + rand() * 0.8) / tasks.length;
      const pool = byDiscipline(task.discipline);
      const assignee = pool.length && rand() > 0.15 ? pool[Math.floor(rand() * pool.length)] : null;
      const patch = {};
      if (position < doneRatio) patch.status = 'Done';
      else if (position < doneRatio + 0.12) patch.status = rand() > 0.5 ? 'Review' : 'In Progress';
      else if (position < doneRatio + 0.2) patch.status = 'In Progress';
      else if (rand() > 0.94) patch.status = 'Blocked';
      else if (!task.required && rand() > 0.6) patch.status = 'N/A';
      if (assignee && (patch.status || rand() > 0.4)) patch.assigneeDevId = assignee.id;
      if (patch.status && patch.status !== 'Done' && patch.status !== 'N/A') patch.dueDate = day(Math.floor(rand() * 24) - 5);
      if (patch.status === 'Blocked') patch.notes = 'Blocked: waiting on the design brief';
      if (patch.status === 'Done' && task.discipline === 'Animation') patch.notes = `rbxassetid://${1000000 + Math.floor(rand() * 8999999)}`;
      if (Object.keys(patch).length) patches.push({ id: task.id, patch });
    });
  }
  await service.applyTaskPatches(ctx, patches);
  return { updates: Object.keys(updates).length, items: items.length, devs: DEVS.length };
}

async function removeDemo(prisma) {
  await prisma.$executeRawUnsafe(`DELETE FROM "AssetUpdate" WHERE "number" = ANY($1::int[])`, DEMO_UPDATE_NUMBERS);
  // Only roster entries the seed created, and only if nothing real points at them.
  await prisma.$executeRawUnsafe(`
    DELETE FROM "AssetDev" d WHERE d.notes = $1
      AND NOT EXISTS (SELECT 1 FROM "AssetTask" t WHERE t."assigneeDevId" = d.id)
      AND NOT EXISTS (SELECT 1 FROM "AssetContentItem" ci WHERE ci."ownerDevId" = d.id)
      AND NOT EXISTS (SELECT 1 FROM "AssetUpdate" u WHERE u."leadDevId" = d.id)`, DEMO_NOTE);
}

module.exports = { seedDemo, removeDemo, hasDemo, DEMO_UPDATE_NUMBERS };
