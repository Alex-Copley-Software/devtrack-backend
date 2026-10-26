# Bug reports from the forums

Bug reports are posts in the bug report forums (the `bug` entries in the
bot's `CHANNEL_CONFIG`). Each new post becomes one DevTrack report: the post
title is the title, the opening message is the description and its files are
attached. Replies from anyone in the post are added to the report's
conversation. Status messages, `/credit`, `/requestcredit`, `/syncreport`,
report pause, tester QA and tester payouts all work in the post.

While reports are paused a new post is not logged; the poster is told, and
pinged when reports resume.

## Keeping posts in sync

The bot keeps reports in step with their posts without anyone running
`/syncreport`:

- **Every 10 minutes** (`FORUM_SYNC_MINUTES`, 0 turns it off) and at startup
  it looks at every open post in the watched forums and the newest 100
  archived ones. A post with no report (made while the bot was down, or one
  that failed to log) gets one, with its replies. Posts older than 14 days
  (`FORUM_SYNC_DAYS`), posts made while reports were paused, and posts whose
  report was deleted on the dashboard are left alone. Replies the bot missed
  while it was down are logged in order; each message is stored with its
  Discord id, so nothing is logged twice. A post renamed in Discord renames
  its report.
- **Editing the opening message** updates the report's description; the old
  text is kept in the history.
- **Status messages and QA checks** the backend could not hand to the bot
  (it restarts on every deploy) wait in an outbox and are sent again, in
  order, every 30 seconds for up to a day.
- Files posted in replies are copied to R2, since Discord links expire after
  about a day.

`/syncreport` is still there for an odd case: it creates a missing report
straight away, or, in a tracked post, logs any replies the report is
missing.

## Deleting a post

A forum post can be deleted once you are done with it. The report, its
conversation, its files and its history stay in DevTrack, and its history
says the post was deleted. Payouts are unaffected. What is lost is the
Discord side: status messages for it have nowhere to go, a QA check waiting
in the post is withdrawn (and taken off QA Requests), and if the report
later goes back to QA Review the tester cannot be asked, so staff resolve it
on the dashboard. Proof links from Fixed / Not fixed answers point at the
Discord message and stop working, though the video or photo itself is still
in the report's conversation (copied to R2 when it was posted). Dashboard QA
proof is in R2 and stays.
Delete posts after the report is resolved, not while it is still in QA.

## Tester QA in a shared post

Anyone can chat in a forum post, so the QA check belongs to the person who
made the post. When the report reaches QA Review they are pinged with Fixed
/ Not fixed buttons, and:

- Only they can press the buttons. Anyone else is told so privately; the
  backend refuses them as well.
- The video or photo counted as proof is the newest one *they* posted in
  the post since being asked. Somebody else's upload is never taken as it.
- If they have not answered after 30 minutes (`/qadelay` changes this), the
  check opens up in **QA Requests**, where one person at a time can take it and answer it in the
  post with their own proof. See `tester-payouts.md`.

Tester payouts work as before: the report goes to the person who posted it,
or to whoever it was credited to with `/credit`. A confirmed fix goes to
whoever did the check.

## Verifying a fix on the dashboard

For QA and Reviewer accounts, pressing **Verified** (or **Resolve** on a
tester-confirmed report) needs proof: notes, photos or videos, at least one
of them. Engineers, admins and owners may leave it empty. QA and reviewers
cannot set a report to Resolved any other way; the report window sends them
to Verified. Up to 5 files, 50 MB each. The files go to R2, and the resolve message in the report's forum
post (or ticket) shows the notes, the proof and **Verified by** with the
staff member's name. Files under about 9 MB in total are attached to the
message; anything larger is linked, and Discord shows the link as a preview.
The report's history keeps the notes and the proof links.

## Dev tags and the bug queue

Testers can put a dev-name tag (Ricky, Bryan, Vaayu, Yose) on their forum
post. The bot reads it by name on every forum (each forum has its own tag
ids), sends it with the new report, updates it whenever the post's tags
change, and re-reads every post in the watched forums when it starts.
`DEV_TAG_NAMES` on the bot (comma separated) changes the list of names.

Changing a queued report's status (to Open, In Progress and so on) in the
report window accepts it, the same as Accept: it leaves the queue, counts as
accepted for payouts, and its post is tagged and told. A bug or crash needs
a bug level for that, already set or chosen in the same change; without one
the change is refused. Only QA, engineers and admins can do it.

On the **Bug Queue** page the tags show on each report, and you can:

- filter by a dev tag (or *No dev tag*) and sort by dev tag,
- tick reports, or **Select all**, which only picks what the filter shows,
- **Accept selected** with one bug level, assignee, category and notes
  (the assignee is suggested when every selected report has the same dev
  tag and a dev's name starts with it), or **Decline selected**.

## Reports from the old Ticket Tool tickets

Bug reports were Ticket Tool tickets (channels like `test-game-0001` under
**Test Game Reports** / **Live Game Reports**) from October 9 to October 17,
2026. New tickets are not logged any more (`/syncreport` in one says so),
but a ticket that already has a report stays linked to it until it is
closed:

- What anyone says in the ticket is added to the report's conversation.
- Status changes (accepted, fixed, in QA, resolved...) are posted in the
  ticket, and its QA check is posted there for the opener to answer. A
  ticket's check is never opened up in QA Requests, since nobody else can
  see the ticket.
- `/credit`, `/requestcredit` and `/syncreport` work in it.
- Five minutes after the report is resolved or declined, the bot sends
  `$delete` and the transcript is linked on the report, as before. If
  Ticket Tool does not delete it, the bot saves its own transcript and
  deletes the channel. `TICKETS_ENABLED=false` on the bot stops all of this.

Once the last ticket is closed, `devtrack-bot/src/tickets.js` can be
deleted.
