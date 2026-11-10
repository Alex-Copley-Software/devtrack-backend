// Model viewer: upload, conversion, naming, export plan.
// With BLENDER_PATH and MODEL_TEST_BLEND set, the last test runs real Blender.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');
const store = require('../src/models/store');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  return {
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).affectedRows ?? 0,
  };
}

const PARTS = ['Arm', 'Arm.001', 'Cube', 'Head', 'Hair', 'Strap', 'Strap.001', 'Junk'].map(name => ({ name, verts: 8 }));
const fakeInspect = async () => ({ glb: Buffer.from('glTF fake'), parts: PARTS, blender: '5.2.3' });
const BLEND = Buffer.concat([Buffer.from('BLENDER-v405'), Buffer.alloc(32)]);
const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out'); };

test('a .blend is stored, converted, named and planned for export', async () => {
  const prisma = await createDb();
  await assert.rejects(store.create({ name: 'x.blend', blend: Buffer.from('not a blend') }, prisma, fakeInspect), /not a \.blend/);

  const { id } = await store.create({ name: 'Unit.blend', blend: BLEND, uploadedBy: 'Alex', sourceUrl: 'https://discord.com/x' }, prisma, fakeInspect);
  await until(async () => (await store.get(id, prisma, fakeInspect)).status === 'ready');
  const model = await store.get(id, prisma, fakeInspect);
  assert.equal(model.partCount, 8);
  assert.deepEqual(model.assignments, { Head: 'Head' }, 'a part already called Head starts as Head');
  assert.equal((await store.file(id, 'glb', prisma)).data.toString(), 'glTF fake');
  assert.equal((await store.list(prisma))[0].assigned, 1);

  await assert.rejects(store.setAssignments(id, { Cube: 'Torso', Arm: 'Torso' }, prisma), /Torso is on both/);
  await assert.rejects(store.setAssignments(id, { Nope: 'Torso' }, prisma), /No part/);
  await assert.rejects(store.setAssignments(id, { Cube: 'Tail' }, prisma), /not a category/);

  const saved = await store.setAssignments(id, {
    Cube: 'Head', Head: 'Head Accessory', Hair: 'Head Accessory', Arm: 'Right Arm', 'Arm.001': 'Left Arm',
    Strap: 'Left Arm Accessory', 'Strap.001': 'Left Arm Accessory', Junk: 'drop',
  }, prisma, { Hair: ' Hair! ', Strap: 'Sleeve', 'Strap.001': 'Sleeve' });
  assert.equal(saved.Junk, 'drop');
  assert.deepEqual((await store.get(id, prisma)).labels, { Hair: 'Hair', Strap: 'Sleeve', 'Strap.001': 'Sleeve' }, 'the word for an accessory is kept, cleaned');
  await store.setAssignments(id, saved, prisma); // saving names without words leaves the words alone
  assert.equal((await store.get(id, prisma)).labels.Hair, 'Hair');

  let given = null;
  const out = await store.exportModel(id, 'Alex', prisma, async (blend, plan) => { given = { blend, plan }; return Buffer.from('FBX'); });
  assert.equal(out.name, 'Unit.fbx');
  assert.equal(out.data.toString(), 'FBX');
  assert.deepEqual(given.blend, BLEND);
  assert.equal(given.plan.embed, true, 'textures embedded unless told no');
  assert.equal(given.plan.scale, 0.01, 'scaled to 0.01 unless told no');
  const plain = await store.exportModel(id, 'Alex', prisma, async (blend, plan) => plan, { embedTextures: false, smallScale: false });
  assert.equal(plain.data.embed, false);
  assert.equal(plain.data.scale, 1);
  assert.equal(given.plan.fixFaces, false, 'faces left alone unless asked (Invert Negative Faces defaults to No)');
  const inverted = await store.exportModel(id, 'Alex', prisma, async (blend, plan) => plan, { invertFaces: true });
  assert.equal(inverted.data.fixFaces, true);
  delete given.plan.embed; delete given.plan.scale; delete given.plan.fixFaces; delete given.plan.rigs;
  assert.deepEqual(given.plan.accessories, []);
  delete given.plan.accessories;
  // The house style of a finished unit: ArmRight, "Head Hair", numbered when there's no word, " 2" on a repeat.
  assert.deepEqual(given.plan, {
    rename: {
      Arm: 'ArmRight', 'Arm.001': 'ArmLeft', Cube: 'Head', Head: 'Head Accessory 1', Hair: 'Head Hair',
      Strap: 'ArmLeft Sleeve', 'Strap.001': 'ArmLeft Sleeve 2',
    },
    drop: ['Junk'],
  });
  assert.ok((await store.get(id, prisma)).exportedAt);
});

