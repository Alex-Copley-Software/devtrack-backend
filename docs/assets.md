# Assets page and AI Asset Agent

The Assets page replaces the `AE_Update_Asset_Tracker` Google Sheet as the
place update content and asset tasks are tracked. The AI Asset Agent reads
chosen Discord channels and proposes changes to the tracker for a lead to
accept.

Everything is off until you switch it on. Design notes and the reasons
behind them are in [assets-plan.md](assets-plan.md).

## Switching it on

There are no migrations to run. The tables create themselves on the first
request after the flag is on.

| Service | Variable | What it does |
|---------|----------|--------------|
| Backend | `ASSETS_ENABLED=true` | Turns on `/api/assets` and the page. Off means 404 and no tables. |
| Backend | `ASSET_AGENT_ENABLED=true` | Turns on message storage, the agent and the suggestions inbox. |
| Backend | `ANTHROPIC_API_KEY` | Already set for team reports. The agent uses the same key. |
| Backend | `ASSET_SHEET_ID` | The sheet to import. |
| Backend | `GOOGLE_SERVICE_ACCOUNT_JSON` | Only for importing a private sheet, and for the export. |
| Backend | `ASSET_SHEET_EXPORT=true` | Optional nightly export back to the sheet. |
| Bot | `ASSETS_ENABLED=true` | Registers the `/assets` command. |
| Bot | `ASSET_AGENT_ENABLED=true` | Starts reading allowlisted channels and polling the agent. |
| Bot | `ASSET_AGENT_REVIEW_CHANNEL_ID` | Channel where suggestions are posted with Accept / Reject buttons. |
| Netlify | none | The dashboard reads the flag from the backend. |

Suggested order:

1. Backend `ASSETS_ENABLED=true`. Open the dashboard as an admin: an
   **Assets** entry appears in the top nav.
2. Import the sheet (below), or seed demo data to look around first.
3. In **Admin**, tick the **Assets** box for each person who should see the
   page. Admins and owners always can.
4. On the **Team** view, link roster devs to their DevTrack logins and check
   their Discord profile links.
5. Bot `ASSETS_ENABLED=true` for the `/assets` command.
6. When you want the agent: `ASSET_AGENT_ENABLED=true` on both, set the
   review channel, then add channels under **Agent settings**.

Optional backend settings: `ASSET_AGENT_FILTER_MODEL` (default
`claude-haiku-4-5-20251001`), `ASSET_AGENT_EXTRACT_MODEL` (default
`claude-sonnet-5-5`), `ASSET_AGENT_EXTRACT_EFFORT` (default `medium`; `off`
to omit it for a model that does not accept it), `ASSET_AGENT_PRICING` (JSON
price overrides for the cost log), `ASSET_SHEET_EXPORT_HOUR` (UTC hour,
default 8).

## Importing the sheet

The quick way: share the sheet as **Anyone with the link can view**, set
`ASSET_SHEET_ID`, and skip to step 4. With no service account configured the
importer reads the sheet anonymously through its public link (hidden tabs
included). The service account is only needed for a private sheet or for the
nightly export.

1. In Google Cloud, create a service account and a JSON key for it, and
   enable the Google Sheets API on that project.
2. Share the sheet with the service account's email. Viewer is enough for
   the import; it needs Editor if you want the nightly export.
3. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the key file's contents (raw JSON, or
   base64 of it, which avoids escaping problems) and `ASSET_SHEET_ID` to the
   id from the sheet's URL.
4. Dry run first. It reads the sheet, prints counts and every row it could
   not map, and writes nothing. It does not need a database connection:

   ```bash
   node scripts/import-asset-sheet.js --dry-run
   ```

5. Fix anything in the sheet you care about (unknown dev names, statuses
   outside the list, content types with no match), then import. On Railway:

   ```bash
   railway ssh -s devtrack-backend "node scripts/import-asset-sheet.js"
   ```

The import is safe to re-run. It matches on Task ID, Update # + Internal
Name, and dev name, and only writes differences, so a second run changes
nothing. It reads the Updates, Update Content, Templates, Task Tracker, Devs,
Lists and Dev Lists tabs, finds each header row by its column names, and
ignores Dashboard, How To Use, Settings and every computed column.

