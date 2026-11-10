// store.js
// The model viewer's files: a .blend the bot was handed in Discord, the GLB
// Blender made from it for the browser, the list of parts, and what each part
// was named on the viewer. Table "ModelFile", made on first use.
//
// What a part is called is stored as its category ("Head", "Head Accessory",
// or "drop" to leave it out) plus, for accessories, a word for it ("Hood").
// The final names are worked out at export (plan()), in the house style of a
// finished unit (Cid): the body meshes are Head, Torso, ArmRight, ArmLeft,
// LegRight, LegLeft; an accessory is its limb's mesh name and its word
// ("Head Hood", "ArmRight Sleeve"), or "<limb> Accessory N" with no word.
//
// Weapons and other accessories: any model can be attached to a unit
// ("ModelAccessory": which model, its name, the spot it hangs from, and where
// it sits, saved from the page). At export Blender adds its meshes to the
// unit's FBX at that spot, named "A<n> <mesh>", plus a marker "A<n> Handle"
// where the hand grips; the Mac turns those into the Cid structure (a Model
// under the limb with a Handle part, a Motor6D to each mesh and a Weld from
// the limb to the Handle).
//
// Bending parts (wings, capes, hair): the body stays R6, welded; an accessory part can be given
// a bone chain ("rigs", per part: kind, bones per chain, chains, smooth, and each chain's root and
// tip in the viewer's space). At export Blender makes an armature "<mesh> Rig" with bones
// "<mesh> A1", "A2"... and weights every vertex along the chain (rig.py; the page works out the
// same weights for its preview), so the mesh comes into Studio skinned, its bones inside it.
// "Download rigged .blend" saves that same file for touching up the weights by hand; uploaded back
// ("edited"), it's used for the FBX instead, as long as the names and rig it was made from are
// still the page's (configHash).
//
// Double sided: any part, and any accessory as a whole, can be marked to show
// both faces in Studio (MeshPart.DoubleSided, which only Studio and plugins can
// set). The Studio job carries the FBX names of those meshes; the Mac sets it.
//
// "Send to Studio" keeps an FBX on the model and queues it for the Mac worker
// (~/RobloxPipeline/tools/studio_worker.py), which uploads it to Roblox and
// imports it into Studio. studioStatus: queued → uploading → importing → done,
// or failed at any step.
//
// "Get .rbxm" asks the same worker to save the unit, as it is in Studio now,
// as an .rbxm, which the bot then posts to its channel. rbxmStatus: queued →
// saving → done, or failed.

const { getPrisma, newId } = require('../assets/db');
const blender = require('./blender');

const PRIMARY = ['Head', 'Torso', 'Right Arm', 'Left Arm', 'Right Leg', 'Left Leg'];
const SECONDARY = PRIMARY.map(p => `${p} Accessory`);
const DROP = 'drop';
const CATEGORIES = [...PRIMARY, ...SECONDARY];
// The mesh name each body category gets in Studio (a finished unit's house style).
const MESH_NAME = { Head: 'Head', Torso: 'Torso', 'Right Arm': 'ArmRight', 'Left Arm': 'ArmLeft', 'Right Leg': 'LegRight', 'Left Leg': 'LegLeft' };
const FROM_MESH_NAME = Object.fromEntries(Object.entries(MESH_NAME).map(([k, v]) => [v.toLowerCase(), k]));
// Where an accessory can hang from, and the rig part its Handle is welded to.
const SPOTS = {
  'right-hand': 'Right Arm', 'left-hand': 'Left Arm', back: 'Torso', waist: 'Torso', head: 'Head', 'right-leg': 'Right Leg', 'left-leg': 'Left Leg',
};

