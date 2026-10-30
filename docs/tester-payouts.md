# Tester QA and tester payouts

Two linked additions to the bug-report side of DevTrack. Code:
`src/tester-pay.js` (data and rules), `src/tester-qa.js` (hooks into report
status changes), `src/routes/payouts.js`, `devtrack-bot/src/qa-check.js`, and
the dashboard page at `/payouts/`.

## Tester QA

When a bug or crash report moves to **QA Review**, the bot pings the tester
who filed it, in that report's own Discord thread, with **Fixed** and **Not
fixed** buttons.

- **Fixed.** The tester posts a video in the thread, then presses Fixed. The
  report shows under **Tester Approved** in the bug nav, with a link to the
  video, for staff to resolve. With the rule *A tester's Fixed resolves the
  report* switched on, it is resolved and published straight away instead.
- **Not fixed.** The tester says what still happens. The report goes back to
  In Progress with their note in its history.
- **Staff resolve it first.** The buttons are retired and the tester is told
  staff approved the fix. It is logged as approved by staff, and not paid.
- **The report leaves QA Review another way** (on hold, back to in progress,
  declined). The request is withdrawn.

Only the tester who filed the report can answer, and only once per request,
until the request has waited 30 minutes (or whatever `/qadelay` is set to). Then it opens up in QA Requests
(below), and from then on the reporter can only answer by taking it there like anyone else. A report that comes back to QA Review after a "Not fixed" gets a new request.

**Whoever said Not fixed checks the next fix.** When a report comes back to
QA Review, the new request goes to the last person who answered Not fixed
(whether they were the reporter or took it in QA Requests), not the
reporter. They are pinged in the report's post and have it to themselves for
the same wait; if they have not answered by then it opens up in QA Requests
as usual. A request withdrawn without an answer does not change who is
asked. Once a fix is confirmed (or staff approve it), a later request goes
back to the reporter.
Reports with no Discord thread or reporter (imports, manual entries) and
suggestions are skipped. Every request and answer is kept in the **Tester QA
log** on the payouts page.

### QA Requests

A request still unanswered 30 minutes after it was posted is posted in the
**QA Requests** channel, found by name (`qa-requests`) or by
`QA_REQUESTS_CHANNEL_ID` on the bot. The check message in the report's post
says it has opened up.

The wait is changed in Discord by a server admin with `/qadelay minutes:<n>`
(0 to 1440; 0 stops sending checks to QA Requests). `/qadelay` on its own
shows the current wait. It is saved with the other tester QA rules, applies
straight away to checks already waiting, and needs no restart.

- **Take this check** makes it that person's for 30 minutes. They are sent a
  link to the check message, and the QA Requests post and the report's post
  both say who has it and until when.
- While they hold it nobody else can take it or answer it, the reporter
  included. Pressing Take again does not stretch their time.
- When the 30 minutes are up they can no longer answer. Anyone can take it
  then: someone new, the reporter, or the same person again if nobody else
  got there first.
- **One QA Request at a time.** Nobody can take a second while they hold
  one; they are told which one they have. Once they answer it (or their 30
  minutes run out) they can take another. Checks on their own reports, before
  those open up in QA Requests, do not count: a tester can have any number of
  those waiting.
- On October 26, 2026, when the one-at-a-time rule came in, every claim was
  handed back once so everyone takes them again under it. Anyone who was in
  the middle of a check was pinged in its post to take it again.
- **Moderators can change who has it.** In the report's post, someone with
  Manage Threads runs `/qaswitch to user:@someone` to hand the check to that
  person. It is theirs for 30 minutes from then, as if they had taken it,
  and whoever had it before can no longer answer. The one-at-a-time rule
  still applies to the new person. A check still waiting on the reporter is
  opened up by this and posted in QA Requests already taken. `/qaswitch free`
  takes it off whoever has it so anyone can take it again (one handed out
  before it reached QA Requests goes back to the reporter until it does).
  Both are logged in the report's history and announced in its post.
- They answer in the report's post exactly as the reporter would: their own
  video or photo posted there, then Fixed or Not fixed. Somebody else's
  upload never counts as their proof.
- When the check ends (answered, approved by staff, withdrawn) the QA
  Requests post is deleted, so the channel only shows checks still waiting.
  The outcome is recorded in the report's post.
- The report's history shows it opening up and who took it.

Reports from the old Ticket Tool tickets are never opened up: a ticket is
private, so nobody else could post proof in it.

