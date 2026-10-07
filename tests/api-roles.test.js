// Milestone M9 review: every API action is checked on the server for the
// caller's role, before anything is read or written.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSystem } = require('./helpers/gas.js');
const Permissions = require('../core/permissions.js');

describe('server-side role checks for every action', () => {
  const { gas, users } = createSystem({ now: '2026-10-20T10:00:00Z' });
  const byRole = { OWNER: users.owner, FINANCE: users.finance, STUDIO: users.studio, STORE: users.store, VIEWER: users.viewer };
  const actions = Object.keys(Permissions.MATRIX);

  test('the permission matrix and the handlers match one to one', () => {
    const handlers = Object.keys(gas.context.Actions).sort();
    assert.deepEqual(actions.slice().sort(), handlers);
  });

  test('every action refuses every role it does not list, with E_ROLE and nothing saved', () => {
    const before = gas.rows('AuditLog').length;
    let checked = 0;
    for (const action of actions) {
      const allowed = Permissions.MATRIX[action][0].split('').map((l) => Permissions.ROLE_LETTER[l]);
      for (const role of Permissions.ROLES) {
        if (allowed.includes(role)) continue;
        // dashboard.get is checked per tab; use a tab no role outside the matrix may see.
        const payload = action === 'dashboard.get' ? { tab: 'OVERVIEW' } : {};
        const r = gas.call(byRole[role], action, payload);
        assert.equal(r.code, 'E_ROLE', action + ' as ' + role + ': ' + JSON.stringify(r));
        checked++;
      }
    }
    assert.ok(checked > 150, 'checked ' + checked + ' action/role pairs');
    assert.equal(gas.rows('AuditLog').length, before, 'refused calls write nothing');
  });

  test('a deactivated user is refused everything', () => {
    const list = gas.call(users.owner, 'users.list', {}).data;
    const u = list.find((x) => x.email === users.viewer);
    assert.ok(gas.call(users.owner, 'users.upsert', Object.assign({}, u, { isActive: false })).ok);
    const r = gas.call(users.viewer, 'reports.trialBalance', { asOf: '2026-10-20' });
    assert.equal(r.ok, false);
    assert.match(r.code, /E_AUTH|E_ROLE/);
  });

  test('unknown actions and unsigned requests are refused', () => {
    assert.equal(gas.call(users.owner, 'nope.nothing', {}).code, 'E_VALIDATION');
    assert.equal(gas.post({ action: 'reports.trialBalance', payload: {} }).code, 'E_AUTH');
  });
});
