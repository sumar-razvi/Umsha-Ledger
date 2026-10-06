// Posting rules beyond the golden path: guards, partial payments, tax
// variants, FX, exchanges and the smaller rules (R14, R16, R20, R21).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { rs, expectJournal, Reports, Money, Posting } = require('./helpers/book.js');
const { newScenarioBook, runThroughT12 } = require('./helpers/scenario.js');

const code = (c) => (e) => e.code === c;

describe('guards', () => {
  test('E_PERIOD_LOCKED from any builder', () => {
    const book = newScenarioBook();
    book.periods.push({ id: '2026-09', status: 'CLOSED' });
    assert.throws(() => book.post('receiveAdvance', { date: '2026-09-15', jobId: 'JOB-2026-00001', amountPaisa: 100, moneyAccountCode: '1100' }), code('E_PERIOD_LOCKED'));
    book.periods[0].status = 'OPEN';
    book.post('receiveAdvance', { date: '2026-09-15', jobId: 'JOB-2026-00001', amountPaisa: 100, moneyAccountCode: '1100' });
  });

  test('E_OVERPAY on bills, invoices and cancellation refunds', () => {
    const { book, r } = runThroughT12();
    const rent = r.T07.rent.doc;
    assert.throws(() => book.post('payBills', { date: '2026-10-13', contactId: 'VEN-00005', moneyAccountCode: '1100', allocations: [{ billId: rent.id, amountPaisa: rent.grossPaisa + 1 }] }), code('E_OVERPAY'));
    book.post('receiveAdvance', { date: '2026-10-13', jobId: 'JOB-2026-00002', amountPaisa: rs('1,000'), moneyAccountCode: '1100' });
    assert.throws(() => book.post('cancelJob', { date: '2026-10-13', jobId: 'JOB-2026-00002', refundPaisa: rs('1,000.01'), moneyAccountCode: '1100' }), code('E_OVERPAY'));
    const inv = r.T06.delivery.doc;
    assert.throws(() => book.post('receivePayment', { date: '2026-10-13', contactId: 'CUS-00001', moneyAccountCode: '1100', amountPaisa: 1, allocations: [{ invoiceId: inv.id, amountPaisa: 1 }] }), code('E_OVERPAY'));
  });

  test('E_TAX_OVERRIDE_NO_REASON, and an override with a reason is used', () => {
    const book = newScenarioBook();
    const bill = { date: '2026-10-02', contactId: 'VEN-00001', lines: [{ lineKind: 'STOCK', itemId: 'FAB-0001', qty: 1, unitCostPaisa: 10000, taxCodeId: 'TEST-ST-IN-18', taxPaisa: 1700 }] };
    assert.throws(() => book.post('createBill', bill), code('E_TAX_OVERRIDE_NO_REASON'));
    const ok = book.post('createBill', Object.assign({ taxOverrideReason: 'Supplier invoice shows Rs 17' }, bill));
    expectJournal(ok.lines, [['Dr', '1300', 'SHARED', '100'], ['Dr', '1500', 'SHARED', '17'], ['Cr', '2010', 'SHARED', '117']]);
    assert.throws(() => book.post('deliverJob', { date: '2026-10-06', jobId: 'JOB-2026-00001', taxOverride: { taxPaisa: 0 } }), code('E_TAX_OVERRIDE_NO_REASON'));
  });

  test('E_NEG_STOCK on issue and sale; allowed when the Owner allows it', () => {
    const { book } = runThroughT12();
    assert.throws(() => book.post('issueStock', { date: '2026-10-13', jobId: 'JOB-2026-00002', lines: [{ itemId: 'FAB-0001', qty: 1000 }] }), code('E_NEG_STOCK'));
    assert.throws(() => book.post('createSale', {
      date: '2026-10-13', lines: [{ itemId: 'SKU-C', qty: 4, unitPricePaisa: 100 }], payments: [{ accountCode: '1020', amountPaisa: 400 }],
    }), code('E_NEG_STOCK'));
    book.settings.allowNegativeStock = 'TRUE';
    book.post('createSale', { date: '2026-10-13', lines: [{ itemId: 'SKU-C', qty: 4, unitPricePaisa: 100 }], payments: [{ accountCode: '1020', amountPaisa: 400 }] });
    assert.equal(book.itemBalances['SKU-C'].qty, -1);
  });

  test('advances and deliveries refused on closed jobs; returns limited to what was issued', () => {
    const { book, r } = runThroughT12();
    assert.throws(() => book.post('receiveAdvance', { date: '2026-10-13', jobId: 'JOB-2026-00001', amountPaisa: 100, moneyAccountCode: '1100' }), code('E_JOB_CLOSED'));
    assert.throws(() => book.post('deliverJob', { date: '2026-10-13', jobId: 'JOB-2026-00001' }), code('E_JOB_CLOSED'));
    assert.throws(() => book.post('returnStock', { date: '2026-10-13', jobId: 'JOB-2026-00002', issueMoveId: r.T04.issue.stockMoves[0].id, qty: 9 }), /Only 8 can be returned/);
    const last = book.post('returnStock', { date: '2026-10-13', jobId: 'JOB-2026-00002', issueMoveId: r.T04.issue.stockMoves[0].id, qty: 8 });
    assert.equal(last.stockMoves[0].valuePaisa, 2176471 - 435294, 'the last return takes exactly what is left of the issue');
    assert.equal(book.ctx().jobWip['JOB-2026-00002'], undefined);
  });

  test('payments must match what they are applied to', () => {
    const { book, r } = runThroughT12();
    assert.throws(() => book.post('createSale', {
      date: '2026-10-13', lines: [{ itemId: 'SKU-A', qty: 1, unitPricePaisa: 1000 }], payments: [{ accountCode: '1020', amountPaisa: 999 }],
    }), /do not add up/);
    assert.throws(() => book.post('createSale', {
      date: '2026-10-13', lines: [{ itemId: 'SKU-A', qty: 1, unitPricePaisa: 1000 }], payments: [{ accountCode: '6100', amountPaisa: 1000 }],
    }), /not a cash, bank/);
    assert.throws(() => book.post('returnSale', {
      date: '2026-10-13', originalSaleId: r.T09.doc.id, lines: [{ saleLineId: book.sales[r.T09.doc.id].lines[1].id, qty: 2 }], refund: [],
    }), /Only 1 of SKU-B can be returned/);
  });

  test('manual journals: memo required, stock accounts off limits, flagged isManual', () => {
    const book = newScenarioBook();
    const lines = [{ accountCode: '6300', brand: 'SHARED', debitPaisa: 500 }, { accountCode: '2300', brand: 'SHARED', creditPaisa: 500 }];
    assert.throws(() => book.post('manualJournal', { date: '2026-10-01', lines }), /Say what/);
    assert.throws(() => book.post('manualJournal', { date: '2026-10-01', memo: 'x', lines: [{ accountCode: '1300', brand: 'SHARED', debitPaisa: 5, itemId: 'FAB-0001' }, lines[1]] }), /stock documents/);
    assert.throws(() => book.post('manualJournal', { date: '2026-10-01', memo: 'x', lines: [lines[0], { accountCode: '2300', brand: 'SHARED', creditPaisa: 499 }] }), code('E_UNBALANCED'));
    const ok = book.post('manualJournal', { date: '2026-10-01', memo: 'Audit fee accrual', lines });
    assert.equal(ok.entry.journal.isManual, true);
  });
});

