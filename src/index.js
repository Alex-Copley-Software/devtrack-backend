require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const reportRoutes = require('./routes/reports');
const taskRoutes = require('./routes/tasks');
const userRoutes = require('./routes/users');
const botRoutes = require('./routes/bot');
const messageRoutes = require('./routes/messages');
const historyRoutes = require('./routes/history');
const expenseRoutes = require('./routes/expenses');
const importRoutes = require('./routes/imports');
const eventRoutes = require('./routes/events');
const notionWebhookRoutes = require('./routes/notion-webhook');
const notionTaskRoutes = require('./routes/notion-tasks');
const authMiddleware = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3001;
const allowedOrigins = (process.env.CORS_ORIGIN || 'https://lambent-lily-7bf643.netlify.app')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.set('trust proxy', 1);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    const error = new Error('Not allowed by CORS');
    error.status = 403;
    return callback(error);
  }
}));
// Notion webhook signature verification needs the exact raw request bytes,
// so it's mounted with a raw body parser before the global JSON parser below.
app.use('/api/notion', express.raw({ type: '*/*' }), notionWebhookRoutes);

app.use(express.json());
if (process.env.PROTECT_UPLOADS === 'true') {
  app.use('/uploads', authMiddleware, express.static(path.join(__dirname, '../uploads')));
} else {
  app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
}

app.use('/api/auth', authRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/users', userRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/imports', importRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/notion-tasks', notionTaskRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/config', (req, res) => {
  res.json({
    discordServerId: process.env.DISCORD_SERVER_ID || null,
  });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`DevTrack API running on http://localhost:${PORT}`);
});
