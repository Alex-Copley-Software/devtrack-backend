// store.js
// The model viewer's files: a .blend the bot was handed in Discord, the GLB
// Blender made from it for the browser, the list of parts, and what each part
// was named on the viewer. Table "ModelFile", made on first use.
//
// What a part is called is stored as its category ("Head", "Head Accessory",
// or "drop" to leave it out); the final names, with accessory numbers, are
// worked out from that at export (plan()), so numbering never goes stale.
//
// "Send to Studio" keeps an FBX on the model and queues it for the Mac worker
// (~/RobloxPipeline/tools/studio_worker.py), which uploads it to Roblox and
// imports it into Studio. studioStatus: queued → uploading → importing → done,
// or failed at any step.

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
  for (const col of ['"studioStatus" TEXT', '"studioFbx" BYTEA', '"studioFbxName" TEXT', '"studioOptions" JSONB', '"studioAssetId" TEXT',
    '"studioError" TEXT', '"studioResult" JSONB', '"studioBy" TEXT', '"studioQueuedAt" TIMESTAMP', '"studioAt" TIMESTAMP']) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "ModelFile" ADD COLUMN IF NOT EXISTS ${col}`);
  }
  ready.add(prisma);
}

const json = v => (typeof v === 'string' ? JSON.parse(v) : v);

const STUDIO_ACTIVE = ['queued', 'uploading', 'importing'];
const STUDIO_REPORTS = ['uploading', 'importing', 'done', 'failed'];
const STUDIO_STALE_MIN = 15; // a job the Mac took and then went quiet on for this long has failed
const SUMMARY_COLUMNS = `id, name, "uploadedBy", "sourceUrl", status, error, blender, parts, assignments, "exportedAt", "exportedBy",
  "createdAt", "updatedAt", "studioStatus", "studioAssetId", "studioError", "studioResult", "studioOptions", "studioBy", "studioQueuedAt", "studioAt"`;

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
    studio: r.studioStatus ? {
      status: r.studioStatus, assetId: r.studioAssetId, error: r.studioError, result: json(r.studioResult), options: json(r.studioOptions),
      by: r.studioBy, queuedAt: r.studioQueuedAt, at: r.studioAt,
    } : null,
  };
};

async function expireStudio(prisma) {
  await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "studioStatus" = 'failed', "studioAt" = now(),
    "studioError" = 'The Mac worker stopped answering partway through. Send it again.'
    WHERE "studioStatus" IN ('uploading', 'importing') AND "studioAt" < now() - interval '${STUDIO_STALE_MIN} minutes'`);
}

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

// ── Send to Studio ──

// Degrees the unit is turned (about the vertical, + is to its left) before it's rigged, for blend files that face the wrong way.
const STUDIO_TURNS = [0, 180, 90, -90];

// Export the FBX with the page's options, keep it, and queue it for the Mac.
async function sendToStudio(id, by, prisma = getPrisma(), exportFbx = blender.exportFbx, options = {}) {
  const turn = Number(options.turn ?? 0);
  if (!STUDIO_TURNS.includes(turn)) throw new ModelError(400, `turn must be one of ${STUDIO_TURNS.join(', ')}`);
  const model = await get(id, prisma);
  if (STUDIO_ACTIVE.includes(model.studio?.status)) throw new ModelError(409, 'It is already on its way to Studio');
  const { name, data } = await exportModel(id, by, prisma, exportFbx, options);
  const opts = { embedTextures: options.embedTextures !== false, smallScale: options.smallScale !== false, turn };
  const queued = await prisma.$executeRawUnsafe(`UPDATE "ModelFile" SET "studioStatus" = 'queued', "studioFbx" = $2, "studioFbxName" = $3,
    "studioOptions" = $4::jsonb, "studioAssetId" = NULL, "studioError" = NULL, "studioResult" = NULL, "studioBy" = $5,
    "studioQueuedAt" = now(), "studioAt" = now()
    WHERE id = $1 AND ("studioStatus" IS NULL OR "studioStatus" NOT IN ('queued', 'uploading', 'importing'))`,
  id, data, name, JSON.stringify(opts), by || null);
  if (!queued) throw new ModelError(409, 'It is already on its way to Studio');
  return (await get(id, prisma)).studio;
}

// The Mac worker: how many jobs are waiting, take the oldest, fetch its FBX, say how it went.
async function studioQueued(prisma = getPrisma()) {
  await ensureSchema(prisma);
  const [row] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ModelFile" WHERE "studioStatus" = 'queued'`);
  return row.n;
}

async function claimStudio(prisma = getPrisma()) {
  await ensureSchema(prisma);
  await expireStudio(prisma);
  const [row] = await prisma.$queryRawUnsafe(`UPDATE "ModelFile" SET "studioStatus" = 'uploading', "studioAt" = now()
    WHERE id = (SELECT id FROM "ModelFile" WHERE "studioStatus" = 'queued' ORDER BY "studioQueuedAt" LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, name, "studioFbxName", "studioOptions"`);
  if (!row) return null;
  return { id: row.id, name: row.name.replace(/\.blend\d*$/i, ''), fbxName: row.studioFbxName, options: json(row.studioOptions) };
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

async function remove(id, prisma = getPrisma()) {
  await ensureSchema(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM "ModelFile" WHERE id = $1`, id);
}

module.exports = { ensureSchema, create, list, get, file, setAssignments, exportModel, remove,
  sendToStudio, studioQueued, claimStudio, studioFbx, reportStudio, STUDIO_STALE_MIN, STUDIO_TURNS,
  plan, checkAssignments, ModelError, PRIMARY, SECONDARY, DROP };
