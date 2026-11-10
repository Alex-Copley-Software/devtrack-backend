// blender.js
// Runs Blender with no window, one job at a time, for the model viewer.
//
// BLENDER_PATH points at a Blender that is already installed. Without it, on
// Linux (Railway), the official build is downloaded on first use (and shortly
// after start-up) into BLENDER_DIR, by default the temp folder. That is about
// 385 MB, once per deploy. railpack.json installs the system libraries it needs.
//
// .blend files can carry Python scripts; every run passes -Y so they never run.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const VERSION = process.env.BLENDER_VERSION || '5.2.3';
const SERIES = VERSION.split('.').slice(0, 2).join('.');
const URL = `https://download.blender.org/release/Blender${SERIES}/blender-${VERSION}-linux-x64.tar.xz`;
const DIR = process.env.BLENDER_DIR || path.join(os.tmpdir(), 'devtrack-blender');
const SCRIPTS = path.join(__dirname, 'blender');
const RUN_MS = 5 * 60 * 1000;

let installing = null;

async function install() {
  const bin = path.join(DIR, `blender-${VERSION}-linux-x64`, 'blender');
  if (fs.existsSync(bin)) return bin;
  if (process.platform !== 'linux') throw new Error('Set BLENDER_PATH to blender.exe to use the model viewer here.');
  fs.mkdirSync(DIR, { recursive: true });
  const archive = path.join(DIR, `blender-${VERSION}.tar.xz`);
  const started = Date.now();
  console.log(`[Blender] Downloading ${VERSION}…`);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Could not download Blender ${VERSION}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive));
  await new Promise((resolve, reject) => execFile('tar', ['-xJf', archive, '-C', DIR], { timeout: 10 * 60 * 1000 },
    err => (err ? reject(new Error(`Could not unpack Blender: ${err.message}`)) : resolve())));
  fs.rmSync(archive, { force: true });
  if (!fs.existsSync(bin)) throw new Error('Blender unpacked, but the program is not where it should be.');
  console.log(`[Blender] Ready in ${Math.round((Date.now() - started) / 1000)}s`);
  return bin;
}

function blenderPath() {
  if (process.env.BLENDER_PATH) return Promise.resolve(process.env.BLENDER_PATH);
  if (!installing) installing = install().catch(err => { installing = null; throw err; });
  return installing;
}

// One Blender at a time: each can take a few hundred MB of memory.
let queue = Promise.resolve();
function run(blendFile, script, args) {
  const job = queue.then(async () => {
    const bin = await blenderPath();
    return new Promise((resolve, reject) => {
      // No .blend (an FBX accessory): Blender starts empty and the script imports the file.
      execFile(bin, ['-b', '-Y', '--factory-startup', '-noaudio', ...(blendFile ? [blendFile] : []), '--python-exit-code', '1',
        '--python', path.join(SCRIPTS, script), '--', ...args], { timeout: RUN_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const said = `${stdout}\n${stderr}`.split('\n').filter(l => /error|exception|could not|unsupported|SystemExit/i.test(l)).slice(-6).join('\n');
        reject(new Error(err.killed ? 'Blender took too long and was stopped.' : (said || err.message).slice(0, 1500)));
      });
    });
  });
  queue = job.catch(() => {});
  return job;
}

// A scratch folder for one job, removed afterwards.
async function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-model-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// .blend (or .fbx) in, { glb, parts, blender } out.
function inspect(blend, format = 'blend') {
  return withTemp(async dir => {
    const file = path.join(dir, format === 'fbx' ? 'model.fbx' : 'model.blend');
    fs.writeFileSync(file, blend);
    const glb = path.join(dir, 'model.glb');
    const meta = path.join(dir, 'model.json');
    if (format === 'fbx') await run(null, 'inspect.py', [glb, meta, file]);
    else await run(file, 'inspect.py', [glb, meta]);
    const info = JSON.parse(fs.readFileSync(meta, 'utf8'));
    return { glb: fs.readFileSync(glb), parts: info.parts, blender: info.blender };
  });
}

// .blend + { rename: {old: new}, drop: [old], embed, scale, accessories } in, FBX bytes out.
// Each accessory brings its file as data; it's written next to the plan for Blender to add.
function exportFbx(blend, plan) {
  return withTemp(async dir => {
    const file = path.join(dir, 'model.blend');
    fs.writeFileSync(file, blend);
    const accessories = (plan.accessories || []).map((a, i) => {
      const accFile = path.join(dir, `accessory${i + 1}.${a.format === 'fbx' ? 'fbx' : 'blend'}`);
      fs.writeFileSync(accFile, a.data);
      const { data, ...rest } = a;
      return { ...rest, path: accFile };
    });
    const planFile = path.join(dir, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ ...plan, accessories }));
    const fbx = path.join(dir, 'model.fbx');
    await run(file, 'export.py', [planFile, fbx]);
    return fs.readFileSync(fbx);
  });
}

// Fetch Blender ahead of the first model, so nobody waits for the download.
function prefetch() {
  if (process.env.BLENDER_PATH || process.platform !== 'linux') return;
  setTimeout(() => blenderPath().catch(err => console.error('[Blender]', err.message)), 30 * 1000);
}

module.exports = { inspect, exportFbx, prefetch, VERSION };