class ModelError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ready = new WeakSet(); // per database client
async function ensureSchema(prisma = getPrisma()) {
  if (ready.has(prisma)) return;
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ModelFile" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "sourceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'converting',
    "error" TEXT,
    "blend" BYTEA NOT NULL,
    "glb" BYTEA,
    "parts" JSONB,
    "blender" TEXT,
    "assignments" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "exportedAt" TIMESTAMP,
    "exportedBy" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ModelAccessory" (
    "id" TEXT PRIMARY KEY,
    "unitId" TEXT NOT NULL,
    "accessoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spot" TEXT NOT NULL,
    "placement" JSONB,
    "doubleSided" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
  )`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "ModelAccessory" ADD COLUMN IF NOT EXISTS "doubleSided" BOOLEAN NOT NULL DEFAULT false`);
  for (const col of ['"rigs" JSONB NOT NULL DEFAULT \'{}\'::jsonb', '"editedBlend" BYTEA', '"editedGlb" BYTEA', '"editedInfo" JSONB',
    '"editedStatus" TEXT', '"editedError" TEXT', '"editedAt" TIMESTAMP', '"editedBy" TEXT',
    '"labels" JSONB NOT NULL DEFAULT \'{}\'::jsonb', '"doubleSided" JSONB NOT NULL DEFAULT \'[]\'::jsonb', '"kind" TEXT NOT NULL DEFAULT \'unit\'', '"format" TEXT NOT NULL DEFAULT \'blend\'',
    '"studioStatus" TEXT', '"studioFbx" BYTEA', '"studioFbxName" TEXT', '"studioOptions" JSONB', '"studioAssetId" TEXT',
    '"studioError" TEXT', '"studioResult" JSONB', '"studioBy" TEXT', '"studioQueuedAt" TIMESTAMP', '"studioAt" TIMESTAMP',
    '"rbxmStatus" TEXT', '"rbxm" BYTEA', '"rbxmUnit" TEXT', '"rbxmSize" INTEGER', '"rbxmError" TEXT', '"rbxmPost" JSONB', '"rbxmBy" TEXT',
    '"rbxmQueuedAt" TIMESTAMP', '"rbxmAt" TIMESTAMP']) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "ModelFile" ADD COLUMN IF NOT EXISTS ${col}`);
  }
  ready.add(prisma);
}

const json = v => (typeof v === 'string' ? JSON.parse(v) : v);

const STUDIO_ACTIVE = ['queued', 'uploading', 'importing'];
const STUDIO_REPORTS = ['uploading', 'importing', 'done', 'failed'];
const STUDIO_STALE_MIN = 15; // a job the Mac took and then went quiet on for this long has failed
const RBXM_ACTIVE = ['queued', 'saving'];
const SUMMARY_COLUMNS = `id, name, kind, format, labels, "doubleSided", "uploadedBy", "sourceUrl", status, error, blender, parts, assignments, "exportedAt", "exportedBy",
  "createdAt", "updatedAt", "studioStatus", "studioAssetId", "studioError", "studioResult", "studioOptions", "studioBy", "studioQueuedAt", "studioAt",
  "rbxmStatus", "rbxmUnit", "rbxmSize", "rbxmError", "rbxmPost", "rbxmBy", "rbxmAt",
  rigs, "editedInfo", "editedStatus", "editedError", "editedAt", "editedBy"`;
const RIG_KINDS = ['cape', 'hair', 'wing', 'custom'];
const CHAIN_LETTERS = 'ABC';

// The final name of every part, and the parts left out (see the top of this file).
// Accessories without a word are numbered per limb in part order: "Head Accessory 1", 2...
// Two that would end up with the same name get " 2", " 3" on the second and on.
function plan(parts, assignments, labels = {}) {
  const rename = {};
  const drop = [];
  const count = {};
  const used = new Set();
  const unique = name => {
    let out = name;
    for (let n = 2; used.has(out.toLowerCase()); n++) out = `${name} ${n}`;
    used.add(out.toLowerCase());
    return out;
  };
  for (const p of parts) {
    const cat = assignments[p.name];
    if (cat === DROP) { drop.push(p.name); continue; }
    if (PRIMARY.includes(cat)) rename[p.name] = unique(MESH_NAME[cat]);
  }
  for (const p of parts) {
    const cat = assignments[p.name];
    if (!SECONDARY.includes(cat)) continue;
    const limb = MESH_NAME[cat.replace(/ Accessory$/, '')];
    const word = cleanLabel(labels[p.name]);
    if (word) rename[p.name] = unique(`${limb} ${word}`);
    else { count[cat] = (count[cat] || 0) + 1; rename[p.name] = unique(`${limb} Accessory ${count[cat]}`); }
  }
  return { rename, drop };
}

const cleanLabel = v => String(v ?? '').replace(/[^\p{L}\p{N} _-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);

function checkLabels(parts, labels) {
  if (labels == null) return {};
  if (typeof labels !== 'object' || Array.isArray(labels)) throw new ModelError(400, 'labels must be an object');
  const names = new Set(parts.map(p => p.name));
  const clean = {};
  for (const [part, word] of Object.entries(labels)) {
    if (!names.has(part)) throw new ModelError(400, `No part called "${part}"`);
    const w = cleanLabel(word);
    if (w) clean[part] = w;
  }
  return clean;
}

function checkAssignments(parts, assignments) {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) throw new ModelError(400, 'assignments must be an object');
  const names = new Set(parts.map(p => p.name));
  const clean = {};
  const primaryOwner = {};
  for (const [part, cat] of Object.entries(assignments)) {
    if (!names.has(part)) throw new ModelError(400, `No part called "${part}"`);
    if (cat === null || cat === '') continue;
    if (cat !== DROP && !CATEGORIES.includes(cat)) throw new ModelError(400, `"${cat}" is not a category`);
    if (PRIMARY.includes(cat)) {
      if (primaryOwner[cat]) throw new ModelError(400, `${cat} is on both "${primaryOwner[cat]}" and "${part}"`);
      primaryOwner[cat] = part;
    }
    clean[part] = cat;
  }
  return clean;
}

const summary = r => {
  const parts = json(r.parts) || [];
  const assignments = json(r.assignments) || {};
  return {
    id: r.id, name: r.name, kind: r.kind || 'unit', format: r.format || 'blend', uploadedBy: r.uploadedBy, sourceUrl: r.sourceUrl, status: r.status, error: r.error,
    blender: r.blender, partCount: parts.length, assigned: parts.filter(p => assignments[p.name]).length,
    exportedAt: r.exportedAt, exportedBy: r.exportedBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
    studio: r.studioStatus ? {
      status: r.studioStatus, assetId: r.studioAssetId, error: r.studioError, result: json(r.studioResult), options: json(r.studioOptions),
      by: r.studioBy, queuedAt: r.studioQueuedAt, at: r.studioAt,
    } : null,
    rbxm: r.rbxmStatus ? {
      status: r.rbxmStatus, unit: r.rbxmUnit, size: r.rbxmSize, error: r.rbxmError, post: json(r.rbxmPost), by: r.rbxmBy, at: r.rbxmAt,
    } : null,
  };
};

async function expireStudio(prisma) {
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "studioStatus" = 'failed', "studioAt" = now(),
    "studioError" = 'The Mac worker stopped answering partway through. Send it again.'
    WHERE "studioStatus" IN ('uploading', 'importing') AND "studioAt" < now() - interval '${STUDIO_STALE_MIN} minutes'`);
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "rbxmStatus" = 'failed', "rbxmAt" = now(),
    "rbxmError" = 'The Mac worker stopped answering partway through. Try again.'
    WHERE "rbxmStatus" = 'saving' AND "rbxmAt" < now() - interval '${STUDIO_STALE_MIN} minutes'`);
}

// Turning a .blend into the viewer's GLB. Started on upload, and again when
// someone opens a model whose conversion a restart cut short.
const converting = new Set();
function startConvert(id, prisma = getPrisma(), inspect = blender.inspect) {
  if (converting.has(id)) return;
  converting.add(id);
  (async () => {
    try {
      const [row] = await prisma.$queryRawUnsafe(`SELECT "blend", format FROM "ModelFile" WHERE id = $1`, id);
      if (!row) return;
      const { glb, parts, blender: version } = await inspect(Buffer.from(row.blend), row.format || 'blend');
      const assignments = {};
      // Parts already named right: "Head", "Right Arm", or the house style "ArmRight".
      for (const p of parts) {
        const cat = PRIMARY.includes(p.name) ? p.name : FROM_MESH_NAME[p.name.toLowerCase()];
        if (cat && !Object.values(assignments).includes(cat)) assignments[p.name] = cat;
      }
      await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET status = 'ready', error = NULL, glb = $2, parts = $3::jsonb, blender = $4,
        assignments = $5::jsonb, "updatedAt" = now() WHERE id = $1`, id, glb, JSON.stringify(parts), version, JSON.stringify(assignments));
      console.log(`[Models] ${id}: ${parts.length} parts`);
    } catch (err) {
      console.error(`[Models] ${id} failed:`, err.message);
      await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET status = 'failed', error = $2, "updatedAt" = now() WHERE id = $1`, id, err.message.slice(0, 2000)).catch(() => {});
    } finally {
      converting.delete(id);
    }
  })();
}

// kind: 'unit' (from Discord) or 'accessory' (added on a unit's page). An accessory can also be an FBX.
async function create({ name, blend, uploadedBy, sourceUrl, kind = 'unit' }, prisma = getPrisma(), inspect) {
  await ensureSchema(prisma);
  if (!blend?.length) throw new ModelError(400, 'No file');
  // Plain, zstd-compressed (Blender 3+) or gzip-compressed (older) .blend; or a binary FBX.
  const head = blend.subarray(0, 4).toString('hex');
  const isBlend = blend.subarray(0, 7).toString('latin1') === 'BLENDER' || head === '28b52ffd' || head.startsWith('1f8b');
  const isFbx = blend.subarray(0, 18).toString('latin1') === 'Kaydara FBX Binary';
  if (!isBlend && !isFbx) throw new ModelError(400, 'That is not a .blend file or a binary .fbx');
  if (!['unit', 'accessory'].includes(kind)) throw new ModelError(400, 'kind must be unit or accessory');
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "ModelFile" (id, name, "uploadedBy", "sourceUrl", blend, kind, format) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    id, String(name || 'model.blend').slice(0, 200), uploadedBy || null, sourceUrl || null, blend, kind, isFbx ? 'fbx' : 'blend');
  startConvert(id, prisma, inspect);
  return { id };
}

async function list(prisma = getPrisma()) {
  await ensureSchema(prisma);
  await expireStudio(prisma);
  const rows = await prisma.$queryRawUnsafe(`SELECT ${SUMMARY_COLUMNS} FROM "ModelFile" ORDER BY "createdAt" DESC LIMIT 200`);
  return rows.map(summary);
}

async function get(id, prisma = getPrisma(), inspect) {
  await ensureSchema(prisma);
  await expireStudio(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT ${SUMMARY_COLUMNS} FROM "ModelFile" WHERE id = $1`, id);
  if (!row) throw new ModelError(404, 'No such model');
  if (row.status === 'converting') startConvert(id, prisma, inspect); // a restart may have cut it short
  if (row.editedStatus === 'converting') startEditedConvert(id, prisma, inspect);
  const model = {
    ...summary(row), parts: json(row.parts) || [], assignments: json(row.assignments) || {}, labels: json(row.labels) || {},
    doubleSided: json(row.doubleSided) || [], rigs: json(row.rigs) || {},
    categories: { primary: PRIMARY, secondary: SECONDARY, meshNames: MESH_NAME, spots: SPOTS },
    accessories: await accessoriesOf(id, prisma), attachedTo: await attachedTo(id, prisma),
  };
  model.configHash = configHash(model, model.accessories);
  const info = json(row.editedInfo);
  model.edited = row.editedStatus ? {
    status: row.editedStatus, error: row.editedError, at: row.editedAt, by: row.editedBy, info,
    matches: row.editedStatus === 'ready' && info?.config === model.configHash,
  } : null;
  return model;
}

