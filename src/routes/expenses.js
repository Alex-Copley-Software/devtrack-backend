const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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

router.get('/', async (req, res) => {
  const { year, category, status, search } = req.query;
  const where = {};
  if (year) where.taxYear = Number(year);
  if (category && category !== 'all') where.category = category;
  if (status && status !== 'all') where.paymentStatus = status;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { vendor: { contains: search, mode: 'insensitive' } },
      { notes: { contains: search, mode: 'insensitive' } },
    ];
  }

  try {
    const expenses = await prisma.expense.findMany({
      where,
      include: { receipts: true },
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
    });
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
    const receipts = await persistReceiptFiles(req.files);
    const expense = await prisma.expense.create({
      data: {
        ...data,
        createdById: req.user.id,
        receipts: {
          create: receipts
        }
      },
      include: { receipts: true },
    });
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
    const expense = await prisma.expense.update({
      where: { id: req.params.id },
      data: patch,
      include: { receipts: true },
    });
    res.json(expense);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Expense not found' });
    console.error('[Expenses PATCH]', err.message);
    res.status(500).json({ error: 'Could not update expense' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const expense = await prisma.expense.findUnique({
      where: { id: req.params.id },
      include: { receipts: true },
    });
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    await prisma.expense.delete({ where: { id: req.params.id } });
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
    const expense = await prisma.expense.findUnique({ where: { id: req.params.id } });
    if (!expense) return res.status(404).json({ error: 'Expense not found' });

    const receipts = await persistReceiptFiles(req.files);
    await prisma.expenseReceipt.createMany({
      data: receipts.map(receipt => ({ ...receipt, expenseId: req.params.id }))
    });
    const updated = await prisma.expense.findUnique({
      where: { id: req.params.id },
      include: { receipts: true },
    });
    res.status(201).json(updated);
  } catch (err) {
    console.error('[Expense receipts POST]', err.message);
    res.status(500).json({ error: 'Could not upload receipts' });
  }
});

router.get('/:id/receipts/:receiptId', async (req, res) => {
  try {
    const receipt = await prisma.expenseReceipt.findFirst({
      where: { id: req.params.receiptId, expenseId: req.params.id },
    });
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
    await sendReceiptFile(res, receipt);
  } catch (err) {
    console.error('[Expense receipt GET]', err.message);
    res.status(500).json({ error: 'Could not download receipt' });
  }
});

router.delete('/:id/receipts/:receiptId', async (req, res) => {
  try {
    const receipt = await prisma.expenseReceipt.findFirst({
      where: { id: req.params.receiptId, expenseId: req.params.id },
    });
    if (!receipt) return res.status(404).json({ error: 'Receipt not found' });

    await prisma.expenseReceipt.delete({ where: { id: receipt.id } });
    await removeReceiptFile(receipt);
    res.json({ success: true });
  } catch (err) {
    console.error('[Expense receipt DELETE]', err.message);
    res.status(500).json({ error: 'Could not delete receipt' });
  }
});

module.exports = router;