## Payouts

`/payouts/`, for admins and owners.

- **Pay periods** are named date ranges of any length; both days are
  included, and periods may overlap. Any dates can also be looked at without
  saving a period.
- **Prices** are set per bug level (insignificant, minor, moderate, major)
  and per confirmed fix. A QA approval is paid the fix price.
- A period's table shows, per tester, accepted reports by level, fixes
  confirmed, and the amount owed. Click a tester for the reports behind the
  number. **Export CSV** downloads the table.
- **Robux.** Every amount is also shown in Robux, at the rate under Prices
  and rules (*Robux per $1*). Left blank it is the DevEx rate the Revenue
  page uses (US$0.0038 per Robux, about 263 Robux per $1), or 1 when the
  currency is already R$. Each person's Robux is rounded on its own, so the
  total is what paying them all comes to. The CSV has a Robux column too.
- **Mark as paid** freezes the period's numbers at that moment, so later
  price changes or re-levelled reports do not alter what was paid. **Reopen**
  discards the frozen copy and recalculates.
- **Logged on the Revenue page.** With Revenue switched on, the Mark as paid
  dialog lists everyone owed something with their Robux. Each person left
  ticked becomes an expense in Robux, dated that day, to them as a payee
  (found by Roblox user ID, then name; made if new). A Roblox user ID typed
  in the dialog is saved on the payee. Pick the expense category and tick
  **who pays for it** (the people who split the cost); nobody ticked is the
  default split, as for asset payouts. The period then says what was logged.
  Reopening it takes those expenses back out. Marking paid still works if
  logging fails; the period says so, and it can be logged by hand.

What counts:

- Bugs and crashes only, once accepted. A report counts on the day it was
  **accepted** (UTC), not the day it was filed. One declined afterwards stops
  counting.
- A report accepted without a bug level counts for nothing until a level is
  set; it is flagged in the table.
- A report with a team (`/team`, below) is split evenly between the reporter
  and the teammates, to the cent (any odd cent goes to the reporter first).
  The payouts table marks those as *shared*.
- A credited co-finder (`/credit`) is paid in full as well as the reporter,
  unless *Pay credited co-finders* is switched off, or they are on the team
  and already have a share.
- A confirmed fix is paid once per report, to whoever confirmed it (the
  reporter, or the person who took it in QA Requests), in the period they
  confirmed it. The report itself is still paid to the reporter.
- **QA staff** (dashboard accounts with the QA or Reviewer role) are paid
  the confirmed-fix price once per report, the first time one of them
  resolves it on the dashboard (Verified on QA Review, or Resolve on a
  tester-confirmed report). This is read from the report history, so
  approvals from before this was added count too. A report declined
  afterwards stops counting. Engineers, admins and owners are not paid for
  resolving. QA staff have their own table under the testers, and the total
  owed includes them.

## Teams: splitting a report's pay

A multiplayer bug often takes several testers to find. In the report's
forum post the reporter runs `/team add user:@someone` (up to 5 people);
`/team remove` takes someone off and `/team list` shows the team. Server
moderators (Manage Threads) can change any report's team. The report's pay
is then split between the reporter and the team instead of each being paid
for it. Each teammate also counts the report on the dashboard leaderboard.

## /leaderboard

Any tester can run `/leaderboard` in Discord to see their own numbers; only
they see the reply. The numbers are for the pay period on the Pay periods
tab that covers today: reports filed in it (queued, being worked on,
resolved, declined), reports accepted in it by level, shared and credited
ones, fixes they confirmed, what that earns at today's prices (or what was
paid, once the period is marked paid) and their rank among the testers in
it by accepted reports. Below that is what they have been paid in total over
every paid period.

When no period covers today, the numbers run from the day after the last
paid period ended; with no periods at all, they are all time. So adding the
next period on the Pay periods tab is what moves `/leaderboard` on to it.

## Rules (Prices and rules tab)

| Rule | Default |
|------|---------|
| Ask testers to confirm fixes | on |
| Fixed and Not fixed need a video or photo (an upload or a link posted in the thread or ticket since the request) | on |
| A tester's Fixed resolves the report | off |
| Pay credited co-finders | on |

## Trying it locally

`node scripts/assets-dev-server.js` also serves `/payouts/` against an
in-memory database with sample reports. `npm test` covers the payout maths,
the period rules and the tester QA flow (`test/tester-pay.test.js`).