async function file(id, column, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT name, "${column}" AS data FROM "ModelFile" WHERE id = $1`, id);
  if (!row) throw new ModelError(404, 'No such model');
  if (!row.data) throw new ModelError(409, 'Not ready yet');
  return { name: row.name, data: Buffer.from(row.data) };
}

async function setAssignments(id, assignments, prisma = getPrisma(), labels, doubleSided, rigs) {
  const model = await get(id, prisma);
  if (model.status !== 'ready') throw new ModelError(409, 'The model is not ready yet');
  const clean = checkAssignments(model.parts, assignments);
  const words = labels === undefined ? model.labels : checkLabels(model.parts, labels);
  let both = model.doubleSided;
  if (doubleSided !== undefined) {
    if (!Array.isArray(doubleSided)) throw new ModelError(400, 'doubleSided must be a list of part names');
    const names = new Set(model.parts.map(p => p.name));
    const bad = doubleSided.find(n => !names.has(n));
    if (bad !== undefined) throw new ModelError(400, `No part called "${bad}"`);
    both = [...new Set(doubleSided)];
  }
  const bones = rigs === undefined ? model.rigs : checkRigs(model.parts, rigs);
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET assignments = $2::jsonb, labels = $3::jsonb, "doubleSided" = $4::jsonb, rigs = $5::jsonb,
    "updatedAt" = now() WHERE id = $1`, id, JSON.stringify(clean), JSON.stringify(words), JSON.stringify(both), JSON.stringify(bones));
  return clean;
}

