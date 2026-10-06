// Bank statement import, matching and reconciliation (core/bankrec.js) and
// the QuickBooks export (core/export.js, scenario T19).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const Bankrec = require('../core/bankrec.js');
const Export = require('../core/export.js');
const Csv = require('../core/csv.js');
const { runThroughT12 } = require('./helpers/scenario.js');

describe('statement import', () => {
  test('one signed amount column, DD/MM/YYYY, a title row above the header', () => {
    const csv = 'Bank 1 statement,,\nDate,Narration,Amount\n01/10/2026,"Advance, Ayesha","300,000.00"\n05/10/2026,Transfer out,(72000)\n,Closing balance,228000\n';
    const r = Bankrec.parseStatement(csv, { dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Narration', amountColumn: 'Amount' });
    assert.deepEqual(r, [
      { date: '2026-10-01', description: 'Advance, Ayesha', amountPaisa: 30000000 },
      { date: '2026-10-05', description: 'Transfer out', amountPaisa: -7200000 },
    ]);
  });
  test('separate debit and credit columns; DD-MMM-YYYY; Cr/Dr suffixes', () => {
    const csv = 'Txn Date,Details,Withdrawal,Deposit\n06-Oct-2026,Cheque 1234,"113,500.00",\n06-Oct-26,Raast IN,,290000 Cr\n';
    const r = Bankrec.parseStatement(csv, { dateColumn: 'Txn Date', dateFormat: 'DD-MMM-YYYY', descriptionColumn: 'Details', debitColumn: 'Withdrawal', creditColumn: 'Deposit' });
    assert.deepEqual(r.map((x) => [x.date, x.amountPaisa]), [['2026-10-06', -11350000], ['2026-10-06', 29000000]]);
  });
  test('clear errors for a wrong mapping or a bad row', () => {
    assert.throws(() => Bankrec.parseStatement('A,B\n1,2\n', { dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', amountColumn: 'B' }), /No column called "Date"/);
    assert.throws(() => Bankrec.parseStatement('Date,Amount\n01/10/2026,abc\n', { dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', amountColumn: 'Amount' }), /Row 2/);
    assert.throws(() => Bankrec.parseStatement('Date,Amount\n31/02/2026,1\n', { dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', amountColumn: 'Amount' }), /real date/);
    assert.equal(Bankrec.parseStatementDate('10/06/2026', 'MM/DD/YYYY'), '2026-10-06');
  });
});

describe('matching and reconciliation', () => {
  const ledger = [
    { id: 'L1', date: '2026-10-01', debitPaisa: 30000000, creditPaisa: 0 },
    { id: 'L2', date: '2026-10-05', debitPaisa: 0, creditPaisa: 7200000 },
    { id: 'L3', date: '2026-10-28', debitPaisa: 0, creditPaisa: 500000 }, // cheque not yet cleared
    { id: 'L4', date: '2026-11-02', debitPaisa: 100, creditPaisa: 0 }, // after the statement
  ];
  const stmt = [
    { id: 'S1', date: '2026-10-02', amountPaisa: 30000000 },
    { id: 'S2', date: '2026-10-05', amountPaisa: -7200000 },
    { id: 'S3', date: '2026-10-31', amountPaisa: -15000 }, // bank charges, not in the ledger yet
  ];
  test('suggestions: same amount, close date, each ledger line once', () => {
    assert.deepEqual(Bankrec.suggestMatches(stmt, ledger), [{ statementLineId: 'S1', jeLineId: 'L1' }, { statementLineId: 'S2', jeLineId: 'L2' }]);
    assert.deepEqual(Bankrec.suggestMatches([{ id: 'S', date: '2026-12-01', amountPaisa: 30000000 }], ledger), []);
  });
  test('summary: uncleared cheque and bank charge explain the difference', () => {
    const rec = { statementDate: '2026-10-31', statementBalancePaisa: 30000000 - 7200000 - 15000 };
    const s = Bankrec.reconciliationSummary(rec, stmt, ledger, Bankrec.suggestMatches(stmt, ledger));
    assert.deepEqual([s.ledgerBalancePaisa, s.unclearedPaisa, s.notInLedgerPaisa, s.differencePaisa], [30000000 - 7200000 - 500000, -500000, -15000, 0]);
    assert.equal(s.outstanding[0].id, 'L3');
    assert.equal(s.balanced, false, 'the bank charge still needs posting and matching');
  });
});

describe('T19 QuickBooks export', () => {
  const { book } = runThroughT12();
  const journals = Object.values(book.journals).map((j) => j.journal);
  test('one row per line, debits = credits, every row has a Class', () => {
    const r = Export.quickbooksJournals(journals, book.lines, book.acc.accountsByCode, book.contacts, { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(r.unmappedAccounts, []);
    assert.equal(r.rowCount, book.lines.length);
    assert.equal(r.debitsPaisa, r.creditsPaisa);
    const rows = Csv.parseObjects(r.csv);
    assert.deepEqual(Object.keys(rows[0]), Export.QB_HEADERS);
    assert.equal(rows.length, book.lines.length);
    assert.ok(rows.every((x) => ['UMSHA', 'Mirae', 'Shared'].includes(x.Class)));
    const sum = (k) => rows.reduce((t, x) => t + (x[k] ? Math.round(Number(x[k]) * 100) : 0), 0);
    assert.equal(sum('Debits'), sum('Credits'));
    assert.equal(rows[0]['Journal Date'], '01/10/2026');
    assert.equal(rows[0].Name, 'Ayesha');
  });
  test('an account without a QuickBooks name stops the export and is listed', () => {
    const acc = JSON.parse(JSON.stringify(book.acc.accountsByCode));
    acc['6040'].qbAccountName = '';
    const r = Export.quickbooksJournals(journals, book.lines, acc, book.contacts, {});
    assert.deepEqual(r.unmappedAccounts, [{ code: '6040', name: 'Utilities' }]);
    assert.equal(r.csv, '');
  });
});
