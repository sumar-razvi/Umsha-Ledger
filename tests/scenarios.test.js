// Golden scenarios T01-T12 (docs/08-test-scenarios.md), run in sequence on
// one shared state, with the exact numbers given there. Expected journals
// are compared per account and brand, as the docs show them.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { rs, expectJournal, lineTotals, Reports } = require('./helpers/book.js');
const { newScenarioBook, steps } = require('./helpers/scenario.js');

describe('T01-T12 in sequence', () => {
  const book = newScenarioBook();
  const r = {};

  test('T01 customer advance (R1)', () => {
    r.T01 = steps.T01(book);
    expectJournal(r.T01.lines, [
      ['Dr', '1100', 'UMSHA', '300,000'],
      ['Cr', '2100', 'UMSHA', '300,000'],
    ]);
    assert.ok(r.T01.lines.every((l) => l.jobId === 'JOB-2026-00001' && l.contactId === 'CUS-00001'));
    const customer = Reports.customerBalances(book.lines, book.acc)['CUS-00001'];
    assert.deepEqual(customer, { owesPaisa: 0, advanceHeldPaisa: rs('300,000') });
  });

  test('T02 stock purchases (R2)', () => {
    r.T02 = steps.T02(book);
    expectJournal(r.T02.a.lines, [
      ['Dr', '1300', 'SHARED', '100,000'],
      ['Dr', '1500', 'SHARED', '18,000'],
      ['Cr', '2010', 'SHARED', '118,000'],
    ]);
    assert.equal(r.T02.a.lines.find((l) => l.accountCode === '1300').qty, 50);
    expectJournal(r.T02.b.lines, [
      ['Dr', '1310', 'SHARED', '30,000'],
      ['Cr', '2010', 'SHARED', '30,000'],
    ]);
    assert.deepEqual(book.itemBalances['FAB-0001'], { itemId: 'FAB-0001', qty: 50, avgCostMicro: rs('2,000') * 10000, valuePaisa: rs('100,000') });
    assert.deepEqual(book.itemBalances['TRM-0001'], { itemId: 'TRM-0001', qty: 1000, avgCostMicro: rs('30') * 10000, valuePaisa: rs('30,000') });
  });

  test('T03 issue to job (R7)', () => {
    r.T03 = steps.T03(book);
    expectJournal(r.T03.lines, [
      ['Dr', '1330', 'UMSHA', '36,000'],
      ['Cr', '1300', 'SHARED', '24,000'],
      ['Cr', '1310', 'SHARED', '12,000'],
    ]);
    const wip = r.T03.lines.filter((l) => l.accountCode === '1330');
    assert.deepEqual(wip.map((l) => [l.costComponent, l.debitPaisa]), [['FABRIC', rs('24,000')], ['TRIMS', rs('12,000')]]);
    assert.deepEqual(book.ctx().jobWip['JOB-2026-00001'], { FABRIC: rs('24,000'), TRIMS: rs('12,000') });
  });

  test('T04 weighted average, issue and return at original cost (R2 + R7)', () => {
    r.T04 = steps.T04(book);
    assert.deepEqual(r.T04.afterPurchase, { itemId: 'FAB-0001', qty: 68, avgCostMicro: 2176470588, valuePaisa: rs('148,000') });
    expectJournal(r.T04.issue.lines, [
      ['Dr', '1330', 'UMSHA', '21,764.71'],
      ['Cr', '1300', 'SHARED', '21,764.71'],
    ]);
    assert.deepEqual(r.T04.afterIssue, { itemId: 'FAB-0001', qty: 58, avgCostMicro: 2176470588, valuePaisa: 12623529 });
    expectJournal(r.T04.ret.lines, [
      ['Dr', '1300', 'SHARED', '4,352.94'],
      ['Cr', '1330', 'UMSHA', '4,352.94'],
    ]);
    assert.equal(r.T04.ret.stockMoves[0].sourceMoveId, r.T04.issue.stockMoves[0].id);
    assert.equal(r.T04.ret.stockMoves[0].moveType, 'RETURN_TO_STOCK');
    assert.equal(book.itemBalances['FAB-0001'].qty, 60);
    assert.equal(book.itemBalances['FAB-0001'].valuePaisa, 12623529 + 435294);
  });

  test('T05 karigar work and payment with WHT (R3, R5)', () => {
    r.T05 = steps.T05(book);
    expectJournal(r.T05.emb.lines, [
      ['Dr', '1330', 'UMSHA', '80,000'],
      ['Cr', '2010', 'UMSHA', '80,000'],
    ]);
    assert.equal(r.T05.emb.lines[0].costComponent, 'EMBROIDERY');
    expectJournal(r.T05.stitch.lines, [
      ['Dr', '1330', 'UMSHA', '15,000'],
      ['Cr', '2010', 'UMSHA', '15,000'],
    ]);
    assert.equal(r.T05.stitch.lines[0].costComponent, 'STITCHING');
    expectJournal(r.T05.payKarigar.lines, [
      ['Dr', '2010', 'UMSHA', '80,000'],
      ['Cr', '1100', 'UMSHA', '72,000'],
      ['Cr', '2210', 'UMSHA', '8,000'],
    ]);
    expectJournal(r.T05.paySupplier.lines, [
      ['Dr', '2010', 'SHARED', '118,000'],
      ['Cr', '1100', 'SHARED', '113,500'],
      ['Cr', '2210', 'SHARED', '4,500'],
    ]);
    assert.equal(r.T05.paySupplier.doc.whtPaisa, rs('4,500'));
    assert.equal(book.bills[r.T05.emb.doc.id].balancePaisa, 0);
  });

  test('T06 MTO delivery (R8) and balance payment (R9)', () => {
    assert.deepEqual(book.ctx().jobWip['JOB-2026-00001'], {
      FABRIC: rs('24,000'), TRIMS: rs('12,000'), EMBROIDERY: rs('80,000'), STITCHING: rs('15,000'),
    });
    r.T06 = steps.T06(book);
    const d = r.T06.delivery;
    expectJournal(d.lines, [
      ['Dr', '1200', 'UMSHA', '590,000'],
      ['Cr', '4010', 'UMSHA', '500,000'],
      ['Cr', '2200', 'UMSHA', '90,000'],
      ['Dr', '2100', 'UMSHA', '300,000'],
      ['Cr', '1200', 'UMSHA', '300,000'],
      ['Dr', '5010', 'UMSHA', '24,000'],
      ['Dr', '5020', 'UMSHA', '12,000'],
      ['Dr', '5030', 'UMSHA', '80,000'],
      ['Dr', '5040', 'UMSHA', '15,000'],
      ['Cr', '1330', 'UMSHA', '131,000'],
    ]);
    assert.deepEqual(lineTotals(d.lines), { debit: rs('1,021,000'), credit: rs('1,021,000') });
    assert.equal(d.doc.balancePaisa, rs('290,000'));
    assert.equal(d.doc.marginPaisa, rs('369,000'));
    assert.equal(d.doc.marginBps, 7380);
    assert.equal(book.jobs['JOB-2026-00001'].status, 'DELIVERED');
    const prof = Reports.jobProfitability(book.lines, book.acc, book.jobs, {});
    assert.deepEqual(prof.map((p) => [p.jobId, p.marginPaisa, p.marginBps]), [['JOB-2026-00001', rs('369,000'), 7380]]);

    expectJournal(r.T06.payment.lines, [
      ['Dr', '1100', 'UMSHA', '290,000'],
      ['Cr', '1200', 'UMSHA', '290,000'],
    ]);
    assert.deepEqual(Reports.customerBalances(book.lines, book.acc)['CUS-00001'], undefined); // owes 0, no advance left
    assert.equal(book.invoices[d.doc.id].balancePaisa, 0);
  });

  test('T07 expenses, quick expense and drawings (R4, R6, R18)', () => {
    r.T07 = steps.T07(book);
    expectJournal(r.T07.rent.lines, [
      ['Dr', '6020', 'MIRAE', '150,000'],
      ['Dr', '6030', 'UMSHA', '100,000'],
      ['Dr', '6040', 'SHARED', '40,000'],
      ['Cr', '2010', 'MIRAE', '150,000'],
      ['Cr', '2010', 'UMSHA', '100,000'],
      ['Cr', '2010', 'SHARED', '40,000'],
    ]);
    expectJournal(r.T07.shoot.lines, [
      ['Dr', '6100', 'MIRAE', '45,000'],
      ['Cr', '1100', 'MIRAE', '45,000'],
    ]);
    expectJournal(r.T07.drawings.lines, [
      ['Dr', '3020', 'SHARED', '20,000'],
      ['Cr', '1030', 'SHARED', '20,000'],
    ]);
    const pnl = Reports.profitAndLoss(book.lines, book.acc, {});
    const allRows = Object.values(pnl.sections).flatMap((s) => s.rows);
    assert.ok(!allRows.some((row) => row.code === '3020'), 'drawings must not appear on the P&L');
  });

  test('T08 RTW batch completion (R10)', () => {
    r.T08 = steps.T08(book);
    assert.equal(Object.values(r.T08.wipBefore).reduce((a, b) => a + b, 0), rs('100,000'));
    const c = r.T08.complete;
    expectJournal(c.lines, [
      ['Dr', '1340', 'MIRAE', '100,000'],
      ['Cr', '1330', 'MIRAE', '100,000'],
    ]);
    const fg = c.lines.filter((l) => l.accountCode === '1340').map((l) => [l.itemId, l.qty, l.debitPaisa]);
    assert.deepEqual(fg, [['SKU-A', 10, 2777778], ['SKU-B', 20, 5555556], ['SKU-C', 3, 1666666]]);
    assert.equal(book.itemBalances['SKU-A'].avgCostMicro, 2777778000);
    assert.equal(book.itemBalances['SKU-B'].avgCostMicro, 2777778000);
    assert.equal(book.itemBalances['SKU-C'].avgCostMicro, 5555553333); // 555,555.33 paisa
    assert.equal(book.jobs['JOB-2026-00003'].status, 'COMPLETED');
    assert.equal(book.ctx().jobWip['JOB-2026-00003'], undefined);
  });

  test('T09 store sale, tax-inclusive (R11)', () => {
    r.T09 = steps.T09(book);
    expectJournal(r.T09.lines, [
      ['Dr', '1020', 'MIRAE', '10,000.00'],
      ['Dr', '1210', 'MIRAE', '11,240.00'],
      ['Cr', '4100', 'MIRAE', '18,000.00'],
      ['Cr', '2200', 'MIRAE', '3,240.00'],
      ['Dr', '5100', 'MIRAE', '8,333.34'],
      ['Cr', '1340', 'MIRAE', '8,333.34'],
    ]);
    const lines = r.T09.doc.lines.map((l) => [l.itemId, l.netPaisa, l.taxPaisa, l.costPaisa]);
    assert.deepEqual(lines, [['SKU-A', rs('8,000'), rs('1,440'), rs('2,777.78')], ['SKU-B', rs('10,000'), rs('1,800'), rs('5,555.56')]]);
    assert.equal(r.T09.doc.grossPaisa, rs('21,240'));
  });

  test('T10 return at original price and cost (R12)', () => {
    r.T10 = steps.T10(book, r.T09);
    expectJournal(r.T10.lines, [
      ['Dr', '4900', 'MIRAE', '5,000.00'],
      ['Dr', '2200', 'MIRAE', '900.00'],
      ['Cr', '1210', 'MIRAE', '5,900.00'],
      ['Dr', '1340', 'MIRAE', '2,777.78'],
      ['Cr', '5100', 'MIRAE', '2,777.78'],
    ]);
    assert.equal(book.itemBalances['SKU-B'].qty, 19);
  });

  test('T11 stock count shortfall (R15)', () => {
    assert.equal(book.itemBalances['SKU-A'].qty, 9);
    r.T11 = steps.T11(book);
    expectJournal(r.T11.lines, [
      ['Dr', '5900', 'MIRAE', '2,777.78'],
      ['Cr', '1340', 'MIRAE', '2,777.78'],
    ]);
    assert.deepEqual(r.T11.doc.lines[0], { itemId: 'SKU-A', systemQty: 9, countedQty: 8, diffQty: -1, valuePaisa: -277778 });
  });

  test('T12 card settlement (R13)', () => {
    r.T12 = steps.T12(book);
    expectJournal(r.T12.lines, [
      ['Dr', '1100', 'SHARED', '5,233.20'],
      ['Dr', '6210', 'MIRAE', '106.80'],
      ['Cr', '1210', 'SHARED', '5,340.00'],
    ]);
    const clearing = Reports.accountBalances(book.lines)['1210'];
    assert.equal(clearing, 0);
  });

  test('every posted entry balanced; ledger integrity holds after T12', () => {
    for (const id of book.journalOrder) {
      const t = lineTotals(book.journals[id].lines);
      assert.equal(t.debit, t.credit, id);
    }
    for (const c of Reports.integrityChecks(book.lines, book.stockMoves, book.acc, book.items)) assert.ok(c.ok, c.name + ': ' + c.glPaisa + ' vs ' + c.subledgerPaisa);
  });
});
