// Scenarios that build on the T01-T12 state (T16, T17, T21) and the
// standalone core-level ones (T18 reversal, T20 cancellation).
// T13-T15 (API harness) are milestone M2; T19 (QuickBooks export) is M8.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { rs, expectJournal, Reports, Posting } = require('./helpers/book.js');
const { runThroughT12, newScenarioBook } = require('./helpers/scenario.js');

describe('T16 P&L by brand (after T01-T12)', () => {
  const { book } = runThroughT12();

  function columnTotalsMatchRows(pnl) {
    for (const [key, section] of Object.entries(pnl.sections)) {
      for (const col of Reports.COLUMNS) {
        const sum = section.rows.reduce((s, row) => s + row.amounts[col], 0);
        assert.equal(section.total[col], sum, key + ' ' + col);
      }
      for (const row of section.rows) assert.equal(row.amounts.TOTAL, row.amounts.UMSHA + row.amounts.MIRAE + row.amounts.SHARED, row.code);
    }
  }

  test('unallocated: revenue by brand, Total = UMSHA + MIRAE + SHARED', () => {
    const pnl = Reports.profitAndLoss(book.lines, book.acc, { allocate: 'NONE' });
    assert.equal(pnl.summary.netRevenue.UMSHA, rs('500,000'));
    assert.equal(pnl.summary.netRevenue.MIRAE, rs('13,000'));
    const electricity = pnl.sections.expenses.rows.find((row) => row.code === '6040');
    assert.deepEqual(electricity.amounts, { UMSHA: 0, MIRAE: 0, SHARED: rs('40,000'), TOTAL: rs('40,000') });
    columnTotalsMatchRows(pnl);
    for (const k of ['netRevenue', 'grossProfit', 'netProfit']) {
      assert.equal(pnl.summary[k].TOTAL, pnl.summary[k].UMSHA + pnl.summary[k].MIRAE + pnl.summary[k].SHARED, k);
    }
  });

  test('allocated by REVENUE: electricity 38,986.35 / 1,013.65; drawings absent', () => {
    const pnl = Reports.profitAndLoss(book.lines, book.acc, { allocate: 'REVENUE' });
    const electricity = pnl.sections.expenses.rows.find((row) => row.code === '6040');
    assert.deepEqual(electricity.amounts, { UMSHA: rs('38,986.35'), MIRAE: rs('1,013.65'), SHARED: 0, TOTAL: rs('40,000') });
    columnTotalsMatchRows(pnl);
    const codes = Object.values(pnl.sections).flatMap((s) => s.rows.map((row) => row.code));
    assert.ok(!codes.includes('3020'));
    const unallocated = Reports.profitAndLoss(book.lines, book.acc, { allocate: 'NONE' });
    assert.equal(pnl.summary.netProfit.TOTAL, unallocated.summary.netProfit.TOTAL, 'allocation never changes the total');
  });

  test('allocated FIXED 60/40', () => {
    const pnl = Reports.profitAndLoss(book.lines, book.acc, { allocate: 'FIXED', umshaPctBps: 6000 });
    const electricity = pnl.sections.expenses.rows.find((row) => row.code === '6040');
    assert.deepEqual(electricity.amounts, { UMSHA: rs('24,000'), MIRAE: rs('16,000'), SHARED: 0, TOTAL: rs('40,000') });
  });
});

describe('T17 integrity (after T01-T12)', () => {
  const { book } = runThroughT12();

  test('trial balance debits = credits', () => {
    const tb = Reports.trialBalance(book.lines, book.acc, {});
    assert.ok(tb.balanced);
    assert.equal(tb.totalDebitPaisa, tb.totalCreditPaisa);
  });

  test('AR control = customer balances = 0', () => {
    assert.equal(Reports.accountBalances(book.lines)['1200'], 0);
    const owes = Object.values(Reports.customerBalances(book.lines, book.acc)).reduce((s, c) => s + c.owesPaisa, 0);
    assert.equal(owes, 0);
  });

  test('AP control = vendor balances = 407,000', () => {
    assert.equal(-Reports.accountBalances(book.lines)['2010'], rs('407,000'));
    assert.deepEqual(Reports.vendorBalances(book.lines, book.acc), {
      'VEN-00002': rs('102,000'), 'VEN-00004': rs('15,000'), 'VEN-00005': rs('290,000'),
    });
  });

  test('inventory GL (1300 + 1310 + 1340) = stock valuation', () => {
    const bal = Reports.accountBalances(book.lines);
    const val = Reports.stockValuation(book.stockMoves, book.items, {});
    assert.equal(bal['1300'], val.byAccountKey.INV_FABRIC);
    assert.equal(bal['1310'], val.byAccountKey.INV_TRIMS);
    assert.equal(bal['1340'], val.byAccountKey.INV_FG);
    assert.equal(bal['1300'] + bal['1310'] + bal['1340'], val.totalPaisa);
  });

  test('WIP (1330) = open job WIP', () => {
    const wip = Reports.jobWip(book.lines, book.acc);
    assert.deepEqual(wip, { 'JOB-2026-00002': { FABRIC: 2176471 - 435294 } });
    assert.equal(Reports.accountBalances(book.lines)['1330'], 2176471 - 435294);
  });

  test('every integrity check passes, and the balance sheet balances', () => {
    for (const c of Reports.integrityChecks(book.lines, book.stockMoves, book.acc, book.items)) assert.ok(c.ok, c.name);
    assert.ok(Reports.balanceSheet(book.lines, book.acc, {}).balanced);
  });
});