// ── bending parts ──

const finite3 = v => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x));

function checkRigs(parts, rigs) {
  if (rigs == null) return {};
  if (typeof rigs !== 'object' || Array.isArray(rigs)) throw new ModelError(400, 'rigs must be an object');
  const names = new Set(parts.map(p => p.name));
  const clean = {};
  for (const [part, r] of Object.entries(rigs)) {
    if (!r) continue;
    if (!names.has(part)) throw new ModelError(400, `No part called "${part}"`);
    if (!RIG_KINDS.includes(r.kind)) throw new ModelError(400, `${part}: kind must be one of ${RIG_KINDS.join(', ')}`);
    const bones = Number(r.bones);
    if (!Number.isInteger(bones) || bones < 1 || bones > 8) throw new ModelError(400, `${part}: 1 to 8 bones per chain`);
    const smooth = Number(r.smooth ?? 0.6);
    if (!(smooth >= 0.05 && smooth <= 1)) throw new ModelError(400, `${part}: smooth must be between 0.05 and 1`);
    if (!Array.isArray(r.chains) || r.chains.length < 1 || r.chains.length > CHAIN_LETTERS.length) throw new ModelError(400, `${part}: 1 to 3 chains`);
    const chains = r.chains.map(c => {
      if (!c || !finite3(c.root) || !finite3(c.tip)) throw new ModelError(400, `${part}: each chain needs a root and a tip`);
      if (Math.hypot(c.tip[0] - c.root[0], c.tip[1] - c.root[1], c.tip[2] - c.root[2]) < 1e-6) throw new ModelError(400, `${part}: a chain's root and tip are the same point`);
      return { root: c.root, tip: c.tip };
    });
    clean[part] = { kind: r.kind, bones, smooth, chains };
  }
  return clean;
}

// The bone names of a part's rig: "<mesh> A1".."A<n>", then "B1".. for a second chain.
const boneNames = (mesh, rig) => rig.chains.flatMap((c, ci) => Array.from({ length: rig.bones }, (_, k) => `${mesh} ${CHAIN_LETTERS[ci]}${k + 1}`));

// The rigs that will be made: only on accessory parts that are in the FBX, by their final name.
function rigPlan(model, steps) {
  const dropped = new Set(steps.drop);
  return model.parts.filter(p => model.rigs[p.name] && SECONDARY.includes(model.assignments[p.name]) && !dropped.has(p.name) && steps.rename[p.name])
    .map(p => {
      const r = model.rigs[p.name];
      const mesh = steps.rename[p.name];
      return { part: p.name, mesh, kind: r.kind, bones: r.bones, smooth: r.smooth, chains: r.chains, names: boneNames(mesh, r) };
    });
}