test('a part already named in the house style starts named', async () => {
  const prisma = await createDb();
  const inspect = async () => ({ glb: Buffer.from('glTF'), parts: ['ArmRight', 'legleft', 'Torso', 'Hat'].map(name => ({ name, verts: 8 })), blender: '5.2.3' });
  const { id } = await store.create({ name: 'Cid.blend', blend: BLEND }, prisma, inspect);
  await until(async () => (await store.get(id, prisma, inspect)).status === 'ready');
  assert.deepEqual((await store.get(id, prisma)).assignments, { ArmRight: 'Right Arm', legleft: 'Left Leg', Torso: 'Torso' });
});

test('a weapon is uploaded, attached, positioned and goes into the FBX with what the Mac needs', async () => {
  const prisma = await createDb();
  const { id: unit } = await store.create({ name: 'Cid.blend', blend: BLEND }, prisma, fakeInspect);
  const FBX = Buffer.concat([Buffer.from('Kaydara FBX Binary  '), Buffer.alloc(16)]);
  const swordInspect = async (data, format) => {
    assert.equal(format, 'fbx', 'an FBX is opened as one');
    return { glb: Buffer.from('glTF sword'), parts: [{ name: 'Sword', verts: 40 }, { name: 'Empty', verts: 0 }, { name: 'Sheath', verts: 12 }], blender: '5.2.3' };
  };
  const { id: sword } = await store.create({ name: 'Cid_Sword.fbx', blend: FBX, kind: 'accessory' }, prisma, swordInspect);
  await until(async () => (await store.get(unit, prisma, fakeInspect)).status === 'ready' && (await store.get(sword, prisma, swordInspect)).status === 'ready');
  assert.equal((await store.get(sword, prisma)).kind, 'accessory');
  await assert.rejects(store.exportModel(sword, 'Alex', prisma, async () => Buffer.from('x')), /already an FBX/);

  await assert.rejects(store.addAccessory(unit, { accessoryId: unit }, prisma), /its own accessory/);
  await assert.rejects(store.addAccessory(unit, { accessoryId: sword, spot: 'tail' }, prisma), /spot must be/);
  const acc = await store.addAccessory(unit, { accessoryId: sword }, prisma);
  assert.equal(acc.name, 'Cid Sword', 'named after the file');
  assert.equal(acc.spot, 'right-hand');
  assert.equal(acc.limb, 'Right Arm');
  assert.deepEqual((await store.get(sword, prisma)).attachedTo.map(a => a.name), ['Cid.blend']);

  await assert.rejects(store.exportModel(unit, 'Alex', prisma, async () => Buffer.from('x')), /Position Cid Sword/);
  await assert.rejects(store.updateAccessory(unit, acc.id, { placement: { matrix: [1, 2], handle: [0, 0, 0] } }, prisma), /16 numbers/);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, -1, 0, 1];
  await store.setAssignments(sword, { Sheath: 'drop' }, prisma);
  const moved = await store.updateAccessory(unit, acc.id, { name: 'Cid Sword', spot: 'left-hand', placement: { matrix, handle: [0.5, -1, 0] } }, prisma);
  assert.equal(moved.limb, 'Left Arm');

  let given = null;
  const out = await store.exportModel(unit, 'Alex', prisma, async (blend, plan) => { given = plan; return Buffer.from('FBX'); });
  assert.equal(given.accessories.length, 1);
  const [a] = given.accessories;
  assert.equal(a.prefix, 'A1');
  assert.equal(a.format, 'fbx');
  assert.deepEqual(a.data, FBX);
  assert.deepEqual(a.meshes, ['Sword'], 'empty meshes and parts left out of the accessory stay out');
  assert.deepEqual(a.matrix, matrix);
  assert.deepEqual(out.accessories, [{ name: 'Cid Sword', spot: 'left-hand', limb: 'Left Arm', handle: 'A1 Handle', meshes: { 'A1 Sword': 'Sword' }, doubleSided: false }]);
  assert.deepEqual(out.doubleSided, []);

  // Double sided: a unit part by its final name (a dropped one doesn't count), and every mesh of a marked accessory.
  await assert.rejects(store.setAssignments(unit, { Arm: 'Right Arm', Junk: 'drop' }, prisma, undefined, ['Nope']), /No part/);
  await store.setAssignments(unit, { Arm: 'Right Arm', Junk: 'drop' }, prisma, undefined, ['Arm', 'Hair', 'Junk']);
  assert.deepEqual((await store.get(unit, prisma)).doubleSided, ['Arm', 'Hair', 'Junk']);
  await store.setAssignments(unit, { Arm: 'Right Arm', Junk: 'drop' }, prisma); // saving names alone leaves it as it was
  assert.deepEqual((await store.get(unit, prisma)).doubleSided, ['Arm', 'Hair', 'Junk']);
  assert.equal((await store.updateAccessory(unit, acc.id, { doubleSided: true }, prisma)).doubleSided, true);
  const studio = await store.sendToStudio(unit, 'Alex', prisma, async () => Buffer.from('FBX'));
  assert.deepEqual(studio.options.accessories.map(x => x.meshes), out.accessories.map(x => x.meshes), 'the Mac gets the accessories with the job');
  assert.deepEqual(studio.options.doubleSided, ['ArmRight', 'Hair', 'A1 Sword']);

  await store.removeAccessory(unit, acc.id, prisma);
  assert.deepEqual((await store.get(unit, prisma)).accessories, []);
});

