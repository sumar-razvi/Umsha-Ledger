// The shared state for docs/08-test-scenarios.md T01-T12, as steps that can
// be replayed. Tests assert after each step; later scenarios (T16, T17, T21)
// replay all of them on a fresh book.
const { Book, rs, Money } = require('./book.js');

const D = {
  T01: '2026-10-01', T02: '2026-10-02', T03: '2026-10-03', T04: '2026-10-04', T05: '2026-10-05', T06: '2026-10-06',
  T07: '2026-10-07', T08: '2026-10-08', T09: '2026-10-09', T10: '2026-10-10', T11: '2026-10-11', T12: '2026-10-12',
};

function newScenarioBook() {
  const book = new Book({ settings: { rtwPricesIncludeTax: 'TRUE', allowNegativeStock: 'FALSE' } });
  book.addContact({ id: 'CUS-00001', kind: 'CUSTOMER', name: 'Ayesha', phone: '923001234567' });
  book.addContact({ id: 'CUS-00002', kind: 'CUSTOMER', name: 'Sana', phone: '923211234567' });
  book.addContact({ id: 'VEN-00001', kind: 'VENDOR', vendorType: 'SUPPLIER', name: 'Registered fabric house', strn: '32-77-8761-123-45', filerStatus: 'FILER', whtTaxCodeId: 'TEST-WHT-GOODS-4.5' });
  book.addContact({ id: 'VEN-00002', kind: 'VENDOR', vendorType: 'SUPPLIER', name: 'Unregistered trims shop' });
  book.addContact({ id: 'VEN-00003', kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Embroidery karigar', filerStatus: 'FILER', whtTaxCodeId: 'TEST-WHT-SVC-10' });
  book.addContact({ id: 'VEN-00004', kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Stitching karigar' });
  book.addContact({ id: 'VEN-00005', kind: 'VENDOR', vendorType: 'SERVICE', name: 'Landlord' });
  book.addContact({ id: 'VEN-00006', kind: 'VENDOR', vendorType: 'KARIGAR', name: 'RTW stitching unit' });
  book.addContact({ id: 'FAM-001', kind: 'FAMILY', name: 'Family member' });
  book.addItem({ id: 'FAB-0001', category: 'FABRIC', name: 'Silk organza', unit: 'M' });
  book.addItem({ id: 'TRM-0001', category: 'TRIM', name: 'Dabka', unit: 'G' });
  for (const id of ['SKU-A', 'SKU-B', 'SKU-C']) book.addItem({ id: id, category: 'SKU', name: id, taxCodeId: 'TEST-ST-18' });
  book.addJob({
    id: 'JOB-2026-00001', type: 'MTO_ORDER', contactId: 'CUS-00001', title: 'Bridal lehenga', quotedPricePaisa: rs('500,000'),
    taxCodeId: 'TEST-ST-18', bookedDate: D.T01, promisedDate: '2026-12-01', revenueAccount: '4010',
    lines: [{ description: 'Bridal lehenga, red, with dupatta', qty: 1, unitPricePaisa: rs('500,000'), discountPaisa: 0 }],
  });
  book.addJob({
    id: 'JOB-2026-00002', type: 'MTO_ORDER', contactId: 'CUS-00002', title: 'Formal suit', quotedPricePaisa: rs('150,000'),
    taxCodeId: 'TEST-ST-18', bookedDate: D.T04, promisedDate: '2026-11-15', revenueAccount: '4020',
    lines: [{ description: 'Formal suit', qty: 1, unitPricePaisa: rs('150,000'), discountPaisa: 0 }],
  });
  book.addJob({ id: 'JOB-2026-00003', type: 'RTW_BATCH', title: 'Mirae winter batch', bookedDate: D.T08, collection: 'Winter 26' });
  book.sequences['JOB-2026'] = 4;
  return book;
}

// Each step posts the documents for one scenario and returns what tests check.
const steps = {
  T01(book) {
    return book.post('receiveAdvance', { date: D.T01, jobId: 'JOB-2026-00001', amountPaisa: rs('300,000'), moneyAccountCode: '1100' });
  },
  T02(book) {
    const a = book.post('createBill', {
      date: D.T02, contactId: 'VEN-00001', vendorRef: 'FH-901',
      lines: [{ lineKind: 'STOCK', itemId: 'FAB-0001', qty: 50, unitCostPaisa: rs('2,000'), taxCodeId: 'TEST-ST-IN-18' }],
    });
    const b = book.post('createBill', {
      date: D.T02, contactId: 'VEN-00002', vendorRef: 'TS-17',
      lines: [{ lineKind: 'STOCK', itemId: 'TRM-0001', qty: 1000, unitCostPaisa: rs('30') }],
    });
    return { a, b };
  },
  T03(book) {
    return book.post('issueStock', { date: D.T03, jobId: 'JOB-2026-00001', lines: [{ itemId: 'FAB-0001', qty: 12 }, { itemId: 'TRM-0001', qty: 400 }] });
  },
  T04(book) {
    const purchase = book.post('createBill', {
      date: D.T04, contactId: 'VEN-00002', lines: [{ lineKind: 'STOCK', itemId: 'FAB-0001', qty: 30, unitCostPaisa: rs('2,400') }],
    });
    const afterPurchase = Object.assign({}, book.itemBalances['FAB-0001']);
    const issue = book.post('issueStock', { date: D.T04, jobId: 'JOB-2026-00002', lines: [{ itemId: 'FAB-0001', qty: 10 }] });
    const afterIssue = Object.assign({}, book.itemBalances['FAB-0001']);
    const ret = book.post('returnStock', { date: D.T04, jobId: 'JOB-2026-00002', issueMoveId: issue.stockMoves[0].id, qty: 2 });
    return { purchase, afterPurchase, issue, afterIssue, ret };
  },
  T05(book) {
    const emb = book.post('karigarWork', { date: D.T05, contactId: 'VEN-00003', jobId: 'JOB-2026-00001', costComponent: 'EMBROIDERY', pieces: 40, ratePaisa: rs('2,000') });
    const stitch = book.post('karigarWork', { date: D.T05, contactId: 'VEN-00004', jobId: 'JOB-2026-00001', costComponent: 'STITCHING', pieces: 1, ratePaisa: rs('15,000') });
    const payKarigar = book.post('payBills', {
      date: D.T05, contactId: 'VEN-00003', moneyAccountCode: '1100', allocations: [{ billId: emb.doc.id, amountPaisa: rs('80,000') }],
    });
    const fabricBill = Object.values(book.bills).find((b) => b.contactId === 'VEN-00001');
    const paySupplier = book.post('payBills', {
      date: D.T05, contactId: 'VEN-00001', moneyAccountCode: '1100', allocations: [{ billId: fabricBill.id, amountPaisa: rs('118,000') }],
    });
    return { emb, stitch, payKarigar, paySupplier };
  },
  T06(book) {
    const delivery = book.post('deliverJob', { date: D.T06, jobId: 'JOB-2026-00001' });
    const payment = book.post('receivePayment', {
      date: D.T06, contactId: 'CUS-00001', moneyAccountCode: '1100', amountPaisa: rs('290,000'),
      allocations: [{ invoiceId: delivery.doc.id, amountPaisa: rs('290,000') }],
    });
    return { delivery, payment };
  },
  T07(book) {
    const rent = book.post('createBill', {
      date: D.T07, contactId: 'VEN-00005', vendorRef: 'OCT-RENT',
      lines: [
        { lineKind: 'EXPENSE', accountCode: '6020', brand: 'MIRAE', netPaisa: rs('150,000'), description: 'Store rent' },
        { lineKind: 'EXPENSE', accountCode: '6030', brand: 'UMSHA', netPaisa: rs('100,000'), description: 'Studio rent' },
        { lineKind: 'EXPENSE', accountCode: '6040', brand: 'SHARED', netPaisa: rs('40,000'), description: 'Electricity' },
      ],
    });
    const shoot = book.post('createExpense', {
      date: D.T07, moneyAccountCode: '1100', lines: [{ accountCode: '6100', brand: 'MIRAE', netPaisa: rs('45,000'), description: 'Photo shoot' }],
    });
    const drawings = book.post('createExpense', { date: D.T07, moneyAccountCode: '1030', contactId: 'FAM-001', isDrawings: true, amountPaisa: rs('20,000') });
    return { rent, shoot, drawings };
  },
  T08(book) {
    // "Assume WIP total 100,000 has been built up via issues and labour."
    const issue = book.post('issueStock', { date: D.T08, jobId: 'JOB-2026-00003', lines: [{ itemId: 'TRM-0001', qty: 200 }] });
    const labour = book.post('karigarWork', { date: D.T08, contactId: 'VEN-00006', jobId: 'JOB-2026-00003', costComponent: 'STITCHING', pieces: 47, ratePaisa: rs('2,000') });
    const payLabour = book.post('payBills', {
      date: D.T08, contactId: 'VEN-00006', moneyAccountCode: '1100', allocations: [{ billId: labour.doc.id, amountPaisa: rs('94,000') }],
    });
    const wipBefore = book.ctx().jobWip['JOB-2026-00003'];
    const complete = book.post('completeBatch', {
      date: D.T08, jobId: 'JOB-2026-00003',
      outputs: [{ itemId: 'SKU-A', qty: 10, weight: 1 }, { itemId: 'SKU-B', qty: 20, weight: 1 }, { itemId: 'SKU-C', qty: 3, weight: 2 }],
    });
    return { issue, labour, payLabour, wipBefore, complete };
  },
  T09(book) {
    return book.post('createSale', {
      date: D.T09, channel: 'STORE', store: 'MIRAE-KHI-01',
      lines: [{ itemId: 'SKU-A', qty: 1, unitPricePaisa: rs('9,440') }, { itemId: 'SKU-B', qty: 2, unitPricePaisa: rs('5,900') }],
      payments: [{ method: 'CASH', accountCode: '1020', amountPaisa: rs('10,000') }, { method: 'CARD', accountCode: '1210', amountPaisa: rs('11,240') }],
    });
  },
  T10(book, sale) {
    const lineB = book.sales[sale.doc.id].lines.find((l) => l.itemId === 'SKU-B');
    return book.post('returnSale', {
      date: D.T10, originalSaleId: sale.doc.id, lines: [{ saleLineId: lineB.id, qty: 1, restock: true }],
      refund: [{ method: 'CARD', accountCode: '1210', amountPaisa: rs('5,900') }],
    });
  },
  T11(book) {
    return book.post('postStockCount', { date: D.T11, lines: [{ itemId: 'SKU-A', countedQty: 8 }] });
  },
  T12(book) {
    const gross = rs('5,340');
    return book.post('settleCards', { date: D.T12, clearingCode: '1210', bankCode: '1100', grossPaisa: gross, feePaisa: Money.applyBps(gross, 200) });
  },
};

// Replay T01-T12 on a fresh book.
function runThroughT12() {
  const book = newScenarioBook();
  const r = {};
  for (const t of ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09']) r[t] = steps[t](book);
  r.T10 = steps.T10(book, r.T09);
  r.T11 = steps.T11(book);
  r.T12 = steps.T12(book);
  return { book, r };
}

module.exports = { D, newScenarioBook, steps, runThroughT12 };
