const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { uploadPrivateFile, getPrivateObject, deletePrivateObject, isPrivateConfigured } = require('../r2');

const prisma = new PrismaClient();
const receiptsDir = path.join(__dirname, '../../uploads/expense-receipts');
if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
let schemaReady;
const EXPENSE_R2_BUCKET = process.env.EXPENSE_R2_BUCKET_NAME || process.env.R2_EXPENSE_BUCKET_NAME;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, receiptsDir),
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/heif'
    ];
    cb(null, allowed.includes(file.mimetype));
  }
});

router.use(auth, requireRole('admin'));
router.use(async (req, res, next) => {
  try {
    if (!schemaReady) schemaReady = ensureExpenseTables();
    await schemaReady;
    next();
  } catch (err) {
    console.error('[Expenses schema]', err.message);
    res.status(500).json({ error: 'Expense storage is not ready' });
  }
});

async function ensureExpenseTables() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Expense" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "vendor" TEXT,
      "category" TEXT NOT NULL DEFAULT 'software',
      "amount" DECIMAL(12,2) NOT NULL,
      "currency" TEXT NOT NULL DEFAULT 'USD',
      "expenseDate" TIMESTAMP(3) NOT NULL,
      "paymentType" TEXT,
      "paymentStatus" TEXT NOT NULL DEFAULT 'paid',
      "writeOffType" TEXT NOT NULL DEFAULT 'business',
      "notes" TEXT,
      "taxYear" INTEGER NOT NULL,
      "createdById" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Expense_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "User"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ExpenseReceipt" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "expenseId" TEXT NOT NULL,
      "filename" TEXT NOT NULL,
      "mimetype" TEXT NOT NULL,
      "size" INTEGER NOT NULL,
      "path" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ExpenseReceipt_expenseId_fkey"
        FOREIGN KEY ("expenseId") REFERENCES "Expense"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Expense_taxYear_idx" ON "Expense"("taxYear")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Expense_expenseDate_idx" ON "Expense"("expenseDate")`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ExpenseReceipt_expenseId_idx" ON "ExpenseReceipt"("expenseId")`);
}

function toExpensePayload(body) {
  const amount = Number(body.amount);
  const expenseDate = body.expenseDate ? new Date(body.expenseDate) : new Date();
  if (!body.title || !Number.isFinite(amount) || Number.isNaN(expenseDate.getTime())) return null;

  return {
    title: String(body.title).trim(),
    vendor: body.vendor ? String(body.vendor).trim() : null,
    category: body.category || 'software',
    amount,
    currency: body.currency || 'USD',
    expenseDate,
    paymentType: body.paymentType || null,
    paymentStatus: body.paymentStatus || 'paid',
    writeOffType: body.writeOffType || 'business',
    notes: body.notes || null,
    taxYear: Number(body.taxYear) || expenseDate.getFullYear(),
  };
}

function receiptKey(file) {
  return `expense-receipts/${new Date().getFullYear()}/${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function isR2Path(value) {
  return typeof value === 'string' && value.startsWith('r2://');
}

function r2KeyFromPath(value) {
  return value.replace(/^r2:\/\/[^/]+\//, '');
}

async function persistReceiptFiles(files) {
  const useR2 = isPrivateConfigured(EXPENSE_R2_BUCKET);
  const receipts = [];

  for (const file of files || []) {
    let storedPath = file.path;
    if (useR2) {
      const key = receiptKey(file);
      const uploadedKey = await uploadPrivateFile(file.path, key, file.mimetype, EXPENSE_R2_BUCKET);
      if (uploadedKey) {
        storedPath = `r2://${EXPENSE_R2_BUCKET}/${uploadedKey}`;
        fs.promises.unlink(file.path).catch(() => {});
      }
    }

    receipts.push({
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      path: storedPath,
    });
  }

  return receipts;
}

async function removeReceiptFile(receipt) {
  if (isR2Path(receipt.path)) {
    await deletePrivateObject(r2KeyFromPath(receipt.path), EXPENSE_R2_BUCKET);
    return;
  }
  await fs.promises.unlink(receipt.path).catch(() => {});
}