describe('payables', () => {
  test('D-17: partial payments of a multi-brand bill clear AP brand by brand', () => {
    const { book, r } = runThroughT12();
    const rent = r.T07.rent.doc; // 150,000 MIRAE / 100,000 UMSHA / 40,000 SHARED
    const p1 = book.post('payBills', { date: '2026-10-13', contactId: 'VEN-00005', moneyAccountCode: '1100', allocations: [{ billId: rent.id, amountPaisa: rs('100,000') }] });
    expectJournal(p1.lines, [
      ['Dr', '2010', 'UMSHA', '34,482.76'], ['Dr', '2010', 'MIRAE', '51,724.14'], ['Dr', '2010', 'SHARED', '13,793.10'],
      ['Cr', '1100', 'UMSHA', '34,482.76'], ['Cr', '1100', 'MIRAE', '51,724.14'], ['Cr', '1100', 'SHARED', '13,793.10'],
    ]);
    book.post('payBills', { date: '2026-10-14', contactId: 'VEN-00005', moneyAccountCode: '1100', allocations: [{ billId: rent.id, amountPaisa: rs('190,000') }] });
    const apByBrand = {};
    book.lines.filter((l) => l.accountCode === '2010' && l.contactId === 'VEN-00005').forEach((l) => {
      apByBrand[l.brand] = (apByBrand[l.brand] || 0) + l.debitPaisa - l.creditPaisa;
    });
    assert.deepEqual(apByBrand, { MIRAE: 0, UMSHA: 0, SHARED: 0 });
    assert.equal(book.bills[rent.id].balancePaisa, 0);
  });

  test('WHT on a partial payment uses base = paid x net / gross (EXCL_SALES_TAX)', () => {
    const book = newScenarioBook();
    const bill = book.post('createBill', { date: '2026-10-02', contactId: 'VEN-00001', lines: [{ lineKind: 'STOCK', itemId: 'FAB-0001', qty: 50, unitCostPaisa: rs('2,000'), taxCodeId: 'TEST-ST-IN-18' }] });
    const pay = book.post('payBills', { date: '2026-10-03', contactId: 'VEN-00001', moneyAccountCode: '1100', allocations: [{ billId: bill.doc.id, amountPaisa: rs('59,000') }] });
    // base = 59,000 x 100,000 / 118,000 = 50,000; WHT 4.5% = 2,250
    expectJournal(pay.lines, [['Dr', '2010', 'SHARED', '59,000'], ['Cr', '1100', 'SHARED', '56,750'], ['Cr', '2210', 'SHARED', '2,250']]);
    assert.equal(book.bills[bill.doc.id].whtPaisa, rs('2,250'));
  });

  test('tax from an unregistered supplier is not claimable and goes into stock cost', () => {
    const book = newScenarioBook();
    const bill = book.post('createBill', { date: '2026-10-02', contactId: 'VEN-00002', lines: [{ lineKind: 'STOCK', itemId: 'FAB-0001', qty: 10, unitCostPaisa: rs('1,000'), taxCodeId: 'TEST-ST-IN-18' }] });
    expectJournal(bill.lines, [['Dr', '1300', 'SHARED', '11,800'], ['Cr', '2010', 'SHARED', '11,800']]);
    assert.equal(book.itemBalances['FAB-0001'].valuePaisa, rs('11,800'));
    assert.equal(bill.doc.taxPaisa, rs('1,800'));
  });

  test('vendor advance, then applied to a bill', () => {
    const book = newScenarioBook();
    book.post('payVendorAdvance', { date: '2026-10-01', contactId: 'VEN-00004', brand: 'UMSHA', moneyAccountCode: '1100', amountPaisa: rs('5,000') });
    const bill = book.post('karigarWork', { date: '2026-10-02', contactId: 'VEN-00004', jobId: 'JOB-2026-00001', costComponent: 'STITCHING', pieces: 1, ratePaisa: rs('5,000') });
    const applied = book.post('payBills', { date: '2026-10-03', contactId: 'VEN-00004', fromVendorAdvance: true, allocations: [{ billId: bill.doc.id, amountPaisa: rs('5,000') }] });
    expectJournal(applied.lines, [['Dr', '2010', 'UMSHA', '5,000'], ['Cr', '1400', 'UMSHA', '5,000']]);
  });

  test('quick expense with a registered vendor and WHT', () => {
    const book = newScenarioBook();
    const exp = book.post('createExpense', {
      date: '2026-10-02', moneyAccountCode: '1100', contactId: 'VEN-00003',
      lines: [{ accountCode: '6300', brand: 'SHARED', netPaisa: rs('10,000') }],
    });
    expectJournal(exp.lines, [['Dr', '6300', 'SHARED', '10,000'], ['Cr', '1100', 'SHARED', '9,000'], ['Cr', '2210', 'SHARED', '1,000']]);
    assert.throws(() => book.post('createExpense', { date: '2026-10-02', moneyAccountCode: '1100', lines: [{ accountCode: '1200', brand: 'SHARED', netPaisa: 1 }] }), /cannot be chosen/);
    assert.throws(() => book.post('recordDrawings', { date: '2026-10-02', moneyAccountCode: '1100', contactId: 'VEN-00003', amountPaisa: 1 }), /family member/);
  });
});

