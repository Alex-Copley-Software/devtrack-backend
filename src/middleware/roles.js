function hasRole(user, roles) {
  if (user?.role === 'owner') return true;
  return Boolean(user && roles.includes(user.role));
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (hasRole(req.user, roles)) return next();
    return res.status(403).json({ error: 'Insufficient role' });
  };
}

module.exports = {
  hasRole,
  requireRole,
};