describe('T18 reversal (R22)', () => {
  const { book, r } = runThroughT12();
  const original = r.T07.shoot;
  let reversal;

  test('reversal mirrors the original and links both', () => {
    reversal = book.post('reverseEntry', { date: '2026-10-13', jeId: original.jeId, reason: 'Entered twice' });
    expectJournal(reversal.lines, [
      ['Dr', '1100', 'MIRAE', '45,000'],
      ['Cr', '6100', 'MIRAE', '45,000'],
    ]);
    assert.equal(book.journals[reversal.jeId].journal.reversesJeId, original.jeId);
    assert.equal(book.journals[original.jeId].journal.reversedByJeId, reversal.jeId);
  });

  test('net effect on 6100 and Bank of the pair is zero; original is VOID', () => {
    const pair = original.lines.concat(reversal.lines);
    for (const code of ['6100', '1100']) {
      assert.equal(Reports.accountBalances(pair.filter((l) => l.accountCode === code))[code], 0);
    }
    assert.equal(book.docOf(original.doc.id).status, 'VOID');
  });

  test('reversing a reversal, or reversing twice, is rejected', () => {
    assert.throws(() => book.post('reverseEntry', { date: '2026-10-13', jeId: reversal.jeId, reason: 'x' }), /itself a reversal/);
    assert.throws(() => book.post('reverseEntry', { date: '2026-10-13', jeId: original.jeId, reason: 'x' }), /already been reversed/);
  });

  test('reversing a stock entry restores quantity at original cost', () => {
    const before = Object.assign({}, book.itemBalances['SKU-A']);
    const sale = r.T09;
    const rev = book.post('reverseEntry', { date: '2026-10-13', jeId: sale.jeId, reason: 'Test' });
    assert.equal(book.itemBalances['SKU-A'].qty, before.qty + 1);
    assert.equal(book.itemBalances['SKU-A'].valuePaisa, before.valuePaisa + 277778);
    assert.ok(rev.stockMoves.every((m) => m.moveType === 'REVERSAL'));
    for (const c of Reports.integrityChecks(book.lines, book.stockMoves, book.acc, book.items)) assert.ok(c.ok, c.name);
  });
});

describe('T20 MTO cancellation (R17, standalone)', () => {
  test('refund 60,000 of a 100,000 advance and write off 10,000 WIP', () => {
    const book = newScenarioBook();
    const job = book.addJob({ type: 'MTO_ORDER', contactId: 'CUS-00002', title: 'Cancelled order', taxCodeId: 'TEST-ST-18', lines: [] });
    book.post('receiveAdvance', { date: '2026-10-01', jobId: job.id, amountPaisa: rs('100,000'), moneyAccountCode: '1100' });
    book.post('karigarWork', { date: '2026-10-02', contactId: 'VEN-00004', jobId: job.id, costComponent: 'STITCHING', pieces: 1, ratePaisa: rs('10,000') });
    const cancel = book.post('cancelJob', { date: '2026-10-03', jobId: job.id, refundPaisa: rs('60,000'), moneyAccountCode: '1100', wipTreatment: 'WRITE_OFF' });
    expectJournal(cancel.lines, [
      ['Dr', '2100', 'UMSHA', '100,000'],
      ['Cr', '1100', 'UMSHA', '60,000'],
      ['Cr', '4040', 'UMSHA', '40,000'],
      ['Dr', '5070', 'UMSHA', '10,000'],
      ['Cr', '1330', 'UMSHA', '10,000'],
    ]);
    assert.equal(book.jobs[job.id].status, 'CANCELLED');
    assert.equal(book.ctx().jobWip[job.id], undefined);
    assert.throws(() => book.post('karigarWork', { date: '2026-10-04', contactId: 'VEN-00004', jobId: job.id, costComponent: 'STITCHING', pieces: 1, ratePaisa: 100 }),
      (e) => e.code === 'E_JOB_CLOSED');
  });

  test('RETURN treatment puts issued materials back at original cost and writes off the rest', () => {
    const book = newScenarioBook();
    book.post('createBill', { date: '2026-10-01', contactId: 'VEN-00002', lines: [{ lineKind: 'STOCK', itemId: 'FAB-0001', qty: 10, unitCostPaisa: rs('1,000') }] });
    const job = book.addJob({ type: 'MTO_ORDER', contactId: 'CUS-00002', title: 'Changed mind', lines: [] });
    book.post('issueStock', { date: '2026-10-02', jobId: job.id, lines: [{ itemId: 'FAB-0001', qty: 4 }] });
    book.post('karigarWork', { date: '2026-10-02', contactId: 'VEN-00004', jobId: job.id, costComponent: 'STITCHING', pieces: 1, ratePaisa: rs('2,000') });
    const cancel = book.post('cancelJob', { date: '2026-10-03', jobId: job.id, refundPaisa: 0, wipTreatment: 'RETURN' });
    expectJournal(cancel.lines, [
      ['Dr', '1300', 'SHARED', '4,000'],
      ['Cr', '1330', 'UMSHA', '6,000'],
      ['Dr', '5070', 'UMSHA', '2,000'],
    ]);
    assert.equal(book.itemBalances['FAB-0001'].qty, 10);
    assert.equal(cancel.doc.writtenOffPaisa, rs('2,000'));
  });
});

