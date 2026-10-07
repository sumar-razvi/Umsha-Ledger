// Milestone M5 through the API: weighted average (T04), RTW batch
// completion (T08), stock count (T11), movement ledger and the valuation
// that reconciles to the GL.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSystem } = require('./helpers/gas.js');

const rs = (r) => Math.round(r * 100);

function setup() {
  const { gas, users } = createSystem();
  const ok = (r) => { assert.ok(r.ok, JSON.stringify(r)); return r.data; };
  const o = users.owner;
  const shop = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'SUPPLIER', name: 'Unregistered supplier' })).contact;
  const karigar = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Stitching unit' })).contact;
  const customer = ok(gas.call(o, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Sana' })).contact;
  const fabric = ok(gas.call(o, 'items.upsert', { category: 'FABRIC', name: 'Silk organza' })).item;
  const trim = ok(gas.call(o, 'items.upsert', { category: 'TRIM', name: 'Dabka', unit: 'G' })).item;
  const skus = ['A', 'B', 'C'].map((x) => ok(gas.call(o, 'items.upsert', { id: 'SKU-AYLA-' + x, category: 'SKU', name: 'Ayla ' + x, taxCodeId: 'ST-STD', salePricePaisa: rs(9440) })).item);
  return { gas, users, ok, shop, karigar, customer, fabric, trim, skus };
}

describe('inventory through the API (M5)', () => {
  test('T04: weighted average, issue and return at original cost, movement ledger', () => {
    const { gas, users, ok, shop, customer, fabric } = setup();
    ok(gas.call(users.finance, 'bills.create', { contactId: shop.id, date: '2026-10-02', lines: [{ lineKind: 'STOCK', itemId: fabric.id, qty: 38, unitCostPaisa: rs(2000) }] }));
    ok(gas.call(users.finance, 'bills.create', { contactId: shop.id, date: '2026-10-04', lines: [{ lineKind: 'STOCK', itemId: fabric.id, qty: 30, unitCostPaisa: rs(2400) }] }));
    const bal = gas.rows('ItemBalances').find((b) => b.itemId === fabric.id);
    assert.deepEqual([bal.qty, bal.valuePaisa, bal.avgCostMicro], [68, rs(148000), 2176470588]);
    const job = ok(gas.call(users.studio, 'jobs.create', { type: 'MTO_ORDER', contactId: customer.id, title: 'Suit', lines: [{ description: 'Suit', unitPricePaisa: rs(150000) }] })).job;
    const issue = ok(gas.call(users.studio, 'jobs.issueStock', { jobId: job.id, date: '2026-10-04', lines: [{ itemId: fabric.id, qty: 10 }] }));
    assert.equal(issue.valuePaisa, 2176471);
    const detail = ok(gas.call(users.studio, 'jobs.get', { id: job.id }));
    assert.deepEqual(detail.issues.map((i) => [i.itemId, i.qty, i.valuePaisa, i.returnableQty]), [[fabric.id, 10, 2176471, 10]]);
    ok(gas.call(users.studio, 'jobs.returnStock', { jobId: job.id, date: '2026-10-04', issueMoveId: detail.issues[0].moveId, qty: 2 }));
    assert.equal(ok(gas.call(users.studio, 'jobs.get', { id: job.id })).issues[0].returnableQty, 8);
    const ret = gas.rows('StockMoves').find((m) => m.moveType === 'RETURN_TO_STOCK');
    assert.deepEqual([ret.valuePaisa, ret.sourceMoveId], [435294, detail.issues[0].moveId]);
    const led = ok(gas.call(users.viewer, 'stock.movements', { itemId: fabric.id }));
    assert.deepEqual(led.rows.map((r) => [r.moveType, r.qtyAfter, r.valueAfterPaisa]), [
      ['PURCHASE', 38, rs(76000)], ['PURCHASE', 68, rs(148000)], ['ISSUE', 58, 12623529], ['RETURN_TO_STOCK', 60, 12623529 + 435294],
    ]);
  });

  test('T08: RTW batch from issues and labour, completed with weights; T11 count; valuation reconciles', () => {
    const { gas, users, ok, shop, karigar, trim, skus } = setup();
    ok(gas.call(users.finance, 'bills.create', { contactId: shop.id, date: '2026-10-02', lines: [{ lineKind: 'STOCK', itemId: trim.id, qty: 1000, unitCostPaisa: rs(30) }] }));
    const batch = ok(gas.call(users.studio, 'jobs.create', { type: 'RTW_BATCH', title: 'Winter 26', collection: 'Winter 26', lines: skus.map((x) => ({ itemId: x.id, qty: 10 })) })).job;
    assert.equal(batch.brand, 'MIRAE');
    ok(gas.call(users.studio, 'jobs.issueStock', { jobId: batch.id, date: '2026-10-08', lines: [{ itemId: trim.id, qty: 200 }] }));
    ok(gas.call(users.studio, 'karigar.logWork', { contactId: karigar.id, jobId: batch.id, date: '2026-10-08', costComponent: 'STITCHING', pieces: 47, ratePaisa: rs(2000) }));
    const done = ok(gas.call(users.studio, 'jobs.completeBatch', {
      jobId: batch.id, date: '2026-10-08',
      outputs: [{ itemId: skus[0].id, qty: 10, weight: 1 }, { itemId: skus[1].id, qty: 20, weight: 1 }, { itemId: skus[2].id, qty: 3, weight: 2 }],
    }));
    assert.deepEqual(done.outputs.map((x) => x.costPaisa), [2777778, 5555556, 1666666]);
    assert.equal(gas.rows('Jobs').find((j) => j.id === batch.id).status, 'COMPLETED');
    const bA = gas.rows('ItemBalances').find((b) => b.itemId === skus[0].id);
    assert.equal(bA.avgCostMicro, 2777778000);
    assert.equal(gas.call(users.studio, 'jobs.completeBatch', { jobId: batch.id, date: '2026-10-08', outputs: [{ itemId: skus[0].id, qty: 1 }] }).code, 'E_JOB_CLOSED');

    // T11: counted 9 of SKU-A's 10: shortfall of one at average cost; counted 21 of B: a surplus
    const count = ok(gas.call(users.store, 'stock.count.post', { date: '2026-10-11', location: 'MIRAE-KHI-01', lines: [{ itemId: skus[0].id, countedQty: 9 }, { itemId: skus[1].id, countedQty: 21 }, { itemId: skus[2].id, countedQty: 3 }] }));
    assert.deepEqual(count.lines.map((l) => [l.systemQty, l.countedQty, l.diffQty, l.valuePaisa]), [[10, 9, -1, -277778], [20, 21, 1, 277778], [3, 3, 0, 0]]);
    const je = gas.rows('JournalLines').filter((l) => l.jeId === count.jeId).map((l) => [l.accountCode, l.brand, l.debitPaisa, l.creditPaisa]);
    assert.deepEqual(je, [['5900', 'MIRAE', 277778, 0], ['1340', 'MIRAE', 0, 277778], ['1340', 'MIRAE', 277778, 0], ['5900', 'MIRAE', 0, 277778]]);
    assert.equal(gas.rows('StockCountLines').length, 3);
    assert.equal(gas.rows('StockCounts')[0].status, 'POSTED');

    const val = ok(gas.call(users.viewer, 'stock.valuation', { asOf: '2026-10-31' }));
    assert.ok(val.reconciled, JSON.stringify(val.rows));
    assert.equal(val.rows.find((r) => r.systemKey === 'INV_FG').stockPaisa, rs(100000));
    assert.equal(val.rows.find((r) => r.systemKey === 'INV_TRIMS').glPaisa, rs(24000));
    assert.equal(gas.call(users.store, 'stock.valuation', {}).code, 'E_ROLE');
  });
});
