# DevTrack Backend API

## Setup Instructions

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Then edit `.env` and fill in:
- `DATABASE_URL` — your PostgreSQL connection string
- `JWT_SECRET` — any long random string (e.g. run `openssl rand -base64 32`)
- `BOT_SECRET` — a shared secret your Discord bot will use
- `CORS_ORIGIN` — URL of your dashboard (e.g. http://localhost:5500)

**If using Railway for PostgreSQL:**
1. Go to railway.app → New Project → PostgreSQL
2. Click the database → Variables tab → Copy DATABASE_URL
3. Paste it into your .env

### 3. Push database schema
```bash
npm run db:push
```

### 4. Seed engineer accounts
```bash
npm run db:seed
```
This creates 5 engineer accounts. Default password: `devtrack123`

### 5. Start the server
```bash
npm run dev        # development with auto-reload
npm start          # production
```
Server runs at http://localhost:3001

---

## API Reference

### Auth
| Method | Route | Description |
|--------|-------|-------------|
| POST | /api/auth/login | Login → returns JWT token |
| POST | /api/auth/register | Create new engineer account |
| GET | /api/auth/me | Get current user (requires token) |

### Reports
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/reports | List all reports (supports ?type=bug&status=open&search=) |
| GET | /api/reports/:id | Get single report |
| POST | /api/reports | Create report (supports file uploads) |
| PATCH | /api/reports/:id | Update status, priority, assignees |
| POST | /api/reports/:id/upvote | Increment upvote count |
| DELETE | /api/reports/:id | Delete report |

### Tasks
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/tasks | All tasks for all engineers |
| GET | /api/tasks/my | Current user's tasks only |
| POST | /api/tasks | Create task |
| PATCH | /api/tasks/:id | Toggle done, update text |
| DELETE | /api/tasks/:id | Delete task |

### Users
| Method | Route | Description |
|--------|-------|-------------|
| GET | /api/users | List all engineers with task/report counts |

### Bot Webhook
| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| POST | /api/bot/report | Discord bot submits new report | x-bot-secret header |

---

## Authentication
All `/api/*` routes (except /api/auth/login and /api/bot/*) require:
```
Authorization: Bearer <token>
```

Bot routes use:
```
x-bot-secret: <your BOT_SECRET from .env>
```

---

## Deployment (Railway)
1. Push this folder to GitHub
2. railway.app → New Project → Deploy from GitHub
3. Add all .env variables in the Railway dashboard
4. Railway auto-detects Node.js and runs `npm start`