describe('T21 late cost after delivery (R8)', () => {
  test('one entry posts to WIP and straight on to COGS, flagged lateCost; margin 364,000', () => {
    const { book } = runThroughT12();
    const late = book.post('karigarWork', { date: '2026-10-14', contactId: 'VEN-00004', jobId: 'JOB-2026-00001', costComponent: 'STITCHING', pieces: 1, ratePaisa: rs('5,000') });
    expectJournal(late.lines, [
      ['Dr', '1330', 'UMSHA', '5,000'],
      ['Cr', '2010', 'UMSHA', '5,000'],
      ['Dr', '5040', 'UMSHA', '5,000'],
      ['Cr', '1330', 'UMSHA', '5,000'],
    ]);
    assert.deepEqual(late.lines.filter((l) => l.lateCost).map((l) => l.accountCode).sort(), ['1330', '1330', '5040']);
    const prof = Reports.jobProfitability(book.lines, book.acc, book.jobs, {}).find((p) => p.jobId === 'JOB-2026-00001');
    assert.equal(prof.marginPaisa, rs('364,000'));
    assert.equal(Reports.jobCostSheet(book.lines, book.acc, 'JOB-2026-00001').totalPaisa, rs('136,000'));
    assert.equal(book.ctx().jobWip['JOB-2026-00001'], undefined);
  });
});

describe('R23 year-end close', () => {
  test('brings every P&L account to zero into retained earnings, and runs once', () => {
    const { book } = runThroughT12();
    book.settings.fiscalYearStartMonth = '7';
    assert.throws(() => book.post('closeYear', { date: '2027-06-29', lines: book.lines }), /last day of a fiscal year/);
    const before = Reports.profitAndLoss(book.lines, book.acc, {}).summary.netProfit.TOTAL;
    const close = book.post('closeYear', { date: '2027-06-30', lines: book.lines });
    assert.equal(close.entry.journal.isClosing, true);
    const bal = Reports.accountBalances(book.lines);
    for (const [code, n] of Object.entries(bal)) {
      if (['REVENUE', 'COGS', 'EXPENSE', 'OTHER', 'TAX'].includes(book.acc.accountsByCode[code].type)) assert.equal(n, 0, code);
    }
    assert.equal(close.doc.netProfitPaisa, before);
    const re = close.lines.find((l) => l.accountCode === '3030');
    assert.equal(re.brand, 'SHARED');
    assert.equal(re.creditPaisa - re.debitPaisa, before);
    assert.ok(Reports.balanceSheet(book.lines, book.acc, {}).balanced);
    // The P&L for the year still shows the year's results: closing entries are excluded.
    assert.equal(Reports.profitAndLoss(book.lines, book.acc, { from: '2026-07-01', to: '2027-06-30' }).summary.netProfit.TOTAL, before);
    assert.throws(() => book.post('closeYear', { date: '2027-06-30', lines: book.lines }), /Nothing to close/);
    assert.equal(Posting.fiscalYearStartFor('2027-06-30', 7), '2026-07-01');
  });
});

describe('inventory reconciliation (M5.7)', () => {
  test('inventory GL equals stock valuation per account after T01-T12', () => {
    const { book } = runThroughT12();
    const r = Reports.inventoryReconciliation(book.lines, book.stockMoves, book.acc, book.items, {});
    assert.ok(r.reconciled);
    assert.deepEqual(r.rows.map((x) => [x.systemKey, x.differencePaisa]), [['INV_FABRIC', 0], ['INV_TRIMS', 0], ['INV_PACKAGING', 0], ['INV_FG', 0]]);
    assert.equal(r.rows.find((x) => x.systemKey === 'INV_FG').stockPaisa, 10000000 - 833334 + 277778 - 277778);
  });
});
