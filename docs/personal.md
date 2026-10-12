# The owner's private assistant

One Discord account, set as `PERSONAL_OWNER_DISCORD_ID` on the backend and
the bot, can use the bot privately. Nobody else can: the bot checks the
account, and the backend checks it again on every call.

## Where it works

- **A DM with the bot.** Just type; no `--` prefix.
- **`/ask`, `/note`, `/remind` anywhere**: any server, somebody else's DM, a
  group chat. This needs the app installed to the account (Developer Portal,
  Installation, User Install, then the install link). Replies are visible
  only to the owner unless `/ask` is given `share: true`.

In somebody else's DM or a server the bot is not in, the bot sees only what
is typed into the command, not the conversation, and it cannot post there
later by itself.

## What it does

Everything the assistant does in Asset Management (files, update and task
status, payment history, task changes and expense logging on a confirmation
card), plus, in private only:

- **Private notes.** "note that Ruku wants 40k for the next rig", or
  `/note`. Kept in their own table (`PersonalNote`), never shown on the
  Assets page, never returned outside a DM or an only-you reply. "What did I
  note about Ruku" searches them; "delete note 12" removes one.
- **Reminders.** "remind me Friday at 3 to pay the testers", "every Monday
  9am check payouts", or `/remind`. Delivered as a DM from the bot within a
  minute of the time. Times are US Eastern (`PERSONAL_TIMEZONE`, default
  `America/New_York`), daylight saving included. Repeats: daily, weekdays,
  weekly, monthly. "What reminders do I have", "cancel the testers one".

Cards (task changes, new items, logging expenses) work in private too. Only
the owner or an approved assistant admin can accept one, so a card shared in
somebody else's DM cannot be accepted by them.

What the owner attaches or says in private is not added to the team's file
index.

## Settings

| Service | Variable | |
|---|---|---|
| Backend and bot | `PERSONAL_OWNER_DISCORD_ID` | The one account. Unset: all of this is off. |
| Backend | `PERSONAL_TIMEZONE` | Default `America/New_York`. |

Needs `ASSET_AGENT_ENABLED=true` (it is the same assistant). To receive DMs
the bot uses the Direct Messages intent, which needs no approval from Discord.