// What a rigged .blend was made from: the names, the rigs and the accessories. An edited .blend is only
// used while this is still the same, so a file made before a change can't quietly undo it.
function configHash(model, accs) {
  const steps = plan(model.parts, model.assignments, model.labels);
  const cfg = { rename: steps.rename, drop: steps.drop, rigs: rigPlan(model, steps), acc: (accs || []).map(a => [a.accessoryId, a.name, a.spot, a.placement]) };
  return require('crypto').createHash('sha1').update(JSON.stringify(cfg)).digest('hex').slice(0, 12);
}

// ── weapons and other accessories ──

async function accessoriesOf(unitId, prisma) {
  const rows = await prisma.$queryRawUnsafe(`SELECT a.id, a."accessoryId", a.name, a.spot, a.placement, a."doubleSided", m.name AS "fileName", m.status,
      m.error, m.parts, m.assignments FROM "ModelAccessory" a LEFT JOIN "ModelFile" m ON m.id = a."accessoryId"
    WHERE a."unitId" = $1 ORDER BY a."createdAt"`, unitId);
  return rows.map(r => ({
    id: r.id, accessoryId: r.accessoryId, name: r.name, spot: r.spot, limb: SPOTS[r.spot], placement: json(r.placement), doubleSided: !!r.doubleSided,
    file: r.fileName ? { name: r.fileName, status: r.status, error: r.error, parts: (json(r.parts) || []).length } : null,
  }));
}

async function attachedTo(accessoryId, prisma) {
  return prisma.$queryRawUnsafe(`SELECT a.id, a."unitId", m.name FROM "ModelAccessory" a JOIN "ModelFile" m ON m.id = a."unitId"
    WHERE a."accessoryId" = $1 ORDER BY a."createdAt"`, accessoryId);
}

const accessoryName = v => String(v ?? '').replace(/\.(blend\d*|fbx)$/i, '').replace(/[_]+/g, ' ').replace(/[^\p{L}\p{N} '()-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);

function checkPlacement(p) {
  if (p == null) return null;
  const nums = (v, n) => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x));
  if (!p || typeof p !== 'object' || !nums(p.matrix, 16) || !nums(p.handle, 3)) {
    throw new ModelError(400, 'placement must be { matrix: 16 numbers, handle: 3 numbers }');
  }
  return { matrix: p.matrix, handle: p.handle };
}

async function addAccessory(unitId, { accessoryId, name, spot = 'right-hand' } = {}, prisma = getPrisma()) {
  await ensureSchema(prisma);
  if (accessoryId === unitId) throw new ModelError(400, 'A model can\'t be its own accessory');
  const [unit] = await prisma.$queryRawUnsafe(`SELECT id FROM "ModelFile" WHERE id = $1`, unitId);
  const [acc] = await prisma.$queryRawUnsafe(`SELECT id, name FROM "ModelFile" WHERE id = $1`, accessoryId);
  if (!unit || !acc) throw new ModelError(404, 'No such model');
  if (!SPOTS[spot]) throw new ModelError(400, `spot must be one of ${Object.keys(SPOTS).join(', ')}`);
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "ModelAccessory" (id, "unitId", "accessoryId", name, spot) VALUES ($1, $2, $3, $4, $5)`,
    id, unitId, accessoryId, accessoryName(name) || accessoryName(acc.name) || 'Accessory', spot);
  return (await accessoriesOf(unitId, prisma)).find(a => a.id === id);
}

async function updateAccessory(unitId, id, body = {}, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT id FROM "ModelAccessory" WHERE id = $1 AND "unitId" = $2`, id, unitId);
  if (!row) throw new ModelError(404, 'No such accessory on that model');
  if ('name' in body) {
    const name = accessoryName(body.name);
    if (!name) throw new ModelError(400, 'A name is required');
    await prisma.$executeRawUnsafe(`UPDATE "ModelAccessory" SET name = $2, "updatedAt" = now() WHERE id = $1`, id, name);
  }
  if ('spot' in body) {
    if (!SPOTS[body.spot]) throw new ModelError(400, `spot must be one of ${Object.keys(SPOTS).join(', ')}`);
    await prisma.$executeRawUnsafe(`UPDATE "ModelAccessory" SET spot = $2, "updatedAt" = now() WHERE id = $1`, id, body.spot);
  }
  if ('doubleSided' in body) {
    await prisma.$executeRawUnsafe(`UPDATE "ModelAccessory" SET "doubleSided" = $2, "updatedAt" = now() WHERE id = $1`, id, body.doubleSided === true);
  }
  if ('placement' in body) {
    await prisma.$executeRawUnsafe(`UPDATE "ModelAccessory" SET placement = $2::jsonb, "updatedAt" = now() WHERE id = $1`,
      id, JSON.stringify(checkPlacement(body.placement)));
  }
  return (await accessoriesOf(unitId, prisma)).find(a => a.id === id);
}

