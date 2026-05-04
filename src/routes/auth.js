const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');

const prisma = new PrismaClient();
const VALID_ROLES = new Set(['owner', 'admin', 'engineer', 'qa', 'reviewer']);
const LOGIN_WINDOW_MS = parseInt(process.env.LOGIN_RATE_WINDOW_MS || `${15 * 60 * 1000}`, 10);
const LOGIN_MAX_ATTEMPTS = parseInt(process.env.LOGIN_RATE_MAX_ATTEMPTS || '8', 10);
const loginAttempts = new Map();

function loginKey(req, email) {
  return `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(email || '').toLowerCase()}`;
}

function isRateLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

function optionalUser(req) {
  const header = req.headers.authorization;
  const token = header?.split(' ')[1];
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// POST /api/auth/change-password — any logged-in user changes their own password
router.post('/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (newPassword.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: req.user.id }, data: { password: hashed } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not change password' });
  }
});

// PATCH /api/auth/users/:id — admin updates any user
router.patch('/users/:id', auth, requireRole('admin'), async (req, res) => {
  const { name, email, role, password } = req.body;
  const data = {};
  if (name)  data.name  = name;
  if (email) data.email = email;
  if (role) {
    if (!VALID_ROLES.has(role)) return res.status(400).json({ error: 'Invalid role' });
    if (role === 'owner' && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Owner role required' });
    }
    data.role = role;
  }
  if (password) {
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    data.password = await bcrypt.hash(password, 10);
  }
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { role: true }
    });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'owner' && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Owner accounts cannot be edited by admins' });
    }

    const user = await prisma.user.update({
      where: { id: req.params.id }, data,
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });
    res.json({ user });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found' });
    res.status(500).json({ error: 'Could not update user' });
  }
});

// DELETE /api/auth/users/:id — admin removes a user
router.delete('/users/:id', auth, requireRole('admin'), async (req, res) => {
  if (req.params.id === req.user.id)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { role: true }
    });
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'owner') {
      return res.status(403).json({ error: 'Owner accounts cannot be deleted' });
    }

    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found' });
    res.status(500).json({ error: 'Could not delete user' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' });

  const key = loginKey(req, email);
  if (isRateLimited(key)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      recordLoginFailure(key);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      recordLoginFailure(key);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    clearLoginFailures(key);

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/register (first-user setup only; admin-only after that)
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name)
    return res.status(400).json({ error: 'Email, password, and name required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const userCount = await prisma.user.count();
    if (userCount > 0) {
      const currentUser = optionalUser(req);
      const adminUser = currentUser
        ? await prisma.user.findUnique({ where: { id: currentUser.id }, select: { role: true } })
        : null;
      if (!['admin', 'owner'].includes(adminUser?.role)) {
        return res.status(403).json({ error: 'Admin access required' });
      }
    }

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const role = userCount === 0 ? 'owner' : 'engineer';
    const user = await prisma.user.create({
      data: { email, password: hashed, name, role }
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, role: true }
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch user' });
  }
});

module.exports = router;
