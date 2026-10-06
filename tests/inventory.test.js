// core/inventory.js: weighted average in integer units, and the guarantee
// that live posting and a rebuild from StockMoves always agree.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const Inventory = require('../core/inventory.js');

describe('quantities in thousandths', () => {
  test('toMilli / fromMilli are exact to 3 places', () => {
    assert.equal(Inventory.toMilli(12.5), 12500);
    assert.equal(Inventory.toMilli('0.001'), 1);
    assert.equal(Inventory.toMilli(-10), -10000);
    assert.equal(Inventory.fromMilli(Inventory.toMilli(0.1) + Inventory.toMilli(0.2)), 0.3);
    assert.throws(() => Inventory.toMilli(1.0005), (e) => e.code === 'E_VALIDATION');
  });
  test('qtyTimesPaisa rounds half-even to the paisa', () => {
    assert.equal(Inventory.qtyTimesPaisa(50, 200000), 10000000);
    assert.equal(Inventory.qtyTimesPaisa(2.5, 3), 8); // 7.5 -> 8
    assert.equal(Inventory.qtyTimesPaisa(0.5, 5), 2); // 2.5 -> 2
  });
});

describe('stock ledger', () => {
  test('receive recomputes the average; issue at average leaves it', () => {
    const l = Inventory.createStockLedger({});
    l.receive('F', 50, 10000000, 'PURCHASE');
    l.issue('F', 12, 'ISSUE');
    l.receive('F', 30, 7200000, 'PURCHASE');
    assert.deepEqual(l.balance('F'), { itemId: 'F', qty: 68, avgCostMicro: 2176470588, valuePaisa: 14800000 });
    const m = l.issue('F', 10, 'ISSUE');
    assert.equal(m.valuePaisa, -2176471);
    assert.equal(l.balance('F').avgCostMicro, 2176470588);
  });

  test('taking quantity to exactly zero takes all remaining value', () => {
    const l = Inventory.createStockLedger({});
    l.receive('X', 3, 100, 'PURCHASE'); // 33.33 paisa each
    assert.equal(l.issue('X', 1, 'SALE').valuePaisa, -33);
    assert.equal(l.issue('X', 1, 'SALE').valuePaisa, -33);
    assert.equal(l.issue('X', 1, 'SALE').valuePaisa, -34);
    assert.deepEqual(l.balance('X'), { itemId: 'X', qty: 0, avgCostMicro: 333333, valuePaisa: 0 });
  });

  test('E_NEG_STOCK unless allowed', () => {
    const l = Inventory.createStockLedger({ X: { qty: 1, avgCostMicro: 1000000, valuePaisa: 100 } });
    assert.throws(() => l.issue('X', 2, 'SALE'), (e) => e.code === 'E_NEG_STOCK');
    const lax = Inventory.createStockLedger({ X: { qty: 1, avgCostMicro: 1000000, valuePaisa: 100 } }, { allowNegativeStock: 'TRUE' });
    assert.equal(lax.issue('X', 2, 'SALE').valuePaisa, -200);
    assert.equal(lax.balance('X').qty, -1);
  });

  test('removeAtCost refuses to leave stock with negative value', () => {
    const l = Inventory.createStockLedger({});
    l.receive('Y', 10, 1000, 'PURCHASE');
    l.receive('Y', 10, 9000, 'PURCHASE'); // avg 500
    l.issue('Y', 15, 'ISSUE'); // 7500 out, 5 left worth 2500
    assert.throws(() => l.removeAtCost('Y', 1, 9000), /already been used/); // 4 left worth -6500
  });

  test('removeAtCost hands back a negative residual too', () => {
    const l = Inventory.createStockLedger({});
    l.receive('Y', 10, 1000, 'PURCHASE');
    l.receive('Y', 10, 2000, 'PURCHASE'); // avg 150
    l.issue('Y', 10, 'ISSUE'); // 1500 out, 10 left worth 1500
    assert.equal(l.removeAtCost('Y', 10, 2000).residualPaisa, -500);
    assert.equal(l.balance('Y').valuePaisa, 0);
  });

  test('removeAtCost residual when qty hits zero with value left', () => {
    const l = Inventory.createStockLedger({});
    l.receive('Z', 10, 1000, 'PURCHASE');
    l.receive('Z', 10, 3000, 'PURCHASE'); // avg 200
    l.issue('Z', 10, 'ISSUE'); // 2000 out, 10 left worth 2000
    const r = l.removeAtCost('Z', 10, 1000); // reverse the first purchase
    assert.equal(r.residualPaisa, 1000);
    assert.deepEqual(l.balance('Z'), { itemId: 'Z', qty: 0, avgCostMicro: 2000000, valuePaisa: 0 });
  });

  test('rebuildItemBalances replays moves to the same balances as live posting', () => {
    const l = Inventory.createStockLedger({});
    const moves = [];
    moves.push(l.receive('F', 50, 10000000, 'PURCHASE'));
    moves.push(l.issue('F', 12.25, 'ISSUE'));
    moves.push(l.receive('F', 30.5, 7200000, 'PURCHASE'));
    moves.push(l.issue('F', 10, 'ISSUE'));
    moves.push(l.receive('F', 2, 435294, 'RETURN_TO_STOCK'));
    const r = l.removeAtCost('F', 2, 435294);
    moves.push(r.move);
    moves.push(l.issue('F', Inventory.fromMilli(Inventory.toMilli(l.balance('F').qty)), 'SALE'));
    const rebuilt = Inventory.rebuildItemBalances(moves);
    assert.deepEqual(rebuilt.F, l.balance('F'));
    assert.deepEqual(l.updates(), [l.balance('F')]);
  });
});

describe('movement ledger (M5)', () => {
  test('running qty, value and average after each move, with an opening balance', () => {
    const l = Inventory.createStockLedger({});
    const moves = [];
    const tag = (m, date) => moves.push(Object.assign({ date, itemId: 'F' }, m));
    tag(l.receive('F', 50, 10000000, 'PURCHASE'), '2026-10-02');
    tag(l.issue('F', 12, 'ISSUE'), '2026-10-03');
    tag(l.receive('F', 30, 7200000, 'PURCHASE'), '2026-10-04');
    tag(l.issue('F', 10, 'ISSUE'), '2026-10-04');
    moves.push({ date: '2026-10-04', itemId: 'X', qty: 1, valuePaisa: 5, moveType: 'PURCHASE' });
    const r = Inventory.movementLedger(moves, 'F', { from: '2026-10-04' });
    assert.deepEqual(r.opening, { itemId: 'F', qty: 38, avgCostMicro: 2000000000, valuePaisa: 7600000 });
    assert.deepEqual(r.rows.map((x) => [x.moveType, x.qtyAfter, x.valueAfterPaisa, x.avgCostMicroAfter]), [
      ['PURCHASE', 68, 14800000, 2176470588],
      ['ISSUE', 58, 12623529, 2176470588],
    ]);
    assert.deepEqual(r.closing, l.balance('F'));
  });
});
