const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();

// GET /api/users - list all engineers
router.get('/', auth, async (req, res) => {
  try {
    // Use raw SQL for assignedReports.status so Prisma's stale Status enum
    // client never tries to deserialize newer values like "declined".
    const users = await prisma.$queryRaw`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', t.id, 'done', t.done))
          FILTER (WHERE t.id IS NOT NULL), '[]'
        ) AS tasks,
        COALESCE(
          json_agg(DISTINCT jsonb_build_object('id', r.id, 'status', r.status::text))
          FILTER (WHERE r.id IS NOT NULL), '[]'
        ) AS "assignedReports"
      FROM "User" u
      LEFT JOIN "Task" t ON t."userId" = u.id
      LEFT JOIN "_AssignedReports" ar ON ar."A" = u.id
      LEFT JOIN "Report" r ON r.id = ar."B"
      GROUP BY u.id
      ORDER BY u."createdAt" ASC
    `;
    res.json(users);
  } catch (err) {
    console.error('[GET users]', err.message);
    res.status(500).json({ error: 'Could not fetch users' });
  }
});

module.exports = router;
