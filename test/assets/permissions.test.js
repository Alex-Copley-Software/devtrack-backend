const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../../src/assets/permissions');

const devs = [
  { id: 'd-ani', name: 'Ani', userId: 'u-ani', discipline: 'Animation', disciplines: ['Animation'] },
  { id: 'd-bee', name: 'MrBee', userId: 'u-bee', discipline: 'Manager', disciplines: ['Manager'] },
  { id: 'd-lead', name: 'Lead', userId: 'u-lead', discipline: 'VFX', disciplines: ['VFX'] },
];
const updates = [{ id: 'up-4', leadDevId: 'd-lead' }, { id: 'up-5', leadDevId: null }];
const access = user => p.resolveAccess(user, { devs, updates });

const mine = { assigneeDevId: 'd-ani', updateId: 'up-5' };
const someoneElses = { assigneeDevId: 'd-bee', updateId: 'up-5' };

test('viewers are read only', () => {
  const a = access({ id: 'u-qa', role: 'qa' });
  assert.equal(a.level, 'viewer');
  assert.equal(p.canEditTask(a, mine, ['status']), false);
  assert.equal(p.canManageUpdate(a, 'up-4'), false);
  assert.equal(p.canEditTemplates(a), false);
  assert.equal(p.canResolveSuggestion(a, 'up-4'), false);
});

test('devs edit status, due date and notes on their own tasks only', () => {
  const a = access({ id: 'u-ani', role: 'qa' });
  assert.equal(a.level, 'dev');
  assert.equal(p.canEditTask(a, mine, ['status', 'notes', 'dueDate']), true);
  assert.equal(p.canEditTask(a, mine, ['assigneeDevId']), false, 'cannot reassign');
  assert.equal(p.canEditTask(a, someoneElses, ['status']), false);
  assert.equal(p.canEditRoster(a), false);
});

test('engineers and Manager-discipline devs manage everything except templates and agent settings', () => {
  for (const user of [{ id: 'u-eng', role: 'engineer' }, { id: 'u-bee', role: 'reviewer' }]) {
    const a = access(user);
    assert.equal(a.level, 'manager');
    assert.equal(p.canEditTask(a, someoneElses, ['assigneeDevId', 'status']), true);
    assert.equal(p.canManageUpdate(a, 'up-5'), true);
    assert.equal(p.canEditRoster(a), true);
    assert.equal(p.canResolveSuggestion(a, 'up-5'), true);
    assert.equal(p.canEditTemplates(a), false);
    assert.equal(p.canEditAgentSettings(a), false);
  }
});

test('an update lead manages that update only', () => {
  const a = access({ id: 'u-lead', role: 'qa' });
  assert.equal(a.level, 'dev');
  assert.equal(p.canManageUpdate(a, 'up-4'), true);
  assert.equal(p.canManageUpdate(a, 'up-5'), false);
  assert.equal(p.canEditTask(a, { assigneeDevId: 'd-ani', updateId: 'up-4' }, ['assigneeDevId']), true);
  assert.equal(p.canEditTask(a, { assigneeDevId: 'd-ani', updateId: 'up-5' }, ['status']), false);
  assert.equal(p.canResolveSuggestion(a, 'up-4'), true);
  assert.equal(p.canResolveSuggestion(a, null), false);
});

test('admins and owners can do everything', () => {
  for (const role of ['admin', 'owner']) {
    const a = access({ id: 'u-x', role });
    assert.equal(a.level, 'admin');
    assert.equal(p.canEditTemplates(a), true);
    assert.equal(p.canEditAgentSettings(a), true);
    assert.equal(p.canEditTask(a, someoneElses, ['assigneeDevId']), true);
  }
});
