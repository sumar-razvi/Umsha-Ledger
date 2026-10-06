// The Apps Script back end (apps-script/*.gs) run in Node against a fake
// Sheet: setup, auth, roles, the write pipeline, and scenarios T13-T15.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createGas, createSystem, COMPANY_EMAIL } = require('./helpers/gas.js');

const rs = (r) => Math.round(r * 100);

// A customer with an MTO order, ready for advances.
function withOrder(gas, users) {
  const c = gas.call(users.owner, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Ayesha', phone: '03001234567' });
  assert.ok(c.ok, JSON.stringify(c));
  const j = gas.call(users.studio, 'jobs.create', {
    type: 'MTO_ORDER', contactId: c.data.contact.id, title: 'Bridal lehenga', bookedDate: '2026-09-01', promisedDate: '2026-12-01',
    taxCodeId: 'ST-STD', lines: [{ description: 'Lehenga with dupatta', qty: 1, unitPricePaisa: rs(500000) }],
  });
  assert.ok(j.ok, JSON.stringify(j));
  return { customerId: c.data.contact.id, jobId: j.data.job.id };
}

describe('setup', () => {
  test('creates every tab with headers, seeds data, makes the company account Owner', () => {
    const gas = createGas();
    const r = gas.run('setupRun');
    assert.equal(r.created.length, 31);
    assert.equal(r.owner, COMPANY_EMAIL);
    assert.equal(gas.rows('Accounts').length, 72);
    assert.equal(gas.rows('Users')[0].role, 'OWNER');
    assert.deepEqual(gas.rows('Journal'), []);
    const hdr = gas.ss.getSheetByName('JournalLines').values()[0];
    assert.deepEqual(hdr.slice(0, 7), ['id', 'jeId', 'date', 'accountCode', 'brand', 'debitPaisa', 'creditPaisa']);
  });

  test('a second run is a no-op', () => {
    const gas = createGas();
    gas.run('setupRun');
    const before = Object.fromEntries(gas.ss.getSheets().map((s) => [s.name, s.getLastRow()]));
    const r = gas.run('setupRun');
    assert.equal(r.created.length, 0);
    assert.equal(r.seeded, 0);
    for (const s of gas.ss.getSheets()) {
      if (s.name === 'AuditLog' || s.name === 'Sequences') continue;
      assert.equal(s.getLastRow(), before[s.name], s.name);
    }
  });

  test('adds columns that are missing from an older sheet, at the end', () => {
    const gas = createGas();
    gas.run('setupRun');
    const sh = gas.ss.getSheetByName('Jobs');
    const header = sh.values()[0];
    const at = header.indexOf('budgetCostPaisa');
    sh.getRange(1, at + 1, 1, 1).clearContent();
    for (let c = at + 1; c < header.length; c++) sh.getRange(1, c + 1).setValue(''); // drop trailing columns too
    const r = gas.run('setupRun');
    assert.ok(r.columnsAdded[0].startsWith('Jobs: budgetCostPaisa'));
  });

  test('text columns stay text: account codes, dates and phone numbers survive', () => {
    const { gas, users } = createSystem();
    const { customerId } = withOrder(gas, users);
    const raw = gas.rows('Contacts').find((c) => c.id === customerId);
    assert.equal(raw.phone, '923001234567');
    const job = gas.rows('Jobs')[0];
    assert.equal(job.bookedDate, '2026-09-01');
    assert.equal(gas.rows('Accounts')[0].code, '1010');
    assert.strictEqual(gas.rows('JobLines')[0].unitPricePaisa, rs(500000));
  });
});

describe('auth', () => {
  test('missing, invalid, wrong-audience and expired tokens are refused', () => {
    const { gas } = createSystem();
    const cases = [
      undefined,
      'not-a-token',
      gas.signIn(COMPANY_EMAIL, { aud: 'someone-else' }),
      gas.signIn(COMPANY_EMAIL, { exp: 1000 }),
      gas.signIn(COMPANY_EMAIL, { email_verified: 'false' }),
      gas.signIn(COMPANY_EMAIL, { iss: 'evil.example' }),
    ];
    for (const idToken of cases) {
      const r = gas.post({ action: 'session.me', idToken, payload: {} });
      assert.equal(r.code, 'E_AUTH', String(idToken));
    }
  });

  test('a verified Google account that is not a user is refused', () => {
    const { gas } = createSystem();
    const r = gas.call('stranger@gmail.com', 'session.me', {});
    assert.equal(r.code, 'E_AUTH');
    assert.match(r.message, /does not have access/);
  });

  test('deactivated users are refused', () => {
    const { gas, users } = createSystem();
    const id = gas.rows('Users').find((u) => u.email === users.viewer).id;
    assert.ok(gas.call(users.owner, 'users.upsert', { id, isActive: false }).ok);
    assert.equal(gas.call(users.viewer, 'session.me', {}).code, 'E_AUTH');
  });

  test('session.me returns bootstrap data for the role', () => {
    const { gas, users } = createSystem();
    const r = gas.call(users.store, 'session.me', {});
    assert.equal(r.data.role, 'STORE');
    assert.equal(r.data.store, 'MIRAE-KHI-01');
    assert.equal(r.data.accounts.length, 72);
    assert.equal(r.data.settings.allocationKey, 'REVENUE');
  });

  test('the last active Owner cannot be removed', () => {
    const { gas, users } = createSystem();
    const ownerId = gas.rows('Users').find((u) => u.email === users.owner).id;
    assert.equal(gas.call(users.owner, 'users.upsert', { id: ownerId, role: 'FINANCE' }).code, 'E_VALIDATION');
  });
});

describe('T13 idempotency', () => {
  test('the same requestId twice posts once and returns the same jeId', () => {
    const { gas, users } = createSystem();
    const { jobId } = withOrder(gas, users);
    const payload = { jobId, date: '2026-10-01', amountPaisa: rs(300000), moneyAccountCode: '1100' };
    const a = gas.call(users.studio, 'payments.receiveAdvance', payload, 'retry-1234567');
    const b = gas.call(users.studio, 'payments.receiveAdvance', payload, 'retry-1234567');
    assert.ok(a.ok, JSON.stringify(a));
    assert.equal(b.data.jeId, a.data.jeId);
    assert.equal(b.meta.replayed, true);
    assert.equal(gas.rows('Journal').length, 1);
    assert.equal(gas.rows('JournalLines').length, 2);
    assert.equal(gas.rows('Payments').length, 1);
    assert.equal(gas.rows('AuditLog').filter((x) => x.action === 'payments.receiveAdvance').length, 1);
    const c = gas.call(users.studio, 'payments.receiveAdvance', payload, 'retry-7654321');
    assert.notEqual(c.data.jeId, a.data.jeId, 'a new requestId is a new payment');
  });

  test('a requestId reused for another action or by another user is refused', () => {
    const { gas, users } = createSystem();
    const { jobId } = withOrder(gas, users);
    gas.call(users.studio, 'payments.receiveAdvance', { jobId, date: '2026-10-01', amountPaisa: 100, moneyAccountCode: '1100' }, 'shared-req-1');
    assert.equal(gas.call(users.finance, 'payments.receiveAdvance', { jobId, date: '2026-10-01', amountPaisa: 100, moneyAccountCode: '1100' }, 'shared-req-1').code, 'E_VALIDATION');
  });

  test('writes without a requestId are refused', () => {
    const { gas, users } = createSystem();
    const r = gas.post({ action: 'contacts.upsert', idToken: gas.signIn(users.owner), payload: { kind: 'CUSTOMER', name: 'X' } });
    assert.equal(r.code, 'E_VALIDATION');
    assert.equal(r.field, 'requestId');
  });

  test('a failed request writes nothing and can be retried with the same requestId', () => {
    const { gas, users } = createSystem();
    const { jobId } = withOrder(gas, users);
    const counts = () => gas.ss.getSheets().map((s) => s.name + ':' + s.getLastRow()).join(',');
    const before = counts();
    const bad = gas.call(users.studio, 'payments.receiveAdvance', { jobId, date: '2026-10-01', amountPaisa: rs(1000), moneyAccountCode: '6100' }, 'retry-after-fix');
    assert.equal(bad.code, 'E_VALIDATION');
    assert.equal(counts(), before);
    const good = gas.call(users.studio, 'payments.receiveAdvance', { jobId, date: '2026-10-01', amountPaisa: rs(1000), moneyAccountCode: '1100' }, 'retry-after-fix');
    assert.ok(good.ok);
  });
});

describe('T14 locked period', () => {
  test('posting into a closed month fails; reopening with a reason allows it; both are audited', () => {
    const { gas, users } = createSystem();
    const { jobId } = withOrder(gas, users);
    assert.ok(gas.call(users.owner, 'periods.close', { periodId: '2026-09' }).ok);
    assert.equal(gas.call(users.owner, 'periods.close', { periodId: '2026-09' }).code, 'E_VALIDATION');
    const advance = { jobId, date: '2026-09-15', amountPaisa: rs(1000), moneyAccountCode: '1100' };
    assert.equal(gas.call(users.studio, 'payments.receiveAdvance', advance).code, 'E_PERIOD_LOCKED');
    assert.equal(gas.call(users.finance, 'journal.create', { date: '2026-09-15', memo: 'x', lines: [{ accountCode: '6300', brand: 'SHARED', debitPaisa: 1 }, { accountCode: '1100', brand: 'SHARED', creditPaisa: 1 }] }).code, 'E_PERIOD_LOCKED');
    assert.equal(gas.call(users.owner, 'periods.reopen', { periodId: '2026-09' }).code, 'E_VALIDATION');
    assert.equal(gas.call(users.finance, 'periods.reopen', { periodId: '2026-09', reason: 'x' }).code, 'E_ROLE');
    assert.ok(gas.call(users.owner, 'periods.reopen', { periodId: '2026-09', reason: 'Missed a deposit' }).ok);
    assert.ok(gas.call(users.studio, 'payments.receiveAdvance', advance).ok);
    const audit = gas.rows('AuditLog').filter((a) => a.docType === 'PERIOD').map((a) => a.summary);
    assert.deepEqual(audit, ['Closed 2026-09', 'Reopened 2026-09: Missed a deposit']);
    assert.equal(gas.rows('Periods')[0].reopenReason, 'Missed a deposit');
  });
});

describe('T15 role enforcement', () => {
  test('Store cannot post manual journals', () => {
    const { gas, users } = createSystem();
    const r = gas.call(users.store, 'journal.create', { date: '2026-10-01', memo: 'x', lines: [] });
    assert.equal(r.code, 'E_ROLE');
    assert.match(r.message, /Store/);
  });

  test('Studio cannot enter a bill with an expense line, but job-only bills pass the role check', () => {
    const { gas, users } = createSystem();
    const expense = gas.call(users.studio, 'bills.create', { contactId: 'VEN-00001', date: '2026-10-01', lines: [{ lineKind: 'EXPENSE', accountCode: '6100', netPaisa: 100 }] });
    assert.equal(expense.code, 'E_ROLE');
    const job = gas.call(users.studio, 'bills.create', { contactId: 'VEN-00001', date: '2026-10-01', lines: [{ lineKind: 'JOB', jobId: 'JOB-2026-00001', netPaisa: 100 }] });
    assert.notEqual(job.code, 'E_ROLE');
  });

  test('more of the matrix: viewers read, store adds customers only, periods are Owner-only', () => {
    const { gas, users } = createSystem();
    assert.equal(gas.call(users.viewer, 'contacts.upsert', { kind: 'CUSTOMER', name: 'X' }).code, 'E_ROLE');
    assert.equal(gas.call(users.store, 'contacts.upsert', { kind: 'VENDOR', name: 'X' }).code, 'E_ROLE');
    assert.ok(gas.call(users.store, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Walk-in', phone: '+92 321 7654321' }).ok);
    assert.equal(gas.call(users.finance, 'periods.close', { periodId: '2026-09' }).code, 'E_ROLE');
    assert.equal(gas.call(users.studio, 'ledger.account', { accountCode: '1100' }).code, 'E_ROLE');
    assert.ok(gas.call(users.viewer, 'ledger.account', { accountCode: '1100' }).ok);
    assert.equal(gas.call(users.owner, 'no.such.action', {}).code, 'E_VALIDATION');
  });
});

describe('write pipeline', () => {
  test('E_BUSY when another write holds the lock', () => {
    const { gas, users } = createSystem();
    gas.lock.held = true;
    assert.equal(gas.call(users.owner, 'contacts.upsert', { kind: 'CUSTOMER', name: 'X' }).code, 'E_BUSY');
    assert.ok(gas.call(users.owner, 'session.me', {}).ok, 'reads do not need the lock');
    gas.lock.held = false;
  });

  test('an advance writes one batch per tab and an audit row', () => {
    const { gas, users } = createSystem();
    const { jobId } = withOrder(gas, users);
    gas.ss.resetStats();
    const r = gas.call(users.studio, 'payments.receiveAdvance', { jobId, date: '2026-10-01', amountPaisa: rs(300000), moneyAccountCode: '1100' });
    assert.equal(r.data.jeId, 'JE-2026-00001');
    assert.equal(r.data.paymentId, 'PAY-2026-00001');
    for (const tab of ['Journal', 'JournalLines', 'Payments', 'PaymentAllocations', 'AuditLog', 'Requests']) {
      assert.equal(gas.ss.stats.setValuesByTab[tab], 1, tab);
    }
    const lines = gas.rows('JournalLines');
    assert.deepEqual(lines.map((l) => [l.id, l.accountCode, l.brand, l.debitPaisa, l.creditPaisa, l.jobId]), [
      ['JE-2026-00001-01', '1100', 'UMSHA', rs(300000), 0, jobId],
      ['JE-2026-00001-02', '2100', 'UMSHA', 0, rs(300000), jobId],
    ]);
    const audit = gas.rows('AuditLog').at(-1);
    assert.equal(audit.userEmail, users.studio);
    assert.equal(audit.docId, 'PAY-2026-00001');
    assert.match(audit.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:00$/);
  });

  test('journal.create and journal.reverse: linked, mirrored, original untouched except the link', () => {
    const { gas, users } = createSystem();
    const lines = [{ accountCode: '6300', brand: 'SHARED', debitPaisa: rs(25000) }, { accountCode: '2300', brand: 'SHARED', creditPaisa: rs(25000) }];
    const j = gas.call(users.finance, 'journal.create', { date: '2026-10-05', memo: 'Audit fee accrual', lines });
    assert.ok(j.ok, JSON.stringify(j));
    const rev = gas.call(users.finance, 'journal.reverse', { jeId: j.data.jeId, date: '2026-10-06', reason: 'Wrong month' });
    assert.ok(rev.ok, JSON.stringify(rev));
    const journal = gas.rows('Journal');
    assert.equal(journal[0].reversedByJeId, rev.data.jeId);
    assert.equal(journal[1].reversesJeId, j.data.jeId);
    assert.equal(journal[0].isManual, true);
    assert.equal(gas.call(users.finance, 'journal.reverse', { jeId: j.data.jeId, reason: 'again' }).code, 'E_VALIDATION');
    const ledger = gas.call(users.viewer, 'ledger.account', { accountCode: '2300' });
    assert.deepEqual(ledger.data.rows.map((r) => r.balancePaisa), [rs(25000), 0]);
    assert.equal(gas.call(users.finance, 'journal.get', { jeId: rev.data.jeId }).data.lines[0].accountName, 'Professional fees');
  });

  test('posted ledger rows cannot be changed, even by server code', () => {
    const { gas, users } = createSystem();
    const j = gas.call(users.finance, 'journal.create', { date: '2026-10-05', memo: 'x', lines: [{ accountCode: '6300', brand: 'SHARED', debitPaisa: 5 }, { accountCode: '2300', brand: 'SHARED', creditPaisa: 5 }] });
    const Db = gas.context.Db;
    Db.reset();
    const tx = Db.begin();
    tx.update('JournalLines', j.data.jeId + '-01', { debitPaisa: 6 });
    assert.throws(() => Db.commit(tx), /cannot be changed/);
    Db.reset();
    const tx2 = Db.begin();
    tx2.update('Journal', j.data.jeId, { memo: 'edited' });
    assert.throws(() => Db.commit(tx2), /cannot be changed/);
    assert.equal(gas.rows('JournalLines')[0].debitPaisa, 5);
  });

  test('unexpected server errors return E_INTERNAL without a stack trace', () => {
    const { gas, users } = createSystem();
    gas.context.Actions['session.me'] = () => { throw new TypeError('boom at line 12'); };
    const r = gas.call(users.owner, 'session.me', {});
    assert.equal(r.code, 'E_INTERNAL');
    assert.doesNotMatch(r.message, /boom|line 12/);
    assert.ok(gas.logs.some((l) => l.includes('boom')));
  });

  test('malformed requests', () => {
    const { gas } = createSystem();
    assert.equal(gas.post('{not json').code, 'E_VALIDATION');
    assert.equal(gas.post({}).code, 'E_VALIDATION');
  });

  test('settings.update validates values and audits before/after', () => {
    const { gas, users } = createSystem();
    assert.equal(gas.call(users.owner, 'settings.update', { key: 'allocationKey', value: 'MAGIC' }).code, 'E_VALIDATION');
    assert.equal(gas.call(users.owner, 'settings.update', { key: 'nope', value: '1' }).code, 'E_VALIDATION');
    assert.ok(gas.call(users.owner, 'settings.update', { key: 'allocationKey', value: 'FIXED' }).ok);
    assert.equal(gas.call(users.owner, 'session.me', {}).data.settings.allocationKey, 'FIXED');
    const a = gas.rows('AuditLog').at(-1);
    assert.equal(a.before, '"REVENUE"');
  });
});

describe('master data and jobs', () => {
  test('contacts: IDs by kind, phone normalised, duplicate phone warned, search by name or phone', () => {
    const { gas, users } = createSystem();
    const a = gas.call(users.owner, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Ayesha Khan', phone: '0300-1234567' });
    const v = gas.call(users.owner, 'contacts.upsert', { kind: 'VENDOR', name: 'Karigar Aslam', vendorType: 'KARIGAR', filerStatus: 'NON_FILER' });
    const f = gas.call(users.owner, 'contacts.upsert', { kind: 'FAMILY', name: 'Family' });
    assert.deepEqual([a.data.contact.id, v.data.contact.id, f.data.contact.id], ['CUS-00001', 'VEN-00001', 'FAM-001']);
    const dup = gas.call(users.owner, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Ayesha K', phone: '+923001234567' });
    assert.match(dup.data.warnings[0], /already used by Ayesha Khan/);
    assert.equal(gas.call(users.store, 'contacts.search', { q: 'ayesha' }).data.length, 2);
    assert.equal(gas.call(users.store, 'contacts.search', { q: '0300 123' }).data.length, 2);
    assert.equal(gas.call(users.owner, 'contacts.search', { kind: 'VENDOR' }).data.length, 1);
    const upd = gas.call(users.owner, 'contacts.upsert', { id: 'CUS-00001', city: 'Karachi' });
    assert.equal(upd.data.contact.city, 'Karachi');
    assert.equal(gas.rows('Contacts')[0].city, 'Karachi');
    assert.equal(gas.call(users.owner, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Bad', phone: '12345' }).code, 'E_VALIDATION');
  });

  test('items: IDs by category, chosen SKU IDs, duplicate barcodes refused', () => {
    const { gas, users } = createSystem();
    const fab = gas.call(users.studio, 'items.upsert', { category: 'FABRIC', name: 'Silk organza' });
    assert.equal(fab.data.item.id, 'FAB-0001');
    assert.equal(fab.data.item.unit, 'M');
    const sku = gas.call(users.owner, 'items.upsert', { id: 'sku-ayla-m-red', category: 'SKU', name: 'Ayla kurta M red', barcode: '8961234567890', salePricePaisa: rs(9440), taxCodeId: 'ST-STD' });
    assert.equal(sku.data.item.id, 'SKU-AYLA-M-RED');
    assert.equal(gas.call(users.owner, 'items.upsert', { category: 'SKU', name: 'Other', barcode: '8961234567890' }).code, 'E_VALIDATION');
    assert.equal(gas.call(users.store, 'items.search', { q: '8961234567890' }).data[0].id, 'SKU-AYLA-M-RED');
    assert.equal(gas.call(users.store, 'items.upsert', { category: 'SKU', name: 'x' }).code, 'E_ROLE');
    assert.equal(gas.rows('Items').find((i) => i.id === 'SKU-AYLA-M-RED').barcode, '8961234567890');
  });

  test('jobs: create, get with advance held and cost sheet, list', () => {
    const { gas, users } = createSystem();
    const { jobId } = withOrder(gas, users);
    assert.equal(jobId, 'JOB-2026-00001');
    gas.call(users.store, 'payments.receiveAdvance', { jobId, date: '2026-10-01', amountPaisa: rs(300000), moneyAccountCode: '1100' });
    const g = gas.call(users.studio, 'jobs.get', { id: jobId });
    assert.equal(g.data.job.quotedPricePaisa, rs(500000));
    assert.equal(g.data.job.brand, 'UMSHA');
    assert.equal(g.data.advanceHeldPaisa, rs(300000));
    assert.equal(g.data.advances.length, 1);
    assert.equal(g.data.lines.length, 1);
    const list = gas.call(users.viewer, 'jobs.list', { type: 'MTO_ORDER' });
    assert.equal(list.data[0].advanceHeldPaisa, rs(300000));
    const bad = gas.call(users.studio, 'jobs.create', { type: 'MTO_ORDER', title: 'No customer', lines: [{ description: 'x', unitPricePaisa: 1 }] });
    assert.equal(bad.code, 'E_VALIDATION');
  });
});

describe('nightly job and triggers', () => {
  test('backup copies the sheet and keeps 30; old requests are pruned; drift is logged', () => {
    const { gas, users } = createSystem({ now: '2026-10-06T21:00:00Z' });
    gas.call(users.owner, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Old request' });
    gas.setNow('2026-11-20T21:00:00Z');
    gas.call(users.owner, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Recent request' });
    for (let i = 0; i < 31; i++) gas.run('nightly');
    const backups = gas.drive.files.filter((f) => f.name.startsWith('UMSHA Ledger backup ') && !f.trashed);
    assert.equal(backups.length, 30);
    assert.ok(gas.rows('Requests').every((r) => r.ts >= '2026-10-22'), 'requests older than 30 days are gone');
    assert.ok(gas.rows('Requests').length >= 1);
    // Tamper with the ItemBalances cache: the nightly check logs it.
    gas.context.Db.reset();
    const tx = gas.context.Db.begin();
    tx.upsert('ItemBalances', { itemId: 'FAB-0001', qty: 5, avgCostMicro: 1, valuePaisa: 5 });
    gas.context.Db.commit(tx);
    const r = gas.run('nightly');
    assert.equal(r.drift, 1);
    assert.ok(gas.rows('AuditLog').some((a) => a.action === 'nightly.drift' && a.docId === 'FAB-0001'));
  });

  test('installTriggers schedules one nightly run at 02:00 Karachi, idempotently', () => {
    const gas = createGas();
    gas.run('installTriggers');
    gas.run('installTriggers');
    assert.equal(gas.triggers.length, 1);
    assert.deepEqual([gas.triggers[0].fn, gas.triggers[0].hour, gas.triggers[0].tz], ['nightly', 2, 'Asia/Karachi']);
  });

  test('doGet is a health check', () => {
    const gas = createGas();
    assert.deepEqual(JSON.parse(gas.context.doGet().getContent()), { ok: true, data: { service: 'umsha-ledger', status: 'ok' } });
  });
});