async function sendReceiptFile(res, receipt) {
  if (isR2Path(receipt.path)) {
    const object = await getPrivateObject(r2KeyFromPath(receipt.path), EXPENSE_R2_BUCKET);
    if (!object?.Body) return res.status(404).json({ error: 'Receipt file not found' });
    res.setHeader('Content-Type', receipt.mimetype || object.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${receipt.filename.replace(/"/g, '')}"`);
    return object.Body.pipe(res);
  }
  return res.download(receipt.path, receipt.filename);
}

async function fetchExpenses(whereClauses = [], values = [], includeReceiptPath = false) {
  const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const receiptPathField = includeReceiptPath ? `'path', er.path,` : '';
  return prisma.$queryRawUnsafe(`
    SELECT e.*,
      COALESCE(
        json_agg(
          jsonb_build_object(
            'id', er.id,
            'filename', er.filename,
            'mimetype', er.mimetype,
            'size', er.size,
            ${receiptPathField}
            'createdAt', er."createdAt"
          )
        ) FILTER (WHERE er.id IS NOT NULL),
        '[]'
      ) AS receipts
    FROM "Expense" e
    LEFT JOIN "ExpenseReceipt" er ON er."expenseId" = e.id
    ${where}
    GROUP BY e.id
    ORDER BY e."expenseDate" DESC, e."createdAt" DESC
  `, ...values);
}

async function fetchExpense(id, includeReceiptPath = false) {
  const rows = await fetchExpenses(['e.id = $1'], [id], includeReceiptPath);
  return rows[0] || null;
}

async function fetchReceipt(expenseId, receiptId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM "ExpenseReceipt" WHERE id = $1 AND "expenseId" = $2 LIMIT 1`,
    receiptId,
    expenseId
  );
  return rows[0] || null;
}

router.get('/', async (req, res) => {
  const { year, category, status, search } = req.query;
  const where = [];
  const values = [];
  let idx = 1;
  if (year) { where.push(`e."taxYear" = $${idx++}`); values.push(Number(year)); }
  if (category && category !== 'all') { where.push(`e.category = $${idx++}`); values.push(category); }
  if (status && status !== 'all') { where.push(`e."paymentStatus" = $${idx++}`); values.push(status); }
  if (search) {
    where.push(`(e.title ILIKE $${idx} OR e.vendor ILIKE $${idx} OR e.notes ILIKE $${idx})`);
    values.push(`%${search}%`);
    idx++;
  }

  try {
    const expenses = await fetchExpenses(where, values);
    res.json(expenses);
  } catch (err) {
    console.error('[Expenses GET]', err.message);
    res.status(500).json({ error: 'Could not fetch expenses' });
  }
});

router.post('/', upload.array('receipts', 6), async (req, res) => {
  const data = toExpensePayload(req.body);
  if (!data) return res.status(400).json({ error: 'title and valid amount are required' });

  try {
    const expenseId = crypto.randomUUID();
    const receipts = await persistReceiptFiles(req.files);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Expense" (
        id, title, vendor, category, amount, currency, "expenseDate",
        "paymentType", "paymentStatus", "writeOffType", notes, "taxYear", "createdById"
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `,
      expenseId, data.title, data.vendor, data.category, data.amount, data.currency,
      data.expenseDate, data.paymentType, data.paymentStatus, data.writeOffType,
      data.notes, data.taxYear, req.user.id
    );
    for (const receipt of receipts) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "ExpenseReceipt" (id, "expenseId", filename, mimetype, size, path)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, crypto.randomUUID(), expenseId, receipt.filename, receipt.mimetype, receipt.size, receipt.path);
    }
    const expense = await fetchExpense(expenseId);
    res.status(201).json(expense);
  } catch (err) {
    console.error('[Expenses POST]', err.message);
    res.status(500).json({ error: 'Could not create expense' });
  }
});

router.patch('/:id', async (req, res) => {
  const patch = {};
  if (req.body.title !== undefined) patch.title = String(req.body.title).trim();
  if (req.body.vendor !== undefined) patch.vendor = req.body.vendor ? String(req.body.vendor).trim() : null;
  for (const key of ['category', 'currency', 'paymentType', 'paymentStatus', 'writeOffType', 'notes']) {
    if (req.body[key] !== undefined) patch[key] = req.body[key] || null;
  }
  if (req.body.taxYear !== undefined) {
    const taxYear = Number(req.body.taxYear);
    if (!Number.isInteger(taxYear)) return res.status(400).json({ error: 'taxYear must be a valid year' });
    patch.taxYear = taxYear;
  }
  if (req.body.amount !== undefined) {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount)) return res.status(400).json({ error: 'amount must be valid' });
    patch.amount = amount;
  }
  if (req.body.expenseDate !== undefined) patch.expenseDate = new Date(req.body.expenseDate);

  try {
    const fields = Object.entries(patch);
    if (!fields.length) return res.json(await fetchExpense(req.params.id));

    const setClauses = [];
    const values = [];
    let idx = 1;
    const columnMap = {
      expenseDate: '"expenseDate"',
      paymentType: '"paymentType"',
      paymentStatus: '"paymentStatus"',
      writeOffType: '"writeOffType"',
      taxYear: '"taxYear"',
    };
    for (const [key, value] of fields) {
      setClauses.push(`${columnMap[key] || key} = $${idx++}`);
      values.push(value);
    }
    setClauses.push(`"updatedAt" = NOW()`);
    values.push(req.params.id);
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE "Expense" SET ${setClauses.join(', ')} WHERE id = $${idx}`,
      ...values
    );
    if (!updated) return res.status(404).json({ error: 'Expense not found' });
    const expense = await fetchExpense(req.params.id, true);
    res.json(expense);
  } catch (err) {
    console.error('[Expenses PATCH]', err.message);
    res.status(500).json({ error: 'Could not update expense' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const expense = await fetchExpense(req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    await prisma.$executeRawUnsafe(`DELETE FROM "Expense" WHERE id = $1`, req.params.id);
    for (const receipt of expense.receipts) {
      await removeReceiptFile(receipt);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Expenses DELETE]', err.message);
    res.status(500).json({ error: 'Could not delete expense' });
  }
});

router.post('/:id/receipts', upload.array('receipts', 6), async (req, res) => {
  try {
    const expense = await fetchExpense(req.params.id);
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    const receipts = await persistReceiptFiles(req.files);
    for (const receipt of receipts) {
      await prisma.$executeRawUnsafe(`
        INSERT INTO "ExpenseReceipt" (id, "expenseId", filename, mimetype, size, path)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, crypto.randomUUID(), req.params.id, receipt.filename, receipt.mimetype, receipt.size, receipt.path);
    }
    const updated = await fetchExpense(req.params.id);
    res.status(201).json(updated);
  } catch (err) {
    console.error('[Expense receipts POST]', err.message);
    res.status(500).json({ error: 'Could not upload receipts' });
  }
});

router.get('/:id/receipts/:receiptId', async (req, res) => {
  try {
    const receipt = await fetchReceipt(req.params.id, req.params.receiptId);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    await sendReceiptFile(res, receipt);
  } catch (err) {
    console.error('[Expense receipt GET]', err.message);
    res.status(500).json({ error: 'Could not download receipt' });
  }
});

router.delete('/:id/receipts/:receiptId', async (req, res) => {
  try {
    const receipt = await fetchReceipt(req.params.id, req.params.receiptId);
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

    await prisma.$executeRawUnsafe(`DELETE FROM "ExpenseReceipt" WHERE id = $1`, receipt.id);
    await removeReceiptFile(receipt);
    res.json({ success: true });
  } catch (err) {
    console.error('[Expense receipt DELETE]', err.message);
    res.status(500).json({ error: 'Could not delete receipt' });
  }
});

module.exports = router;
