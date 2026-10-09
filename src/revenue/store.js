// Small database layer for the Revenue page. Everything goes through the
// two raw-SQL methods the rest of DevTrack uses, so it runs unchanged on the
// real Prisma client and on the in-process Postgres the tests use.

const { COLUMNS } = require('./schema');

class RevenueError extends Error {
  constructor(status, detail) { super(detail); this.status = status; this.detail = detail; }
}

// A plain reader/writer over a Prisma client or a transaction handle.
function handle(prisma) {
  return {
    prisma,
    all: (sql, ...params) => prisma.$queryRawUnsafe(sql, ...params),
    one: async (sql, ...params) => (await prisma.$queryRawUnsafe(sql, ...params))[0] || null,
    run: (sql, ...params) => prisma.$executeRawUnsafe(sql, ...params),
  };
}

// A reader that remembers identical queries. Resolving one month asks the
// same things (the month's expenses, who the owner is, who shares costs)
// once per person; this turns hundreds of round trips into a few dozen.
// Only for read-only work within a single request.
function reader(prisma) {
  const cache = new Map();
  const all = (sql, ...params) => {
    const key = `${sql}\u0000${JSON.stringify(params)}`;
    if (!cache.has(key)) cache.set(key, prisma.$queryRawUnsafe(sql, ...params));
    return cache.get(key);
  };
  return { prisma, all, one: async (sql, ...params) => (await all(sql, ...params))[0] || null };
}

// Several statements that must land together (firing someone, splitting a
// share term at a month boundary, an import).
async function transaction(prisma, fn) {
  if (typeof prisma.$transaction === 'function') return prisma.$transaction(tx => fn(handle(tx)), { timeout: 60000, maxWait: 10000 });
  return fn(handle(prisma));
}

// Values are coerced to the column's type on the way in. The page sends
// numbers as numbers and ids as numbers, but a text column handed a number
// (a Roblox user id typed into a number box, say) must still be stored as text.
function coerce(table, column, value) {
  if (value === undefined || value === null) return null;
  const kind = COLUMNS[table][column];
  if (kind === 'int') {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) throw new RevenueError(422, `${column} must be a whole number`);
    return n;
  }
  if (kind === 'real') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new RevenueError(422, `${column} must be a number`);
    return n;
  }
  return String(value);
}
const cast = (table, column, n) => {
  const kind = COLUMNS[table][column];
  return `$${n}::${kind === 'int' ? 'int' : kind === 'real' ? 'double precision' : 'text'}`;
};

// INSERT the given columns, return the new id.
async function insert(db, table, values) {
  const cols = Object.keys(values);
  const row = await db.one(
    `INSERT INTO rev_${table} (${cols.join(', ')}) VALUES (${cols.map((c, i) => cast(table, c, i + 1)).join(', ')}) RETURNING id`,
    ...cols.map(c => coerce(table, c, values[c])));
  return row.id;
}

// The original's PATCH pattern: load the row, lay the fields that were
// actually sent over it, write every editable column back. A field sent as
// null is set to null; a field not sent is left alone.
async function patch(db, table, id, updates, editable, notFound) {
  const existing = await db.one(`SELECT * FROM rev_${table} WHERE id = $1`, Number(id));
  if (!existing) throw new RevenueError(404, notFound);
  const merged = { ...existing, ...updates };
  await db.run(
    `UPDATE rev_${table} SET ${editable.map((c, i) => `${c} = ${cast(table, c, i + 1)}`).join(', ')} WHERE id = $${editable.length + 1}`,
    ...editable.map(c => coerce(table, c, merged[c])), Number(id));
  return merged;
}

async function remove(db, table, id, notFound) {
  const existing = await db.one(`SELECT * FROM rev_${table} WHERE id = $1`, Number(id));
  if (!existing) throw new RevenueError(404, notFound);
  await db.run(`DELETE FROM rev_${table} WHERE id = $1`, Number(id));
  return existing;
}

// Only the keys the request actually carried, from the ones a model allows
// (pydantic's exclude_unset): the difference between "set it to null" and
// "did not mention it".
function sent(body, fields) {
  const out = {};
  for (const f of fields) if (body && Object.prototype.hasOwnProperty.call(body, f)) out[f] = body[f];
  return out;
}

// Required fields, as the original's request models enforce them.
function required(body, fields) {
  for (const f of fields) {
    if (!body || body[f] === undefined || body[f] === null) throw new RevenueError(422, `${f} is required`);
  }
}

module.exports = { RevenueError, handle, reader, transaction, coerce, insert, patch, remove, sent, required };
