const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { addClient } = require('../events');

function eventAuth(req, res, next) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

router.get('/', eventAuth, addClient);

module.exports = router;
