// store.js
// The model viewer's files: a .blend the bot was handed in Discord, the GLB
// Blender made from it for the browser, the list of parts, and what each part
// was named on the viewer. Table "ModelFile", made on first use.
//
// What a part is called is stored as its category ("Head", "Head Accessory",
// or "drop" to leave it out); the final names, with accessory numbers, are
// worked out from that at export (plan()), so numbering never goes stale.

const { getPrisma, newId } = require('../assets/db');
const blender = require('./blender');

const PRIMARY = ['Head', 'Torso', 'Right Arm', 'Left Arm', 'Right Leg', 'Left Leg'];
const SECONDARY = PRIMARY.map(p => `${p} Accessory`);
const DROP = 'drop';
const CATEGORIES = [...PRIMARY, ...SECONDARY];

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
  ready.add(prisma);
}

const json = v => (typeof v === 'string' ? JSON.parse(v) : v);

// The final name of every part, and the parts left out.
// Accessories are numbered per group in part order: Head Accessory 1, 2, ...
function plan(parts, assignments) {
  const rename = {};
  const drop = [];
  const count = {};
  for (const p of parts) {
    const cat = assignments[p.name];
    if (cat === DROP) { drop.push(p.name); continue; }
    if (PRIMARY.includes(cat)) rename[p.name] = cat;
    else if (SECONDARY.includes(cat)) { count[cat] = (count[cat] || 0) + 1; rename[p.name] = `${cat} ${count[cat]}`; }
  }
  return { rename, drop };
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
    id: r.id, name: r.name, uploadedBy: r.uploadedBy, sourceUrl: r.sourceUrl, status: r.status, error: r.error,
    blender: r.blender, partCount: parts.length, assigned: parts.filter(p => assignments[p.name]).length,
    exportedAt: r.exportedAt, exportedBy: r.exportedBy, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
};

// Turning a .blend into the viewer's GLB. Started on upload, and again when
// someone opens a model whose conversion a restart cut short.
const converting = new Set();
function startConvert(id, prisma = getPrisma(), inspect = blender.inspect) {
  if (converting.has(id)) return;
  converting.add(id);
  (async () => {
    try {
      const [row] = await prisma.$queryRawUnsafe(`SELECT "blend" FROM "ModelFile" WHERE id = $1`, id);
      if (!row) return;
      const { glb, parts, blender: version } = await inspect(Buffer.from(row.blend));
      const assignments = {};
      for (const p of parts) if (PRIMARY.includes(p.name)) assignments[p.name] = p.name; // already named right
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

async function create({ name, blend, uploadedBy, sourceUrl }, prisma = getPrisma(), inspect) {
  await ensureSchema(prisma);
  if (!blend?.length) throw new ModelError(400, 'No file');
  // Plain, zstd-compressed (Blender 3+) or gzip-compressed (older) .blend.
  const head = blend.subarray(0, 4).toString('hex');
  if (blend.subarray(0, 7).toString('latin1') !== 'BLENDER' && head !== '28b52ffd' && !head.startsWith('1f8b')) {
    throw new ModelError(400, 'That is not a .blend file');
  }
  const id = newId();
  await prisma.$executeRawUnsafe(`INSERT INTO "ModelFile" (id, name, "uploadedBy", "sourceUrl", blend) VALUES ($1, $2, $3, $4, $5)`,
    id, String(name || 'model.blend').slice(0, 200), uploadedBy || null, sourceUrl || null, blend);
  startConvert(id, prisma, inspect);
  return { id };
}

async function list(prisma = getPrisma()) {
  await ensureSchema(prisma);
  const rows = await prisma.$queryRawUnsafe(`SELECT id, name, "uploadedBy", "sourceUrl", status, error, blender, parts, assignments,
    "exportedAt", "exportedBy", "createdAt", "updatedAt" FROM "ModelFile" ORDER BY "createdAt" DESC LIMIT 200`);
  return rows.map(summary);
}

async function get(id, prisma = getPrisma(), inspect) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT id, name, "uploadedBy", "sourceUrl", status, error, blender, parts, assignments,
    "exportedAt", "exportedBy", "createdAt", "updatedAt" FROM "ModelFile" WHERE id = $1`, id);
  if (!row) throw new ModelError(404, 'No such model');
  if (row.status === 'converting') startConvert(id, prisma, inspect); // a restart may have cut it short
  return { ...summary(row), parts: json(row.parts) || [], assignments: json(row.assignments) || {}, categories: { primary: PRIMARY, secondary: SECONDARY } };
}

async function file(id, column, prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT name, "${column}" AS data FROM "ModelFile" WHERE id = $1`, id);
  if (!row) throw new ModelError(404, 'No such model');
  if (!row.data) throw new ModelError(409, 'Not ready yet');
  return { name: row.name, data: Buffer.from(row.data) };
}

async function setAssignments(id, assignments, prisma = getPrisma()) {
  const model = await get(id, prisma);
  if (model.status !== 'ready') throw new ModelError(409, 'The model is not ready yet');
  const clean = checkAssignments(model.parts, assignments);
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET assignments = $2::jsonb, "updatedAt" = now() WHERE id = $1`, id, JSON.stringify(clean));
  return clean;
}

// options: embedTextures (Path Mode Copy + Embed Textures) and smallScale (Scale 0.01), both yes unless told no.
async function exportModel(id, by, prisma = getPrisma(), exportFbx = blender.exportFbx, options = {}) {
  const model = await get(id, prisma);
  if (model.status !== 'ready') throw new ModelError(409, 'The model is not ready yet');
  const { data } = await file(id, 'blend', prisma);
  const steps = plan(model.parts, model.assignments);
  const fbx = await exportFbx(data, { ...steps, embed: options.embedTextures !== false, scale: options.smallScale === false ? 1 : 0.01 });
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "exportedAt" = now(), "exportedBy" = $2 WHERE id = $1`, id, by || null);
  return { name: model.name.replace(/\.blend\d*$/i, '') + '.fbx', data: fbx, plan: steps };
}

async function remove(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM "ModelFile" WHERE id = $1`, id);
}

module.exports = { ensureSchema, create, list, get, file, setAssignments, exportModel, remove, plan, checkAssignments, ModelError, PRIMARY, SECONDARY, DROP };
