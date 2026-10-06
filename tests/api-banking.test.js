// Milestone M8 through the API: statement import with a saved mapping,
// matching, finishing a reconciliation, QuickBooks export (T19), table export.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSystem } = require('./helpers/gas.js');

const rs = (r) => Math.round(r * 100);

describe('banking and export through the API (M8)', () => {
  const { gas, users } = createSystem();
  const ok = (r) => { assert.ok(r.ok, JSON.stringify(r)); return r.data; };
  const f = users.finance;
  const cust = ok(gas.call(users.owner, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Ayesha' })).contact;
  const job = ok(gas.call(users.studio, 'jobs.create', { type: 'MTO_ORDER', contactId: cust.id, title: 'Bridal', lines: [{ description: 'Lehenga', unitPricePaisa: rs(500000) }] })).job;
  ok(gas.call(f, 'payments.receiveAdvance', { jobId: job.id, date: '2026-10-01', amountPaisa: rs(300000), moneyAccountCode: '1100' }));
  ok(gas.call(f, 'transfers.create', { date: '2026-10-05', fromCode: '1100', toCode: '1030', amountPaisa: rs(20000) }));
  ok(gas.call(f, 'transfers.create', { date: '2026-10-28', fromCode: '1100', toCode: '1030', amountPaisa: rs(5000) })); // not on the statement yet
  const mapping = { dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Narration', amountColumn: 'Amount' };
  const csv = 'Date,Narration,Amount\n02/10/2026,IBFT Ayesha,"300,000"\n05/10/2026,Cash withdrawal,-20000\n31/10/2026,Bank charges,-150\n';
  let recId;

  test('import, suggestions, and the mapping is remembered', () => {
    const imp = ok(gas.call(f, 'bankrec.import', { accountCode: '1100', csvText: csv, statementDate: '2026-10-31', statementBalancePaisa: rs(279850), mapping }));
    recId = imp.recId;
    assert.equal(imp.lines, 3);
    assert.equal(JSON.parse(ok(gas.call(users.owner, 'session.me', {})).settings['bankMapping:1100']).amountColumn, 'Amount');
    const g = ok(gas.call(f, 'bankrec.get', { recId }));
    assert.equal(g.suggestions.length, 2);
    // nothing matched yet: every statement line is open and the ledger balance is all uncleared
    assert.deepEqual([g.summary.balanced, g.summary.unmatchedStatement.length, g.summary.ledgerBalancePaisa, g.summary.unclearedPaisa], [false, 3, rs(275000), rs(275000)]);
    // next month: no mapping needed
    const again = ok(gas.call(f, 'bankrec.import', { accountCode: '1100', csvText: 'Date,Narration,Amount\n01/11/2026,x,1\n', statementDate: '2026-11-30', statementBalancePaisa: 0 }));
    assert.ok(again.recId);
  });

  test('cannot finish while a statement line is not in the ledger; post the charge, match, finish', () => {
    const g = ok(gas.call(f, 'bankrec.get', { recId }));
    const bad = gas.call(f, 'bankrec.match', { recId, matches: g.suggestions, finish: true });
    assert.match(bad.message, /1 statement line\(s\) are not matched/);
    const charge = ok(gas.call(f, 'expenses.create', { date: '2026-10-31', moneyAccountCode: '1100', lines: [{ accountCode: '6600', brand: 'SHARED', netPaisa: rs(150), description: 'Bank charges' }] }));
    const g2 = ok(gas.call(f, 'bankrec.get', { recId }));
    assert.equal(g2.suggestions.length, 3);
    const wrong = gas.call(f, 'bankrec.match', { recId, matches: [{ statementLineId: g2.statementLines[0].id, jeLineId: g2.suggestions[1].jeLineId }] });
    assert.match(wrong.message, /Amounts differ/);
    const done = ok(gas.call(f, 'bankrec.match', { recId, matches: g2.suggestions, finish: true }));
    assert.equal(done.summary.differencePaisa, 0);
    assert.equal(gas.rows('BankRecs').find((r) => r.id === recId).status, 'RECONCILED');
    const reconciled = gas.rows('JournalLines').filter((l) => l.accountCode === '1100' && l.reconciled);
    assert.equal(reconciled.length, 3);
    assert.ok(reconciled.every((l) => l.reconciledDate === '2026-10-31'));
    assert.ok(charge.jeId);
    assert.equal(gas.call(f, 'bankrec.match', { recId, matches: [], finish: true }).code, 'E_VALIDATION');
    // the month-close checklist now sees the bank reconciled
    const list = ok(gas.call(f, 'periods.checklist', { periodId: '2026-10' }));
    assert.equal(list.checks.find((c) => c.key === 'BANK').ok, true);
  });

  test('T19: QuickBooks export through the API; viewers may export', () => {
    const r = ok(gas.call(users.viewer, 'export.quickbooksJournals', { from: '2026-10-01', to: '2026-10-31' }));
    assert.deepEqual(r.unmappedAccounts, []);
    assert.equal(r.rowCount, gas.rows('JournalLines').filter((l) => l.date <= '2026-10-31').length);
    assert.equal(r.debitsPaisa, r.creditsPaisa);
    assert.match(r.csv, /^Journal No\.,Journal Date,Account,Debits,Credits,Description,Name,Class,Currency\r\n/);
    assert.equal(gas.call(users.store, 'export.quickbooksJournals', {}).code, 'E_ROLE');
  });

  test('table export', () => {
    const t = ok(gas.call(users.finance, 'export.table', { tab: 'Contacts' }));
    assert.match(t.csv, /^id,kind,name/);
    assert.equal(t.rows, 1);
    assert.equal(gas.call(users.viewer, 'export.table', { tab: 'Contacts' }).code, 'E_ROLE');
  });
});

describe('chart of accounts (M2.2)', () => {
  test('add, rename with a QuickBooks name, refuse a type change after postings, deactivate', () => {
    const { gas, users } = createSystem();
    const ok = (r) => { assert.ok(r.ok, JSON.stringify(r)); return r.data; };
    ok(gas.call(users.finance, 'accounts.upsert', { code: '6150', name: 'Influencer marketing', type: 'EXPENSE', defaultBrand: 'MIRAE' }));
    assert.equal(gas.call(users.finance, 'accounts.upsert', { code: '6150', name: 'Dup', type: 'EXPENSE' }).code, 'E_VALIDATION');
    assert.match(gas.call(users.finance, 'accounts.upsert', { code: '1999', name: 'Wrong range', type: 'EXPENSE' }).message, /numbered 6000/);
    ok(gas.call(users.finance, 'expenses.create', { date: '2026-10-01', moneyAccountCode: '1100', lines: [{ accountCode: '6150', brand: 'MIRAE', netPaisa: 100 }] }));
    assert.match(gas.call(users.finance, 'accounts.upsert', { id: '6150', type: 'OTHER', code: '6150' }).message, /type cannot change/);
    ok(gas.call(users.finance, 'accounts.upsert', { id: '6150', qbAccountName: 'Marketing:Influencers' }));
    assert.match(gas.call(users.finance, 'accounts.deactivate', { code: '6150' }).message, /still has a balance/);
    assert.match(gas.call(users.finance, 'accounts.deactivate', { code: '1200' }).message, /used by the system/);
    ok(gas.call(users.finance, 'accounts.deactivate', { code: '6120' }));
    assert.equal(gas.call(users.finance, 'expenses.create', { date: '2026-10-01', moneyAccountCode: '1100', lines: [{ accountCode: '6120', brand: 'MIRAE', netPaisa: 100 }] }).code, 'E_INACTIVE_ACCOUNT');
    assert.equal(ok(gas.call(users.viewer, 'accounts.list', {})).find((a) => a.code === '6150').balancePaisa, 100);
  });
});