test('bending parts: a cape gets bones, a rigged .blend can be downloaded, edited and used while it still matches', async () => {
  const prisma = await createDb();
  const { id } = await store.create({ name: 'Cid.blend', blend: BLEND }, prisma, fakeInspect);
  await until(async () => (await store.get(id, prisma, fakeInspect)).status === 'ready');
  const names = { Cube: 'Torso', Hair: 'Torso Accessory', Strap: 'Head Accessory' };
  const cape = { kind: 'cape', bones: 4, smooth: 0.6, chains: [{ root: [0, 3, 0.5], tip: [0, 0.5, 0.9] }, { root: [0.5, 3, 0.5], tip: [0.6, 0.5, 0.9] }] };

  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Nope: cape }), /No part/);
  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...cape, bones: 9 } }), /1 to 8 bones/);
  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...cape, chains: [{ root: [0, 1, 0], tip: [0, 1, 0] }] } }), /same point/);
  await assert.rejects(store.setAssignments(id, names, prisma, undefined, undefined, { Hair: { ...cape, kind: 'tail' } }), /kind must be/);
  // A rig on a body part (Cube is Torso) is kept but not made: the body stays R6.
  await store.setAssignments(id, names, prisma, { Hair: 'Cape' }, undefined, { Hair: cape, Cube: { ...cape, chains: cape.chains.slice(0, 1) } });
  assert.equal(Object.keys((await store.get(id, prisma)).rigs).length, 2);

  let given = null;
  const out = await store.exportModel(id, 'Alex', prisma, async (blend, p) => { given = p; return Buffer.from('FBX'); });
  assert.equal(given.rigs.length, 1, 'only the accessory part is rigged');
  const [r] = given.rigs;
  assert.equal(r.mesh, 'Torso Cape');
  assert.deepEqual(r.names, ['Torso Cape A1', 'Torso Cape A2', 'Torso Cape A3', 'Torso Cape A4', 'Torso Cape B1', 'Torso Cape B2', 'Torso Cape B3', 'Torso Cape B4']);
  assert.deepEqual(out.rigged, [{ mesh: 'Torso Cape', bones: r.names }]);
  const studio = await store.sendToStudio(id, 'Alex', prisma, async () => Buffer.from('FBX'));
  assert.deepEqual(studio.options.rigged, out.rigged, 'the Mac learns which meshes bend');
  await store.claimStudio(prisma);
  await store.reportStudio(id, { status: 'done', result: {} }, prisma);

  // Download: the same plan, saved as a .blend, marked with what it was made from.
  const model = await store.get(id, prisma);
  let saved = null;
  const dl = await store.rigBlend(id, prisma, async (blend, p) => { saved = p; return Buffer.from('BLENDER rigged'); });
  assert.equal(dl.name, 'Cid_rigged.blend');
  assert.equal(saved.configHash, model.configHash);
  assert.equal(saved.rigs.length, 1);

  // Upload it back, edited: used for the FBX while it matches, with nothing left for Blender to add.
  const EDITED = Buffer.concat([Buffer.from('BLENDER-edited'), Buffer.alloc(16)]);
  await assert.rejects(store.uploadEdited(id, Buffer.from('nope'), 'Alex', prisma), /not a \.blend/);
  const editedInspect = async () => ({ glb: Buffer.from('glTF edited'), parts: PARTS, config: model.configHash, skinned: ['Torso Cape', 'Head Accessory 1'], armatures: 2, bones: 11 });
  await store.uploadEdited(id, EDITED, 'Alex', prisma, editedInspect);
  await until(async () => (await store.get(id, prisma, editedInspect)).edited?.status === 'ready');
  const withEdit = await store.get(id, prisma);
  assert.equal(withEdit.edited.matches, true);
  assert.equal(withEdit.edited.info.bones, 11);
  assert.equal((await store.file(id, 'editedGlb', prisma)).data.toString(), 'glTF edited');
  let fromEdit = null;
  const e = await store.exportModel(id, 'Alex', prisma, async (blend, p) => { fromEdit = { blend, p }; return Buffer.from('FBX'); });
  assert.deepEqual(fromEdit.blend, EDITED, 'made from the edited file');
  assert.deepEqual(fromEdit.p.rigs, []);
  assert.deepEqual(fromEdit.p.rename, {});
  assert.deepEqual(e.rigged, [{ mesh: 'Torso Cape' }, { mesh: 'Head Accessory 1' }], 'every skinned mesh in it, added bones and all');

  // A change on the page makes the edited file out of date: it's refused rather than quietly used.
  await store.setAssignments(id, { ...names, Junk: 'drop' }, prisma);
  assert.equal((await store.get(id, prisma)).edited.matches, false);
  await assert.rejects(store.exportModel(id, 'Alex', prisma, async () => Buffer.from('FBX')), /changed since the rigged \.blend/);
  await store.removeEdited(id, prisma);
  assert.equal((await store.get(id, prisma)).edited, null);
  const back = await store.exportModel(id, 'Alex', prisma, async (blend, p) => p);
  assert.equal(back.data.rigs.length, 1, 'back to the automatic rig');
});

test('a conversion that fails says why', async () => {
  const prisma = await createDb();
  const { id } = await store.create({ name: 'Bad.blend', blend: BLEND }, prisma, async () => { throw new Error('Blender said no'); });
  await until(async () => (await store.get(id, prisma, () => new Promise(() => {}))).status === 'failed');
  assert.match((await store.get(id, prisma)).error, /Blender said no/);
});

test('real Blender: convert and export', { skip: !(process.env.BLENDER_PATH && process.env.MODEL_TEST_BLEND) }, async () => {
  const blender = require('../src/models/blender');
  const blend = fs.readFileSync(process.env.MODEL_TEST_BLEND);
  const { glb, parts } = await blender.inspect(blend);
  assert.equal(glb.subarray(0, 4).toString(), 'glTF');
  assert.ok(parts.length > 1);
  const [first, second] = parts;
  const fbx = await blender.exportFbx(blend, { rename: { [first.name]: 'Head', [second.name]: 'Head Accessory 1' }, drop: [], embed: true, scale: 0.01, accessories: [] });
  assert.match(fbx.subarray(0, 20).toString('latin1'), /Kaydara FBX Binary/);
  assert.ok(fbx.includes(Buffer.from('Head Accessory 1')));
});
