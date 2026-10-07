#!/usr/bin/env node
// Runs the agent's two Claude calls on a sample conversation and prints what
// came back, what passed validation and what it cost. Touches no database
// and changes nothing: use it to check the API key and models work, and to
// see the effect of editing src/assets/prompts/*.md.
//
//   node scripts/assets-agent-smoke.js
//   node scripts/assets-agent-smoke.js path/to/conversation.txt   (one "Name: message" per line)
//
// Needs ANTHROPIC_API_KEY. Costs about a cent per run.

require('dotenv').config();
const fs = require('fs');
const model = require('../src/assets/agent/model');
const context = require('../src/assets/agent/context');
const { validateActions } = require('../src/assets/agent/validate');
const { costOf } = require('../src/assets/agent/settings');

const dev = (name, disciplines, n) => ({ id: `dev-${name}`, name, disciplines, status: 'Active', discordUserId: `90000000000000000${n}` });
const devs = [dev('MrBee', ['Manager', 'Design'], 0), dev('Vex', ['VFX', 'VFX Scripting'], 1), dev('Ani', ['Animation'], 2), dev('Ricky', ['Engineers'], 3), dev('Mesh', ['Unit Mesh'], 4)];
const update = { id: 'up-4', number: 4, name: 'Bleach', status: 'In Development', leadName: 'MrBee', targetRelease: null };
const item = (id, n, internalName, displayName, done) => ({ id, itemNumber: n, updateId: 'up-4', internalName, displayName, contentType: 'Unit', ownerName: 'MrBee', done, countable: 4 });
const task = (ref, itemId, internalName, discipline, deliverable, status, assigneeName) => ({
  id: `task-${ref}`, ref, contentItemId: itemId, updateId: 'up-4', internalName, discipline, deliverable, status,
  assigneeName, assigneeDevId: assigneeName ? `dev-${assigneeName}` : null, dueDate: null, notes: null,
});
const snapshot = {
  updates: [update], activeUpdates: [update], openUpdates: [update],
  items: [item('it-1', 1, 'Aizen', 'Mythic', 1), item('it-2', 2, 'Ulquiorra', 'Secret', 0)],
  tasks: [
    task(101, 'it-1', 'Aizen', 'Animation', 'Idle, walk and attack animations', 'Done', 'Ani'),
    task(102, 'it-1', 'Aizen', 'VFX', 'Ability VFX', 'In Progress', 'Vex'),
    task(103, 'it-1', 'Aizen', 'Engineers', 'Ability scripting', 'Review', 'Ricky'),
    task(104, 'it-1', 'Aizen', 'Unit Mesh', 'Unit mesh', 'Not Started', null),
    task(201, 'it-2', 'Ulquiorra', 'Animation', 'Idle, walk and attack animations', 'Not Started', null),
    task(202, 'it-2', 'Ulquiorra', 'VFX', 'Ability VFX', 'Not Started', null),
    task(203, 'it-2', 'Ulquiorra', 'Unit Mesh', 'Unit mesh', 'In Progress', 'Mesh'),
  ],
  devs,
  contentTypes: ['Unit', 'Map / Stage', 'Boss', 'Skin'].map((name, i) => ({ id: `ct-${i}`, name, active: true })),
};

const SAMPLE = [
  'Vex: aizen vfx is done, sending it for review',
  'MrBee: nice. ricky is the aizen scripting good to go?',
  'Ricky: yep tested in the place, all good',
  'MrBee: approved, mark that one done',
  "Ani: i'll take the ulquiorra anims, should be done by friday",
  'Mesh: ulquiorra mesh is blocked, need the final concept art first',
  'MrBee: also thinking we add grimmjow as a unit this update',
  'Vex: lol did anyone watch the new episode',
];

async function main() {
  const lines = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8').split('\n').filter(l => l.trim()) : SAMPLE;
  const messages = lines.map((line, i) => {
    const [name, ...rest] = line.split(':');
    const author = devs.find(d => d.name.toLowerCase() === name.trim().toLowerCase());
    return {
      id: String(700000000000000000n + BigInt(i)), channelId: '1', guildId: '1',
      authorDiscordId: author?.discordUserId || '0', authorName: name.trim(), content: rest.join(':').trim(), attachments: [],
      postedAt: new Date(Date.now() - (lines.length - i) * 60000).toISOString(),
    };
  });
  const { text, labels } = context.renderBatch(messages, snapshot);
  console.log(`Conversation:\n${text}\n`);

  const screened = await model.filter(text);
  let cost = costOf(screened.model, screened.usage);
  console.log(`Filter (${screened.model}): ${screened.relevant ? 'RELEVANT' : 'SKIP'}  usage ${JSON.stringify(screened.usage)}`);
  if (!screened.relevant) { console.log(`\nTotal cost: $${cost.toFixed(4)}`); return; }

  const extracted = await model.extract({ trackerState: context.renderTrackerState(snapshot), batchText: text, today: new Date().toISOString().slice(0, 10) });
  cost += costOf(extracted.model, extracted.usage);
  console.log(`Extract (${extracted.model}): ${extracted.actions.length} action(s)${extracted.noToolCall ? ' (no tool call came back)' : ''}  usage ${JSON.stringify(extracted.usage)}\n`);

  const { accepted, dropped } = validateActions(extracted.actions, { snapshot, labels });
  for (const a of accepted) console.log(`  OK   ${String(Math.round(a.confidence * 100)).padStart(3)}%  ${a.type.padEnd(20)} ${a.summary}\n            why: ${a.reason}  [${a.evidence.join(', ')}]`);
  for (const d of dropped) console.log(`  DROP       ${String(d.action?.type).padEnd(20)} ${d.why}`);
  console.log(`\nTotal cost: $${cost.toFixed(4)}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(`Smoke test failed: ${err.status ? `${err.status} ` : ''}${err.message}`);
  process.exit(1);
});
