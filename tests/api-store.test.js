// Milestone M6 through the API: store sale (T09), return (T10), exchange,
// card settlement (T12), cash-up (R16), daily sales and store isolation.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSystem } = require('./helpers/gas.js');

const rs = (r) => Math.round(r * 100);

function sumLines(gas, jeId) {
  const out = {};
  gas.rows('JournalLines').filter((l) => l.jeId === jeId).forEach((l) => {
    const k = (l.debitPaisa ? 'Dr ' : 'Cr ') + l.accountCode + ' ' + l.brand;
    out[k] = (out[k] || 0) + (l.debitPaisa || l.creditPaisa);
  });
  return out;
}

// SKU-A x10 at Rs 2,777.78 and SKU-B x20 at Rs 2,777.78 (T08), SKU-C x3.
function setup() {
  const { gas, users } = createSystem();
  const ok = (r) => { assert.ok(r.ok, JSON.stringify(r)); return r.data; };
  const o = users.owner;
  const karigar = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Unit' })).contact;
  for (const x of ['A', 'B', 'C']) ok(gas.call(o, 'items.upsert', { id: 'SKU-' + x, category: 'SKU', name: 'Kurta ' + x, taxCodeId: 'ST-STD', salePricePaisa: rs(x === 'A' ? 9440 : 5900) }));
  const batch = ok(gas.call(users.studio, 'jobs.create', { type: 'RTW_BATCH', title: 'Run', lines: [{ itemId: 'SKU-A', qty: 10 }] })).job;
  ok(gas.call(users.studio, 'karigar.logWork', { contactId: karigar.id, jobId: batch.id, date: '2026-10-08', costComponent: 'STITCHING', pieces: 1, ratePaisa: rs(100000) }));
  ok(gas.call(users.studio, 'jobs.completeBatch', { jobId: batch.id, date: '2026-10-08', outputs: [{ itemId: 'SKU-A', qty: 10 }, { itemId: 'SKU-B', qty: 20 }, { itemId: 'SKU-C', qty: 3, weight: 2 }] }));
  const ayesha = ok(gas.call(users.store, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Ayesha', phone: '0300 1234567' })).contact;
  return { gas, users, ok, ayesha };
}

const T09 = (contactId) => ({
  date: '2026-10-09', channel: 'STORE', contactId,
  lines: [{ itemId: 'SKU-A', qty: 1, unitPricePaisa: rs(9440) }, { itemId: 'SKU-B', qty: 2, unitPricePaisa: rs(5900) }],
  payments: [{ method: 'CASH', accountCode: '1020', amountPaisa: rs(10000) }, { method: 'CARD', accountCode: '1210', amountPaisa: rs(11240) }],
});

describe('store through the API (M6)', () => {
  test('T09 sale, T10 return, T12 settlement, receipts', () => {
    const { gas, users, ok, ayesha } = setup();
    const sale = ok(gas.call(users.store, 'sale.create', T09(ayesha.id)));
    assert.deepEqual(sumLines(gas, sale.jeId), {
      'Dr 1020 MIRAE': rs(10000), 'Dr 1210 MIRAE': rs(11240), 'Cr 4100 MIRAE': rs(18000), 'Cr 2200 MIRAE': rs(3240),
      'Dr 5100 MIRAE': 833334, 'Cr 1340 MIRAE': 833334,
    });
    const row = gas.rows('Sales')[0];
    assert.deepEqual([row.kind, row.store, row.grossPaisa, row.pricesIncludeTax], ['SALE', 'MIRAE-KHI-01', rs(21240), true]);
    const lines = gas.rows('SaleLines');
    assert.deepEqual(lines.map((l) => [l.itemId, l.netPaisa, l.taxPaisa, l.costPaisa]), [['SKU-A', rs(8000), rs(1440), 277778], ['SKU-B', rs(10000), rs(1800), 555556]]);
    const receipt = ok(gas.call(users.store, 'receipts.render', { docType: 'SALE', docId: sale.saleId }));
    assert.equal(receipt.title, 'Sale receipt');
    assert.deepEqual(receipt.lines.map((l) => l.amountPaisa), [rs(9440), rs(11800)]);
    assert.ok(receipt.whatsappUrl.startsWith('https://wa.me/923001234567'));

    const lineB = lines.find((l) => l.itemId === 'SKU-B');
    const ret = ok(gas.call(users.store, 'sale.return', { originalSaleId: sale.saleId, date: '2026-10-10', lines: [{ saleLineId: lineB.id, qty: 1, restock: true }], refund: [{ method: 'CARD', accountCode: '1210', amountPaisa: rs(5900) }] }));
    assert.deepEqual(sumLines(gas, ret.jeId), { 'Dr 4900 MIRAE': rs(5000), 'Dr 2200 MIRAE': rs(900), 'Cr 1210 MIRAE': rs(5900), 'Dr 1340 MIRAE': 277778, 'Cr 5100 MIRAE': 277778 });
    assert.equal(gas.rows('SaleLines').find((l) => l.id === lineB.id).returnedQty, 1);
    assert.equal(gas.call(users.store, 'sale.return', { originalSaleId: sale.saleId, date: '2026-10-10', lines: [{ saleLineId: lineB.id, qty: 2 }], refund: [] }).code, 'E_VALIDATION');
    const refund = ok(gas.call(users.store, 'receipts.render', { docType: 'SALE', docId: ret.saleId }));
    assert.equal(refund.title, 'Refund');

    // T12: settle the clearing balance, 2% fee
    assert.equal(gas.call(users.store, 'settlements.create', {}).code, 'E_ROLE');
    const st = ok(gas.call(users.finance, 'settlements.create', { date: '2026-10-12', clearingCode: '1210', bankCode: '1100', grossPaisa: rs(5340), feePaisa: rs(106.8) }));
    assert.deepEqual(sumLines(gas, st.jeId), { 'Dr 1100 SHARED': rs(5233.2), 'Dr 6210 MIRAE': rs(106.8), 'Cr 1210 SHARED': rs(5340) });
    const clearing = ok(gas.call(users.finance, 'ledger.account', { accountCode: '1210' }));
    assert.equal(clearing.closingPaisa, 0);
  });

  test('exchange moves only the difference', () => {
    const { gas, users, ok } = setup();
    const sale = ok(gas.call(users.store, 'sale.create', T09('')));
    const lineB = gas.rows('SaleLines').find((l) => l.itemId === 'SKU-B');
    const x = ok(gas.call(users.store, 'sale.exchange', {
      originalSaleId: sale.saleId, date: '2026-10-10', returnLines: [{ saleLineId: lineB.id, qty: 1, restock: true }],
      newLines: [{ itemId: 'SKU-A', qty: 1, unitPricePaisa: rs(9440) }], payments: [{ method: 'CASH', accountCode: '1020', amountPaisa: rs(3540) }],
    }));
    const s = sumLines(gas, x.jeId);
    assert.equal(s['Dr 1020 MIRAE'], rs(3540));
    assert.equal(s['Cr 4100 MIRAE'], rs(8000));
    assert.equal(s['Dr 4900 MIRAE'], rs(5000));
    assert.equal(gas.rows('Sales').find((r) => r.id === x.saleId).kind, 'EXCHANGE');
    assert.equal(gas.rows('SaleLines').filter((l) => l.saleId === x.saleId && l.originalLineId === lineB.id).length, 1);
  });

  test('cash-up: expected from the ledger, over/short posted, once a day; daily sales by method', () => {
    const { gas, users, ok } = setup();
    ok(gas.call(users.store, 'sale.create', T09('')));
    const pre = ok(gas.call(users.store, 'cashup.preview', { date: '2026-10-09' }));
    assert.deepEqual([pre.expectedCashPaisa, pre.expectedCardPaisa, pre.store], [rs(10000), rs(11240), 'MIRAE-KHI-01']);
    const c = ok(gas.call(users.store, 'cashup.submit', { date: '2026-10-09', countedCashPaisa: rs(9950), notes: 'Short Rs 50' }));
    assert.equal(c.diffPaisa, -rs(50));
    assert.deepEqual(sumLines(gas, c.jeId), { 'Dr 6810 MIRAE': rs(50), 'Cr 1020 MIRAE': rs(50) });
    assert.equal(gas.call(users.store, 'cashup.submit', { date: '2026-10-09', countedCashPaisa: rs(9950) }).code, 'E_VALIDATION');
    const day = ok(gas.call(users.store, 'reports.dailySales', { date: '2026-10-09', store: 'MIRAE-KHI-01' }));
    assert.deepEqual(day.byMethod, { CASH: rs(10000), CARD: rs(11240) });
    assert.deepEqual([day.totals.transactions, day.totals.netPaisa, day.totals.costPaisa], [1, rs(18000), undefined]);
    assert.equal(gas.call(users.store, 'reports.dailySales', { date: '2026-10-09', store: 'MIRAE-LHR-01' }).code, 'E_ROLE');
    const fin = ok(gas.call(users.finance, 'reports.dailySales', { date: '2026-10-09' }));
    assert.equal(fin.totals.costPaisa, 833334);
  });

  test("a store cannot see or refund another store's sales", () => {
    const { gas, users, ok } = setup();
    const sale = ok(gas.call(users.finance, 'sale.create', Object.assign(T09(''), { store: 'MIRAE-LHR-01' })));
    assert.equal(gas.call(users.store, 'sales.get', { id: sale.saleId }).code, 'E_ROLE');
    assert.equal(ok(gas.call(users.store, 'sales.list', { date: '2026-10-09' })).length, 0);
    const line = gas.rows('SaleLines')[0];
    assert.equal(gas.call(users.store, 'sale.return', { originalSaleId: sale.saleId, date: '2026-10-10', lines: [{ saleLineId: line.id, qty: 1 }], refund: [] }).code, 'E_ROLE');
  });

  test('store staff cannot sell more than is in stock', () => {
    const { gas, users } = setup();
    const r = gas.call(users.store, 'sale.create', { date: '2026-10-09', lines: [{ itemId: 'SKU-C', qty: 4, unitPricePaisa: 100 }], payments: [{ method: 'CASH', accountCode: '1020', amountPaisa: 400 }] });
    assert.equal(r.code, 'E_NEG_STOCK');
  });
});
