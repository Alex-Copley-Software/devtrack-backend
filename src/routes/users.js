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
      WITH latest_review AS (
        SELECT DISTINCT ON (rh."reportId")
          rh."reportId",
          rh."actorId"
        FROM "ReportHistory" rh
        WHERE rh.action LIKE '%Sent to QA Review%'
        ORDER BY rh."reportId", rh."createdAt" DESC
      ),
      resolved_counts AS (
        SELECT
          lr."actorId",
          COUNT(DISTINCT r.id)::int AS resolved
        FROM latest_review lr
        JOIN "Report" r ON r.id = lr."reportId"
        WHERE r.status = 'resolved'
        GROUP BY lr."actorId"
      )
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        CASE WHEN u.role = 'engineer' THEN COALESCE(rc.resolved, 0) ELSE 0 END AS "resolvedReports",
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
      LEFT JOIN "_AssignedReports" ar ON ar."B" = u.id
      LEFT JOIN "Report" r ON r.id = ar."A"
      LEFT JOIN resolved_counts rc ON rc."actorId" = u.id
      GROUP BY u.id, rc.resolved
      ORDER BY u."createdAt" ASC
    `;
    res.json(users);
  } catch (err) {
    console.error('[GET users]', err.message);
    res.status(500).json({ error: 'Could not fetch users' });
  }
});

module.exports = router;
