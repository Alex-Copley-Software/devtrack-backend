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

## Availability and blocked tasks

**Ready to be tasked.** A dev is ready when they are Active and have no open
task in any live update. The Overview has a card listing them by discipline,
and the Team view has a **Ready to task** filter and a dot beside each name
(yellow ready, green tasked).

**Status on Discord posts.** With `ASSET_STATUS_POSTS=true` on the bot, each
dev's forum post gets a dot at the start of its title: 🟢 has open tasks,
🟡 ready to be tasked. It is rechecked every two minutes, so it follows the
tracker: when a task is marked Done (by hand, or by accepting the agent's
suggestion after a dev says they are finished) and nothing else is open, the
dot turns yellow. **Status channel** on the roster entry says where the dot
goes: the dev's own forum channel, or a single post. The agent also reads
every post inside a dev's forum and treats it as being about that dev's
tasks. A dev with nothing set falls back to a post whose title starts with
their name in a forum the agent reads. The bot needs Manage Channels to
rename forums and Manage Threads to rename posts. Discord allows two renames per post every ten minutes.
`ASSET_STATUS_POSTS_DRY_RUN=true` logs what it would rename and changes
nothing.

**Blocked needs a reason.** Setting a task to Blocked asks what it is
waiting on, on the page, in `/assets task` (the `reason` option) and for
agent suggestions. The reason shows next to the task and is cleared when the
task leaves Blocked. Tasks blocked before this rule show "No reason given".

## Dev payout requests

A dev asks to be paid by posting in the **Payments** post of their own forum
(the forum set as their Status channel on the Team view), for example
"30k payout for Aizen's shiny model", or a link to the file with "payout for
this".

1. The bot reads the message. Chat ("thanks!") is ignored. If it is a request
   but does not say what for, the bot replies asking, and the dev's answer
   completes the same request.
2. A clear request is tied to the content item and the tracker tasks it
   covers, checked against earlier requests, logged, and forwarded to the
   admins' payouts channel as a card with **Paid out** and **Decline**.
3. **Paid out** puts a tick on the dev's message and replies mentioning them.
   **Decline** asks for a reason and tells the dev.

A request is only forwarded once we know which **Roblox account** to pay.
The first time a dev asks, the bot replies asking for their Roblox profile
link, username or user ID, holds the request, and forwards it when they
answer. The account is saved on their roster entry (Team, Edit) and shown on
every card, so they are not asked again. Giving a different account in a
later request replaces the saved one, and that change is in the audit log.

Nothing is paid twice by accident: a request that covers a task with an
earlier pending or paid request (or, with no task matched, the same dev and
item) is flagged in red on the card and on the Payouts page.

On the Assets page, **Payouts** lists every request with its tasks and the
link to the Discord message, and leads can mark them there too (the bot
updates Discord within a minute). Each task shows **Paid** or **Payout
requested** with a link to the request, and the Tasks filter (More) can show
paid, requested or not-paid tasks.

Settings are under Agent settings, Payout requests: the admin channel ID
(empty uses a text channel named `payouts`) and an optional manager role to
mention when a dev needs help. Approved assistant accounts and server
administrators can press the buttons. A post counts as a Payments post when
it is named Payments, Payment, Payouts or Payout.

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

### The assistant

Approved people can talk to the bot in Discord and get an answer. It is
separate from the suggestions above: it answers a short list of accounts
directly, and it never changes a task without a person approving the change.

- "Get me the most recent files for Starrk" lists the files posted for that
  item, newest first, each linking to the Discord message it was posted in.
- "Ruku updated Starrk's face model in his most recent image, this is
  current" saves a note against the item and the dev, attaches that image,
  and marks it as the current file for the item.
- "Where is Aizen at?", "Is Kuro free?" are answered from the tracker.
- "Set Ruku's Aizen mesh task to Done", "assign the Starrk rig to Axen",
  "mark task 214 blocked, waiting on concept art" post a confirmation card
  with Accept and Reject under the reply. The task changes only when someone
  presses Accept (approved accounts can, as can leads and managers). It has
  to be an instruction: a statement such as "Ruku finished the Aizen mesh"
  proposes nothing, though the assistant may ask whether to update the task.
- "Add Byakuya as a unit to update 4", "create a boss called Yhwach for 5.0"
  work the same way: a confirmation card, and on Accept the item is created
  in that update with the full task checklist for its content type. It asks
  if the type or the update is not clear.

**Setting it up.** Agent settings, Assistant card:

1. Add the Discord user ID of each person it should answer.
2. Add the channel or forum post where it should answer every message from
   them (for example an "Asset Management" post). That channel does not need
   to be on the read allowlist, and nothing said there feeds the suggestions.
3. Anywhere else the agent reads, those people can mention the bot or reply
   to it to get an answer.

**Where the files come from.** Every upload and every link to a file host
(Drive, Dropbox, Figma, Sketchfab and similar) posted in a channel the agent
reads is added to a file index, with who posted it, when, the message it
came with and the name of the post. A file is tied to a content item when
the file name, the message or the post name mentions it. The index is kept
for good, unlike raw messages. It starts from the day this shipped: older
uploads are not in it. Files and notes for an item also show in the item's
side panel under **Files and notes**.

Names are matched loosely ("stark" finds Starrk). Each answer costs a model
call (logged under Usage as `assistant`); it is not blocked by the daily
budget, since a person asked for it. `ASSET_AGENT_ASSISTANT_MODEL` overrides
the model. The wording lives in `src/assets/prompts/assistant.md`.

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