What it does with rows that do not fit:

- A lead or owner who is not on the Devs tab is kept as plain text.
- An assignee who is not on the Devs tab is left unassigned and reported.
- A status outside the list is left as Not Started and reported.
- A blank cell never overwrites a value already in DevTrack.
- Pre-numbered rows nobody has filled in, and the helper columns on Dev
  Lists, are skipped without comment.

Update numbers can be decimal (3.5).

After the import DevTrack is the source of truth. With
`ASSET_SHEET_EXPORT=true` the backend rewrites a **DevTrack Export** tab once
a day for anyone who still wants to look in the sheet. Nothing is ever read
back from that tab. `node scripts/import-asset-sheet.js --export` runs it now.

## Roles

| Can | Who |
|-----|-----|
| Everything, including templates and agent settings | `owner`, `admin` |
| Edit updates, items, tasks and the roster; accept suggestions | `engineer`; a login linked to a dev with the **Manager** discipline; the lead of that update |
| Change status, due date and notes on their own tasks | Any login linked to a roster dev |
| Read only | Anyone else with the Assets box ticked |

A roster dev is linked to a DevTrack login on the **Team** view (Edit, then
**DevTrack login**). Most asset devs will not have a login; they can still
use `/assets` in Discord, which recognizes them by the Discord ID in their
profile link.

## The page

`/assets/` on the dashboard. Views: Overview, Board, Tasks, Kanban, Team,
Suggestions, Templates, Agent settings.

- **Ctrl/Cmd+K** opens the command palette. **?** lists every shortcut.
- In the task table: `j`/`k` move, `x` selects, `s` status, `a` assign,
  `d` due date, `e` notes, `Enter` opens the task. With rows selected the
  same keys act on all of them.
- Edits apply immediately and roll back with a message if the save fails.
  Other people's edits arrive live.
- The assignee picker shows devs who work in the task's discipline. "Show
  everyone" overrides that.
- Progress is Done over tasks that are not N/A. Archived items and cancelled
  or released updates do not count toward a dev's workload.

**Templates.** Each content type has a checklist. Creating an item creates
one task per checklist entry. Adding an entry later adds that task to every
existing item of the type, without touching their status or assignments;
the editor shows how many tasks that will be before you save. Removing an
entry hides its tasks and keeps their history; restoring it brings them back.

## Audit log

**Audit log** in the left rail, for leads, managers and admins. Every change
to a task, item, update, roster entry or template is listed with who made
it, when, where it came from (a person, the agent, the sheet import) and the
value before and after. Rejected agent suggestions, agent setting changes
and channel allowlist changes are listed too. Filter by person, source, kind
and date, search any name or value, and export what the filters show as CSV.

- **Revert** on an entry puts that one field back to what it was before the
  change. If the field has been changed again since, the preview says so.
- **Restore to here** undoes everything recorded after an entry, for one
  thing, one item, one update or the whole tracker. A preview lists every
  field that will change before anything is written.

Nothing is ever removed from the log. A revert is a new change, recorded
under the person who did it and linked to the entry it undoes, so it can be
reverted in turn. Things that were created or deleted after the chosen point
are reported in the preview but not undone automatically.

## The agent

```
message in an allowlisted channel
  -> stored (id, channel, author, time, text, attachment names and links)
  -> batched per channel or thread: 25 messages, or 3 minutes of quiet
  -> pass 1, Haiku: is this about content, assets or task progress?
  -> pass 2, Sonnet: proposed actions, as a strict tool call
  -> validated in code, deduped, stored as pending suggestions
  -> posted to the review channel and shown in the Suggestions inbox
  -> a lead accepts, edits or rejects
```

**Discord setup.** The bot needs the Message Content privileged intent,
which it already has for logging report threads. Nothing outside the
allowlist is read or stored; a thread is covered when its parent channel is
listed. A category ID works too: every channel, forum and forum post under
that category is read, including ones created later. Add channels or
categories under **Agent settings** by ID (Discord settings,
Advanced, Developer Mode; then right-click a channel, Copy Channel ID). The
bot picks up allowlist changes within two minutes.

**What it can propose:** a task status change, an assignment, a due date, a
note (asset IDs, links, decisions), marking a task blocked with the reason, a
new content item, or a flag for something asset-related it could not place.

