// page-access.js
// Gates a route by a dashboard pageAccess checkbox rather than role — lets a
// QA/reviewer/engineer with the box checked in on a page without granting
// them broader role permissions. True admin/owner always passes. pageAccess
// isn't in the JWT, so it's looked up fresh on each request.

const { PrismaClient } = require('@prisma/client');
const { hasRole } = require('./roles');

const prisma = new PrismaClient();

function requirePageAccess(page) {
  return async (req, res, next) => {
    if (hasRole(req.user, ['admin'])) return next();
    try {
      const rows = await prisma.$queryRawUnsafe(`SELECT "pageAccess" FROM "User" WHERE id = $1`, req.user.id);
      if ((rows[0]?.pageAccess || []).includes(page)) return next();
    } catch (err) {
      console.error('[PageAccess check]', err.message);
    }
    return res.status(403).json({ error: 'Insufficient role' });
  };
}

module.exports = { requirePageAccess };
