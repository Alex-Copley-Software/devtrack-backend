# Bug reports from the forums

Bug reports are posts in the bug report forums (the `bug` entries in the
bot's `CHANNEL_CONFIG`). Each new post becomes one DevTrack report: the post
title is the title, the opening message is the description and its files are
attached. Replies from anyone in the post are added to the report's
conversation. Status messages, `/credit`, `/requestcredit`, `/syncreport`,
report pause, tester QA and tester payouts all work in the post.

While reports are paused a new post is not logged; the poster is told, and
pinged when reports resume.

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