describe('receivables and sales', () => {
  test('advance in foreign currency (R19)', () => {
    const book = newScenarioBook();
    const adv = book.post('receiveAdvance', { date: '2026-10-01', jobId: 'JOB-2026-00001', currency: 'USD', fxAmount: 1000, fxRate: 278.55, moneyAccountCode: '1101' });
    expectJournal(adv.lines, [['Dr', '1101', 'UMSHA', '278,550'], ['Cr', '2100', 'UMSHA', '278,550']]);
    assert.deepEqual([adv.lines[0].currency, adv.lines[0].fxAmount, adv.lines[0].fxRate], ['USD', 1000, 278.55]);
    assert.throws(() => book.post('receiveAdvance', { date: '2026-10-01', jobId: 'JOB-2026-00001', currency: 'USD', fxAmount: 1000, fxRate: 278.55, amountPaisa: 1, moneyAccountCode: '1101' }), /does not match/);
  });

  test('overpaid order: excess advance stays held and the invoice shows a refund due', () => {
    const book = newScenarioBook();
    book.post('receiveAdvance', { date: '2026-10-01', jobId: 'JOB-2026-00002', amountPaisa: rs('200,000'), moneyAccountCode: '1100' });
    const d = book.post('deliverJob', { date: '2026-10-05', jobId: 'JOB-2026-00002' });
    assert.equal(d.doc.grossPaisa, rs('177,000'));
    assert.equal(d.doc.advanceAppliedPaisa, rs('177,000'));
    assert.equal(d.doc.balancePaisa, 0);
    assert.equal(d.doc.refundDuePaisa, rs('23,000'));
    assert.equal(book.ctx().jobAdvances['JOB-2026-00002'], rs('23,000'));
    expectJournal(d.lines, [
      ['Dr', '1200', 'UMSHA', '177,000'], ['Cr', '4020', 'UMSHA', '150,000'], ['Cr', '2200', 'UMSHA', '27,000'],
      ['Dr', '2100', 'UMSHA', '177,000'], ['Cr', '1200', 'UMSHA', '177,000'],
    ]);
  });

  test('tax-exclusive store sale', () => {
    const { book } = runThroughT12();
    book.settings.rtwPricesIncludeTax = 'FALSE';
    const s = book.post('createSale', {
      date: '2026-10-13', channel: 'ONLINE', lines: [{ itemId: 'SKU-B', qty: 1, unitPricePaisa: rs('5,000'), discountPaisa: rs('500') }],
      payments: [{ method: 'BANK', accountCode: '1100', amountPaisa: rs('5,310') }],
    });
    expectJournal(s.lines, [
      ['Dr', '1100', 'MIRAE', '5,310'], ['Cr', '4110', 'MIRAE', '4,500'], ['Cr', '2200', 'MIRAE', '810'],
      ['Dr', '5100', 'MIRAE', '2,777.78'], ['Cr', '1340', 'MIRAE', '2,777.78'],
    ]);
    assert.equal(s.doc.discountPaisa, rs('500'));
  });

  test('exchange: return one SKU-B, take one SKU-A, pay only the difference', () => {
    const { book, r } = runThroughT12();
    const lineB = book.sales[r.T09.doc.id].lines.find((l) => l.itemId === 'SKU-B');
    const x = book.post('exchangeSale', {
      date: '2026-10-13', originalSaleId: r.T09.doc.id,
      returnLines: [{ saleLineId: lineB.id, qty: 1, restock: true }],
      newLines: [{ itemId: 'SKU-A', qty: 1, unitPricePaisa: rs('9,440') }],
      payments: [{ method: 'CASH', accountCode: '1020', amountPaisa: rs('3,540') }],
    });
    expectJournal(x.lines, [
      ['Dr', '4900', 'MIRAE', '5,000'], ['Dr', '2200', 'MIRAE', '900'], ['Dr', '1340', 'MIRAE', '2,777.78'], ['Cr', '5100', 'MIRAE', '2,777.78'],
      ['Cr', '4100', 'MIRAE', '8,000'], ['Cr', '2200', 'MIRAE', '1,440'], ['Dr', '5100', 'MIRAE', '2,777.78'], ['Cr', '1340', 'MIRAE', '2,777.78'],
      ['Dr', '1020', 'MIRAE', '3,540'],
    ]);
    // SKU-B: both units now returned, so a further return is refused.
    assert.throws(() => book.post('returnSale', { date: '2026-10-13', originalSaleId: r.T09.doc.id, lines: [{ saleLineId: lineB.id, qty: 1 }], refund: [] }), /Only 0/);
  });

  test('return without restock goes to shrinkage', () => {
    const { book, r } = runThroughT12();
    const lineA = book.sales[r.T09.doc.id].lines.find((l) => l.itemId === 'SKU-A');
    const ret = book.post('returnSale', {
      date: '2026-10-13', originalSaleId: r.T09.doc.id, lines: [{ saleLineId: lineA.id, qty: 1, restock: false }],
      refund: [{ accountCode: '2110', amountPaisa: rs('9,440') }],
    });
    expectJournal(ret.lines, [
      ['Dr', '4900', 'MIRAE', '8,000'], ['Dr', '2200', 'MIRAE', '1,440'], ['Cr', '2110', 'MIRAE', '9,440'],
      ['Dr', '5900', 'MIRAE', '2,777.78'], ['Cr', '5100', 'MIRAE', '2,777.78'],
    ]);
    assert.equal(ret.stockMoves.length, 0);
  });
});