async function removeAccessory(unitId, id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM "ModelAccessory" WHERE id = $1 AND "unitId" = $2`, id, unitId);
}

// What Blender needs to add a unit's accessories to its FBX, and what the Mac needs to build them.
async function accessoryExport(unitId, prisma) {
  const accs = await accessoriesOf(unitId, prisma);
  const forBlender = [];
  const forStudio = [];
  for (const [i, a] of accs.entries()) {
    if (a.file?.status !== 'ready') throw new ModelError(409, `The accessory ${a.name} is not ready yet`);
    if (!a.placement) throw new ModelError(409, `Position ${a.name} on the unit first (Position on the page)`);
    const [m] = await prisma.$queryRawUnsafe(`SELECT blend, format, parts, assignments FROM "ModelFile" WHERE id = $1`, a.accessoryId);
    const left = json(m.assignments) || {};
    const meshes = (json(m.parts) || []).filter(p => left[p.name] !== DROP && p.verts > 0).map(p => p.name);
    if (!meshes.length) throw new ModelError(409, `The accessory ${a.name} has no meshes to add`);
    const prefix = `A${i + 1}`;
    forBlender.push({ prefix, data: Buffer.from(m.blend), format: m.format || 'blend', meshes, matrix: a.placement.matrix, handle: a.placement.handle });
    forStudio.push({ name: a.name, spot: a.spot, limb: a.limb, handle: `${prefix} Handle`, meshes: Object.fromEntries(meshes.map(n => [`${prefix} ${n}`, n])), doubleSided: a.doubleSided });
  }
  return { forBlender, forStudio };
}

// options: embedTextures (Path Mode Copy + Embed Textures) and smallScale (Scale 0.01), both yes unless told no.
// Everything an export needs: the file, the plan for Blender and what the Mac gets with it. With an edited
// .blend that still matches, the file is that one and Blender has nothing left to add.
async function buildExport(id, prisma, options = {}) {
  const model = await get(id, prisma);
  if (model.status !== 'ready') throw new ModelError(409, 'The model is not ready yet');
  if (model.format === 'fbx') throw new ModelError(400, 'This one is already an FBX. Attach it to a unit as an accessory instead.');
  const steps = plan(model.parts, model.assignments, model.labels);
  const { forBlender, forStudio } = await accessoryExport(id, prisma);
  const rigs = rigPlan(model, steps);
  const settings = { embed: options.embedTextures !== false, scale: options.smallScale === false ? 1 : 0.01, fixFaces: options.invertFaces === true };
  let data, blenderPlan, rigged;
  if (model.edited?.status === 'ready' && !options.ignoreEdited) {
    if (!model.edited.matches) {
      throw new ModelError(409, 'Names, bending parts or accessories changed since the rigged .blend was downloaded. Download it again and redo the edits, or remove the edited .blend to use the automatic rig.');
    }
    data = (await file(id, 'editedBlend', prisma)).data;
    blenderPlan = { rename: {}, drop: [], ...settings, accessories: [], rigs: [] };
    rigged = (model.edited.info?.skinned || []).map(mesh => ({ mesh }));
  } else {
    data = (await file(id, 'blend', prisma)).data;
    blenderPlan = { ...steps, ...settings, accessories: forBlender, rigs };
    rigged = rigs.map(r => ({ mesh: r.mesh, bones: r.names }));
  }
  return { model, steps, data, blenderPlan, forStudio, rigged };
}

// "Download rigged .blend": the unit as it goes to Studio (names, accessories, bones and weights) as a .blend.
async function rigBlend(id, prisma = getPrisma(), saveBlend = blender.saveBlend) {
  const { model, data, blenderPlan } = await buildExport(id, prisma, { ignoreEdited: true, embedTextures: true, smallScale: false });
  const out = await saveBlend(data, { ...blenderPlan, scale: 1, configHash: model.configHash });
  return { name: model.name.replace(/\.blend\d*$/i, '') + '_rigged.blend', data: out };
}

async function exportModel(id, by, prisma = getPrisma(), exportFbx = blender.exportFbx, options = {}) {
  const { model, steps, data, blenderPlan, forStudio, rigged } = await buildExport(id, prisma, options);
  const fbx = await exportFbx(data, blenderPlan);
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "exportedAt" = now(), "exportedBy" = $2 WHERE id = $1`, id, by || null);
  // The meshes to show both faces of, by the name they have in the FBX.
  const dropped = new Set(steps.drop);
  const doubleSided = [
    ...model.doubleSided.filter(n => !dropped.has(n)).map(n => steps.rename[n] || n),
    ...forStudio.filter(a => a.doubleSided).flatMap(a => Object.keys(a.meshes)),
  ];
  return { name: model.name.replace(/\.blend\d*$/i, '') + '.fbx', data: fbx, plan: steps, accessories: forStudio, doubleSided, rigged };
}

// ── an edited rigged .blend, uploaded back ──