**What stops a bad suggestion.** Every action is checked in code: the task,
dev, content type and update must exist, values must be in the lists, and at
least one evidence message must be from the batch. The same change is not
proposed again while it is pending or within a day of being rejected. If a
person changed a field after the evidence message was posted, the agent will
not propose overwriting it.

**Reviewing.** In the inbox each card shows the before and after, the
model's confidence and reason, and the Discord messages it came from. In the
review channel the Accept and Reject buttons work for update leads, devs with
the Manager discipline, and devs linked to an engineer or admin login.
Accepted changes appear in the activity log marked as agent changes, with
who accepted them and a link to the message.

**Auto-apply** is off. An admin can turn it on per action type with a
confidence threshold. New content items and unknown flags can never be
auto-applied.

**Cost.** Every model call is logged with its tokens and cost. The settings
panel shows today's spend, the last 14 days and recent batches. The agent
pauses for the rest of the UTC day when it reaches the daily budget (default
$2; 0 removes the cap). Messages keep collecting while it is paused and are
processed when it resumes. Raw messages are deleted after 30 days
(configurable).

**Slash commands**

| Command | Shows |
|---------|-------|
| `/assets update [number]` | Update summary. Defaults to the one in development. |
| `/assets mine` | Your open tasks. |
| `/assets item name:<name>` | An item's checklist and progress. |
| `/assets task id:<n> status:<status>` | Updates one of your own tasks. |

### Tuning it

The prompts are plain files: [`src/assets/prompts/filter.md`](../src/assets/prompts/filter.md)
and [`src/assets/prompts/extract.md`](../src/assets/prompts/extract.md). Edit,
commit, deploy. To see the effect before deploying:

```bash
node scripts/assets-agent-smoke.js                    # built-in sample conversation
node scripts/assets-agent-smoke.js my-conversation.txt  # one "Name: message" per line
```

It runs both passes against a small fixed tracker, prints the actions, which
ones passed validation and why the rest were dropped, and the cost (about a
cent). It writes nothing.

Things worth adjusting first:

- The agent treats "done" from the person doing the work as Review. If your
  team means Done, change that line in `extract.md`.
- If too much chatter reaches the second pass, tighten `filter.md`. If real
  updates are being skipped, loosen it; the filter is told to pass anything
  it is unsure about.
- If suggestions are right but confidence is low, the calibration paragraph
  under Rules in `extract.md` is what sets it.

## Demo data, local run, tests

```bash
node scripts/assets-dev-server.js          # then open http://localhost:4321
node scripts/assets-dev-server.js --big    # 6,000+ tasks
node scripts/assets-dev-server.js --sheet <sheet id>   # the real tracker, read from a link-shared sheet
npm test
```

The dev server needs no database, no deploy and no API key: it runs the real
routes against an in-memory Postgres with demo data and a stand-in for the
model, and serves the dashboard from the sibling repo folder. Sign in as
`/dev-login?as=admin`, `manager`, `dev` or `viewer`.

To put the demo data in a real database instead (updates #900 and #901):

```bash
node scripts/seed-assets-demo.js
node scripts/seed-assets-demo.js --remove
```

The tests use the same in-memory Postgres, so they exercise the real SQL.
They cover task generation from templates, the importer against a fixture of
the sheet, rollup math, suggestion validation and dedupe, role permissions,
and the HTTP routes end to end.

## Troubleshooting

- **No Assets entry in the nav.** `ASSETS_ENABLED` is not `true` on the
  backend, or the Assets box is not ticked on that account.
- **`/assets` says the tracker is not switched on.** The backend flag is off.
  If the command itself is missing, the bot flag is off; Discord can take a
  few minutes to show a newly registered command.
- **`/assets mine` says you are not on the roster.** That dev's roster entry
  has no Discord profile link, or the link has no user ID in it.
- **Agent settings shows "No API key".** `ANTHROPIC_API_KEY` is missing on
  the backend.
- **Batches fail.** The error is listed under Recent batches. Run the smoke
  script with the same key to reproduce it.
- **Suggestions are not posted in Discord.** `ASSET_AGENT_REVIEW_CHANNEL_ID`
  is unset or the bot cannot post there. They are still in the web inbox.