describe('banking, cash-up, stock count, tax and opening stock', () => {
  test('transfer (R14), cash-up (R16), sales tax settlement (R20), WHT deposit (R21)', () => {
    const { book } = runThroughT12();
    expectJournal(book.post('transfer', { date: '2026-10-13', fromCode: '1100', toCode: '1030', amountPaisa: rs('5,000') }).lines,
      [['Dr', '1030', 'SHARED', '5,000'], ['Cr', '1100', 'SHARED', '5,000']]);
    assert.throws(() => book.post('transfer', { date: '2026-10-13', fromCode: '1100', toCode: '1100', amountPaisa: 1 }), /two different/);
    expectJournal(book.post('cashUp', { date: '2026-10-13', cashAccountCode: '1020', expectedCashPaisa: rs('10,000'), countedCashPaisa: rs('9,950') }).lines,
      [['Dr', '6810', 'MIRAE', '50'], ['Cr', '1020', 'MIRAE', '50']]);
    expectJournal(book.post('cashUp', { date: '2026-10-14', cashAccountCode: '1020', expectedCashPaisa: rs('9,950'), countedCashPaisa: rs('9,960') }).lines,
      [['Dr', '1020', 'MIRAE', '10'], ['Cr', '6810', 'MIRAE', '10']]);
    const even = book.post('cashUp', { date: '2026-10-15', cashAccountCode: '1020', expectedCashPaisa: 100, countedCashPaisa: 100 });
    assert.equal(even.jeId, '');
    assert.equal(even.doc.diffPaisa, 0);
    expectJournal(book.post('settleSalesTax', { date: '2026-10-15', outputPaisa: rs('92,340'), inputPaisa: rs('18,000'), bankCode: '1100' }).lines,
      [['Dr', '2200', 'SHARED', '92,340'], ['Cr', '1500', 'SHARED', '18,000'], ['Cr', '1100', 'SHARED', '74,340']]);
    expectJournal(book.post('depositWht', { date: '2026-10-15', amountPaisa: rs('12,500'), bankCode: '1100' }).lines,
      [['Dr', '2210', 'SHARED', '12,500'], ['Cr', '1100', 'SHARED', '12,500']]);
    assert.equal(Reports.accountBalances(book.lines)['2210'], 0);
  });

  test('stock count surplus is valued at average cost', () => {
    const { book } = runThroughT12();
    const count = book.post('postStockCount', { date: '2026-10-13', lines: [{ itemId: 'FAB-0001', countedQty: 60.5 }, { itemId: 'SKU-C', countedQty: 3 }] });
    const avg = book.itemBalances['FAB-0001'].avgCostMicro;
    assert.equal(count.doc.lines[0].diffQty, 0.5);
    assert.equal(count.doc.lines[1].diffQty, 0);
    expectJournal(count.lines, [['Dr', '1300', 'SHARED', Money.toRupeeString(count.doc.lines[0].valuePaisa)], ['Cr', '5900', 'SHARED', Money.toRupeeString(count.doc.lines[0].valuePaisa)]]);
    assert.ok(avg > 0);
  });

  test('opening stock credits retained earnings', () => {
    const book = newScenarioBook();
    const o = book.post('openingStock', { date: '2026-07-01', lines: [{ itemId: 'FAB-0001', qty: 20, valuePaisa: rs('40,000') }, { itemId: 'SKU-A', qty: 5, valuePaisa: rs('12,500') }] });
    expectJournal(o.lines, [['Dr', '1300', 'SHARED', '40,000'], ['Dr', '1340', 'MIRAE', '12,500'], ['Cr', '3030', 'SHARED', '52,500']]);
    assert.equal(book.itemBalances['SKU-A'].avgCostMicro, rs('2,500') * 10000);
  });

  test('a paid bill cannot be reversed until its payments are', () => {
    const { book, r } = runThroughT12();
    assert.throws(() => book.post('reverseEntry', { date: '2026-10-13', jeId: r.T02.a.jeId, reason: 'x' }), /Reverse the payments first/);
    assert.throws(() => book.post('reverseEntry', { date: '2026-10-13', jeId: r.T01.jeId }), /reason/);
  });
});