const convertingEdited = new Set();
function startEditedConvert(id, prisma = getPrisma(), inspect = blender.inspect) {
  if (convertingEdited.has(id)) return;
  convertingEdited.add(id);
  (async () => {
    try {
      const [row] = await prisma.$queryRawUnsafe(`SELECT "editedBlend" FROM "ModelFile" WHERE id = $1`, id);
      if (!row?.editedBlend) return;
      const got = await inspect(Buffer.from(row.editedBlend), 'blend');
      const info = { config: got.config || null, skinned: got.skinned || [], armatures: got.armatures || 0, bones: got.bones || 0, parts: (got.parts || []).length };
      await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "editedStatus" = 'ready', "editedError" = NULL, "editedGlb" = $2, "editedInfo" = $3::jsonb WHERE id = $1`,
        id, got.glb, JSON.stringify(info));
    } catch (err) {
      console.error(`[Models] edited .blend for ${id} failed:`, err.message);
      await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "editedStatus" = 'failed', "editedError" = $2 WHERE id = $1`, id, err.message.slice(0, 2000)).catch(() => {});
    } finally {
      convertingEdited.delete(id);
    }
  })();
}

async function uploadEdited(id, data, by, prisma = getPrisma(), inspect) {
  const model = await get(id, prisma);
  if (model.status !== 'ready' || model.format !== 'blend') throw new ModelError(409, 'Only a unit opened from a .blend can take an edited .blend');
  const head = data?.subarray(0, 4).toString('hex');
  if (!data?.length || !(data.subarray(0, 7).toString('latin1') === 'BLENDER' || head === '28b52ffd' || head?.startsWith('1f8b'))) {
    throw new ModelError(400, 'That is not a .blend file');
  }
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "editedBlend" = $2, "editedGlb" = NULL, "editedInfo" = NULL, "editedStatus" = 'converting',
    "editedError" = NULL, "editedAt" = now(), "editedBy" = $3 WHERE id = $1`, id, data, by || null);
  startEditedConvert(id, prisma, inspect);
  return (await get(id, prisma, inspect)).edited;
}

async function removeEdited(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "editedBlend" = NULL, "editedGlb" = NULL, "editedInfo" = NULL, "editedStatus" = NULL,
    "editedError" = NULL, "editedAt" = NULL, "editedBy" = NULL WHERE id = $1`, id);
}

// ── Send to Studio ──

// Degrees the unit is turned (about the vertical, + is to its left) before it's rigged, for blend files that face the wrong way.
const STUDIO_TURNS = [0, 180, 90, -90];

// Export the FBX with the page's options, keep it, and queue it for the Mac.
async function sendToStudio(id, by, prisma = getPrisma(), exportFbx = blender.exportFbx, options = {}) {
  const turn = Number(options.turn ?? 0);
  if (!STUDIO_TURNS.includes(turn)) throw new ModelError(400, `turn must be one of ${STUDIO_TURNS.join(', ')}`);
  const model = await get(id, prisma);
  if (STUDIO_ACTIVE.includes(model.studio?.status)) throw new ModelError(409, 'It is already on its way to Studio');
  const { name, data, accessories, doubleSided, rigged } = await exportModel(id, by, prisma, exportFbx, options);
  const opts = { embedTextures: options.embedTextures !== false, smallScale: options.smallScale !== false, invertFaces: options.invertFaces === true, turn, accessories, doubleSided, rigged };
  const queued = await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "studioStatus" = 'queued', "studioFbx" = $2, "studioFbxName" = $3,
    "studioOptions" = $4::jsonb, "studioAssetId" = NULL, "studioError" = NULL, "studioResult" = NULL, "studioBy" = $5,
    "studioQueuedAt" = now(), "studioAt" = now()
    WHERE id = $1 AND ("studioStatus" IS NULL OR "studioStatus" NOT IN ('queued', 'uploading', 'importing'))`,
  id, data, name, JSON.stringify(opts), by || null);
  if (!queued) throw new ModelError(409, 'It is already on its way to Studio');
  return (await get(id, prisma)).studio;
}

// Ask the Mac to save the unit, as it is in Studio now, as an .rbxm. Only once it's in Studio.
async function requestRbxm(id, by, prisma = getPrisma()) {
  const model = await get(id, prisma);
  const unit = model.studio?.status === 'done' && model.studio.result?.name;
  if (!unit) throw new ModelError(409, 'It is not in Studio yet. Send it to Studio first.');
  const queued = await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "rbxmStatus" = 'queued', "rbxmUnit" = $2, "rbxmError" = NULL,
    "rbxmPost" = NULL, "rbxmBy" = $3, "rbxmQueuedAt" = now(), "rbxmAt" = now()
    WHERE id = $1 AND ("rbxmStatus" IS NULL OR "rbxmStatus" NOT IN ('queued', 'saving'))`, id, unit, by || null);
  if (!queued) throw new ModelError(409, 'The .rbxm is already being saved');
  return (await get(id, prisma)).rbxm;
}

// The Mac worker: how many jobs are waiting, take the oldest, fetch its FBX, say how it went.
async function studioQueued(prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ModelFile" WHERE "studioStatus" = 'queued' OR "rbxmStatus" = 'queued'`);
  return row.n;
}

