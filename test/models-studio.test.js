// Send to Studio: the job a model goes through on its way to the Mac worker,
// and the worker's routes behind STUDIO_WORKER_SECRET.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const store = require('../src/models/store');

async function createDb() {
  const pg = new PGlite();
  await pg.exec(`SET TIME ZONE 'UTC'`);
  return {
    pg,
    $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).affectedRows ?? 0,
  };
}

const PARTS = ['Cube', 'Cube.001'].map(name => ({ name, verts: 8 }));
const fakeInspect = async () => ({ glb: Buffer.from('glTF fake'), parts: PARTS, blender: '5.2.3' });
const BLEND = Buffer.concat([Buffer.from('BLENDER-v405'), Buffer.alloc(32)]);
const until = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timed out'); };

async function readyModel(prisma, name = 'Gowther.blend') {
  const { id } = await store.create({ name, blend: BLEND }, prisma, fakeInspect);
  await until(async () => (await store.get(id, prisma, fakeInspect)).status === 'ready');
  await store.setAssignments(id, { Cube: 'Head', 'Cube.001': 'Torso' }, prisma);
  return id;
}

test('a model is queued, claimed, reported on and finished', async () => {
  const prisma = await createDb();
  const id = await readyModel(prisma);
  assert.equal((await store.get(id, prisma)).studio, null, 'never sent');
  assert.equal(await store.claimStudio(prisma), null, 'nothing to take');

  let given = null;
  const studio = await store.sendToStudio(id, 'Alex', prisma, async (blend, plan) => { given = plan; return Buffer.from('FBX bytes'); }, { smallScale: true, embedTextures: false, turn: 180 });
  assert.equal(studio.status, 'queued');
  assert.equal(studio.by, 'Alex');
  assert.deepEqual(studio.options, { embedTextures: false, smallScale: true, turn: 180 });
  assert.equal(given.embed, false, 'exported with the chosen options');
  assert.equal(given.scale, 0.01);
  assert.deepEqual(given.rename, { Cube: 'Head', 'Cube.001': 'Torso' });
  await assert.rejects(store.sendToStudio(id, 'Alex', prisma, async () => Buffer.from('again')), /already on its way/);
  await assert.rejects(store.sendToStudio(id, 'Alex', prisma, async () => Buffer.from('x'), { turn: 45 }), /turn must be one of/, 'quarter turns only');
  assert.equal(await store.studioQueued(prisma), 1);

  const job = await store.claimStudio(prisma);
  assert.deepEqual(job, { id, name: 'Gowther', fbxName: 'Gowther.fbx', options: { embedTextures: false, smallScale: true, turn: 180 } });
  assert.equal((await store.get(id, prisma)).studio.status, 'uploading');
  assert.equal(await store.claimStudio(prisma), null, 'taken once only');
  assert.equal((await store.studioFbx(id, prisma)).data.toString(), 'FBX bytes', 'the FBX is kept');

  await assert.rejects(store.reportStudio(id, { status: 'queued' }, prisma), /status must be/);
  await assert.rejects(store.reportStudio(id, { status: 'importing', assetId: '12; DROP' }, prisma), /assetId/);
  await store.reportStudio(id, { status: 'importing', assetId: 1234567890 }, prisma);
  await store.reportStudio(id, { status: 'done', result: { name: 'Gowther_2', welded: ['Head'], unmatched: [] } }, prisma);
  const done = (await store.get(id, prisma)).studio;
  assert.equal(done.status, 'done');
  assert.equal(done.assetId, '1234567890', 'the asset id stays when a later report leaves it out');
  assert.equal(done.result.name, 'Gowther_2');
  assert.equal(done.error, null);
  assert.ok(done.at);
  await assert.rejects(store.reportStudio(id, { status: 'failed', error: 'late' }, prisma), /not being sent/, 'a finished job stays finished');

  // Sending again starts a fresh job.
  const again = await store.sendToStudio(id, 'Sam', prisma, async () => Buffer.from('FBX 2'));
  assert.equal(again.status, 'queued');
  assert.equal(again.assetId, null);
  assert.equal(again.result, null);
  assert.deepEqual(again.options, { embedTextures: true, smallScale: true, turn: 0 }, 'not turned unless asked');
  assert.equal((await store.list(prisma))[0].studio.status, 'queued');
});

test('a failure keeps its error, and a job the Mac went quiet on fails by itself', async () => {
  const prisma = await createDb();
  const a = await readyModel(prisma, 'A.blend');
  const b = await readyModel(prisma, 'B.blend');
  await store.sendToStudio(a, 'Alex', prisma, async () => Buffer.from('A'));
  await store.sendToStudio(b, 'Alex', prisma, async () => Buffer.from('B'));
  assert.equal((await store.claimStudio(prisma)).id, a, 'oldest first');
  await store.reportStudio(a, { status: 'failed', error: 'Studio is not open on the place' }, prisma);
  assert.match((await store.get(a, prisma)).studio.error, /not open/);

  assert.equal((await store.claimStudio(prisma)).id, b);
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "studioAt" = now() - interval '${store.STUDIO_STALE_MIN + 1} minutes' WHERE id = $1`, b);
  const stale = (await store.get(b, prisma)).studio;
  assert.equal(stale.status, 'failed');
  assert.match(stale.error, /stopped answering/);
});

test('a model that is not ready cannot be sent', async () => {
  const prisma = await createDb();
  const { id } = await store.create({ name: 'Slow.blend', blend: BLEND }, prisma, () => new Promise(() => {}));
  await assert.rejects(store.sendToStudio(id, 'Alex', prisma, async () => Buffer.from('x')), /not ready/);
});

test('worker routes need the secret', async () => {
  const { workerRouter } = require('../src/routes/models');
  const app = express();
  app.use(express.json());
  app.use('/w', workerRouter());
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/w/heartbeat`;
  const post = headers => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  const saved = process.env.STUDIO_WORKER_SECRET;
  try {
    delete process.env.STUDIO_WORKER_SECRET;
    assert.equal((await post({ 'x-studio-worker-secret': '' })).status, 503, 'off until the secret is set');
    process.env.STUDIO_WORKER_SECRET = 'right-secret';
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ 'x-studio-worker-secret': 'wrong-secret' })).status, 401);
    assert.equal((await post({ 'x-studio-worker-secret': 'right' })).status, 401);
  } finally {
    if (saved === undefined) delete process.env.STUDIO_WORKER_SECRET; else process.env.STUDIO_WORKER_SECRET = saved;
    server.close();
  }
});