describe('payment reversals and WHT overrides (M4)', () => {
  test('reversing a bill payment makes the bill owed again, WHT included', () => {
    const { book, r } = runThroughT12();
    const pay = r.T05.paySupplier; // 118,000 settled, 4,500 WHT
    const billId = pay.doc.allocations[0].docId;
    assert.equal(book.bills[billId].balancePaisa, 0);
    const rev = book.post('reverseEntry', { date: '2026-10-13', jeId: pay.jeId, reason: 'Paid from the wrong account' });
    assert.deepEqual([book.bills[billId].paidPaisa, book.bills[billId].whtPaisa, book.bills[billId].balancePaisa], [0, 0, rs('118,000')]);
    assert.equal(book.docOf(pay.doc.id).status, 'VOID');
    assert.ok(rev.lines.length > 0);
    // and it can be paid again, correctly
    const again = book.post('payBills', { date: '2026-10-14', contactId: 'VEN-00001', moneyAccountCode: '1101', allocations: [{ billId, amountPaisa: rs('118,000') }] });
    expectJournal(again.lines, [['Dr', '2010', 'SHARED', '118,000'], ['Cr', '1101', 'SHARED', '113,500'], ['Cr', '2210', 'SHARED', '4,500']]);
  });

  test('reversing a customer payment makes the invoice owed again', () => {
    const { book, r } = runThroughT12();
    const invId = r.T06.delivery.doc.id;
    book.post('reverseEntry', { date: '2026-10-13', jeId: r.T06.payment.jeId, reason: 'Cheque bounced' });
    assert.deepEqual([book.invoices[invId].paidPaisa, book.invoices[invId].balancePaisa], [0, rs('290,000')]);
    assert.equal(Reports.customerBalances(book.lines, book.acc)['CUS-00001'].owesPaisa, rs('290,000'));
  });

  test('WHT can be changed with a reason; without one it is refused', () => {
    const book = newScenarioBook();
    const bill = book.post('karigarWork', { date: '2026-10-02', contactId: 'VEN-00003', jobId: 'JOB-2026-00001', costComponent: 'EMBROIDERY', pieces: 10, ratePaisa: rs('1,000') });
    const base = { date: '2026-10-03', contactId: 'VEN-00003', moneyAccountCode: '1100' };
    assert.throws(() => book.post('payBills', Object.assign({ allocations: [{ billId: bill.doc.id, amountPaisa: rs('10,000'), whtPaisa: rs('500') }] }, base)), code('E_TAX_OVERRIDE_NO_REASON'));
    const p = book.post('payBills', Object.assign({ whtOverrideReason: 'Exemption certificate', allocations: [{ billId: bill.doc.id, amountPaisa: rs('10,000'), whtPaisa: rs('500') }] }, base));
    expectJournal(p.lines, [['Dr', '2010', 'UMSHA', '10,000'], ['Cr', '1100', 'UMSHA', '9,500'], ['Cr', '2210', 'UMSHA', '500']]);
    assert.equal(p.doc.allocations[0].whtPaisa, rs('500'));
    assert.equal(p.doc.whtOverrideReason, 'Exemption certificate');
  });

  test('whtOnBillPayment matches what payBills posts', () => {
    const bill = { netPaisa: rs('100,000'), grossPaisa: rs('118,000') };
    assert.equal(Posting.whtOnBillPayment(bill, rs('59,000'), { rateBps: 450, whtBase: 'EXCL_SALES_TAX' }), rs('2,250'));
    assert.equal(Posting.whtOnBillPayment(bill, rs('59,000'), { rateBps: 450, whtBase: 'GROSS' }), rs('2,655'));
    assert.equal(Posting.whtOnBillPayment(bill, rs('59,000'), null), 0);
  });
});
