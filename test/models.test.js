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
  }, prisma);
  assert.equal(saved.Junk, 'drop');

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
  delete given.plan.embed; delete given.plan.scale;
  assert.deepEqual(given.plan, {
    rename: {
      Arm: 'Right Arm', 'Arm.001': 'Left Arm', Cube: 'Head', Head: 'Head Accessory 1', Hair: 'Head Accessory 2',
      Strap: 'Left Arm Accessory 1', 'Strap.001': 'Left Arm Accessory 2',
    },
    drop: ['Junk'],
  });
  assert.ok((await store.get(id, prisma)).exportedAt);
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
  const fbx = await blender.exportFbx(blend, { rename: { [first.name]: 'Head', [second.name]: 'Head Accessory 1' }, drop: [], embed: true, scale: 0.01 });
  assert.match(fbx.subarray(0, 20).toString('latin1'), /Kaydara FBX Binary/);
  assert.ok(fbx.includes(Buffer.from('Head Accessory 1')));
});