async function claimStudio(prisma = getPrisma()) {
  await ensureSchema(prisma);
  await expireStudio(prisma);
  const [row] = await prisma.$queryRawUnsafe(`UPDATE "ModelFile" SET "studioStatus" = 'uploading', "studioAt" = now()
    WHERE id = (SELECT id FROM "ModelFile" WHERE "studioStatus" = 'queued' ORDER BY "studioQueuedAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, name, "studioFbxName", "studioOptions"`);
  if (row) return { kind: 'import', id: row.id, name: row.name.replace(/\.blend\d*$/i, ''), fbxName: row.studioFbxName, options: json(row.studioOptions) };
  const [save] = await prisma.$queryRawUnsafe(`UPDATE "ModelFile" SET "rbxmStatus" = 'saving', "rbxmAt" = now()
    WHERE id = (SELECT id FROM "ModelFile" WHERE "rbxmStatus" = 'queued' ORDER BY "rbxmQueuedAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, "rbxmUnit"`);
  return save ? { kind: 'rbxm', id: save.id, unit: save.rbxmUnit } : null;
}

async function studioFbx(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT "studioFbxName" AS name, "studioFbx" AS data FROM "ModelFile" WHERE id = $1`, id);
  if (!row?.data) throw new ModelError(404, 'No FBX for Studio on that model');
  return { name: row.name, data: Buffer.from(row.data) };
}

async function reportStudio(id, { status, assetId, error, result } = {}, prisma = getPrisma()) {
  await ensureSchema(prisma);
  if (!STUDIO_REPORTS.includes(status)) throw new ModelError(400, `status must be one of ${STUDIO_REPORTS.join(', ')}`);
  if (assetId != null && !/^\d{1,20}$/.test(String(assetId))) throw new ModelError(400, 'assetId must be a number');
  if (result != null && (typeof result !== 'object' || JSON.stringify(result).length > 20000)) throw new ModelError(400, 'result must be a small object');
  const done = await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "studioStatus" = $2, "studioAssetId" = COALESCE($3, "studioAssetId"),
    "studioError" = $4, "studioResult" = COALESCE($5::jsonb, "studioResult"), "studioAt" = now()
    WHERE id = $1 AND "studioStatus" IN ('uploading', 'importing')`,
  id, status, assetId == null ? null : String(assetId), status === 'failed' ? String(error || 'Failed').slice(0, 2000) : null,
  result == null ? null : JSON.stringify(result));
  if (!done) throw new ModelError(409, 'That model is not being sent to Studio');
}

// The worker hands over the .rbxm (or why it couldn't); it's then waiting to be posted to Discord.
async function saveRbxm(id, data, prisma = getPrisma()) {
  await ensureSchema(prisma);
  if (!Buffer.isBuffer(data) || data.subarray(0, 8).toString('latin1') !== '<roblox!') throw new ModelError(400, 'That is not an .rbxm file');
  const done = await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "rbxmStatus" = 'done', rbxm = $2, "rbxmSize" = $3, "rbxmError" = NULL,
    "rbxmPost" = '{"state":"posting"}'::jsonb, "rbxmAt" = now() WHERE id = $1 AND "rbxmStatus" = 'saving'`, id, data, data.length);
  if (!done) throw new ModelError(409, 'That model is not being saved as an .rbxm');
  return (await get(id, prisma)).rbxm;
}

async function failRbxm(id, error, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const done = await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "rbxmStatus" = 'failed', "rbxmError" = $2, "rbxmAt" = now()
    WHERE id = $1 AND "rbxmStatus" = 'saving'`, id, String(error || 'Failed').slice(0, 2000));
  if (!done) throw new ModelError(409, 'That model is not being saved as an .rbxm');
}

// post: { state: 'posted' | 'waiting' (the bot is away; it's in the outbox) | 'failed', error }
async function setRbxmPost(id, post, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "rbxmPost" = $2::jsonb WHERE id = $1`, id, JSON.stringify(post));
}

async function rbxmFile(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT "rbxmUnit" AS unit, rbxm FROM "ModelFile" WHERE id = $1 AND rbxm IS NOT NULL`, id);
  if (!row) throw new ModelError(404, 'No .rbxm saved for that model yet');
  return { name: `${row.unit}.rbxm`, data: Buffer.from(row.rbxm) };
}

async function remove(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM "ModelAccessory" WHERE "unitId" = $1 OR "accessoryId" = $1`, id);
  await prisma.$executeRawUnsafe(`DELETE FROM "ModelFile" WHERE id = $1`, id);
}

module.exports = { ensureSchema, create, list, get, file, setAssignments, exportModel, remove,
  sendToStudio, studioQueued, claimStudio, studioFbx, reportStudio, STUDIO_STALE_MIN, STUDIO_TURNS,
  requestRbxm, saveRbxm, failRbxm, setRbxmPost, rbxmFile,
  addAccessory, updateAccessory, removeAccessory, rigBlend, uploadEdited, removeEdited, checkRigs, configHash,
  plan, checkAssignments, ModelError, PRIMARY, SECONDARY, DROP, MESH_NAME, SPOTS };
