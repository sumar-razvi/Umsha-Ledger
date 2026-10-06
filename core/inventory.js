// core/inventory.js: stock quantities and weighted-average cost.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.
//
// Units (docs/03-accounting-rules.md, Rounding; decision D-19):
//   qty            decimal with up to 3 places at the edges (12.5 m), held
//                  internally as integer thousandths (qtyMilli) so sums never drift
//   valuePaisa     exact stock value, the figure that must equal the GL
//   avgCostMicro   paisa x 10,000 per unit (Rs 2,176.470588 -> 2,176,470,588)
//
// Rules, shared by live posting and by rebuildItemBalances so they always agree:
//   - A move adds its qty and value to the item.
//   - Inbound moves (qty > 0) recompute the average from value / qty.
//     So does a REVERSAL that takes stock out at its original cost.
//   - Outbound moves at the average leave it unchanged.
//   - An outbound move that takes qty to exactly zero carries the item's whole
//     remaining value, so no paisa are stranded in stock.

const Money = require('./money.js');
const Validate = require('./validate.js');

const QTY_PLACES = 3;
const QTY_SCALE = 1000;
const MICRO = 10000; // avgCostMicro = paisa x MICRO per unit
const MICRO_PER_MILLI = 10000000n; // MICRO x QTY_SCALE

const ACCOUNT_KEY_BY_CATEGORY = { FABRIC: 'INV_FABRIC', TRIM: 'INV_TRIMS', PACKAGING: 'INV_PACKAGING', SKU: 'INV_FG' };
const COMPONENT_BY_CATEGORY = { FABRIC: 'FABRIC', TRIM: 'TRIMS', PACKAGING: 'PACKAGING' };
const INBOUND_TYPES = ['PURCHASE', 'RETURN_TO_STOCK', 'BATCH_OUTPUT', 'SALE_RETURN', 'OPENING'];

// 12.5 -> 12500. Throws E_VALIDATION for more than 3 decimal places.
function toMilli(qty) {
  return Money.scaleDecimal(qty, QTY_PLACES, 'qty');
}

// 12500 -> 12.5
function fromMilli(qtyMilli) {
  return qtyMilli / QTY_SCALE;
}

// Average cost of valuePaisa spread over qtyMilli.
function avgFrom(valuePaisa, qtyMilli) {
  return Money.divRoundHalfEven(BigInt(valuePaisa) * MICRO_PER_MILLI, qtyMilli);
}

// Value of qtyMilli at avgCostMicro, rounded to the paisa.
function valueAt(qtyMilli, avgCostMicro) {
  return Money.divRoundHalfEven(BigInt(qtyMilli) * BigInt(avgCostMicro), MICRO_PER_MILLI);
}

// qty x unit price in paisa, rounded to the paisa: qtyTimesPaisa(2.5, 200000) = 500000.
function qtyTimesPaisa(qty, unitPaisa) {
  Money.assertPaisa(unitPaisa, 'unitPrice');
  return Money.divRoundHalfEven(BigInt(toMilli(qty)) * BigInt(unitPaisa), QTY_SCALE);
}

function itemBrand(item) {
  return item.category === 'SKU' ? 'MIRAE' : 'SHARED';
}

function emptyState() {
  return { qtyMilli: 0, valuePaisa: 0, avgCostMicro: 0 };
}

function stateFromBalance(b) {
  if (!b) return emptyState();
  return {
    qtyMilli: toMilli(b.qty || 0),
    valuePaisa: Number(b.valuePaisa || 0),
    avgCostMicro: Number(b.avgCostMicro || 0),
  };
}

function balanceFromState(itemId, s) {
  return { itemId: itemId, qty: fromMilli(s.qtyMilli), avgCostMicro: s.avgCostMicro, valuePaisa: s.valuePaisa };
}

// Apply one stock move to an item's state (mutates). The single source of
// truth for how moves change quantity, value and average.
function applyMove(state, move) {
  const qm = toMilli(move.qty);
  const v = move.valuePaisa;
  state.qtyMilli += qm;
  state.valuePaisa += v;
  const recompute = qm > 0 || (move.moveType === 'REVERSAL' && qm < 0);
  if (recompute) {
    if (state.qtyMilli > 0) state.avgCostMicro = avgFrom(state.valuePaisa, state.qtyMilli);
    else if (qm > 0) state.avgCostMicro = avgFrom(v, qm);
  }
  return state;
}

// Rebuild ItemBalances from StockMoves, in the order given (date, then id).
// Returns {itemId: {itemId, qty, avgCostMicro, valuePaisa}}.
function rebuildItemBalances(stockMoves) {
  const states = {};
  stockMoves.forEach(function (m) {
    if (!states[m.itemId]) states[m.itemId] = emptyState();
    applyMove(states[m.itemId], m);
  });
  const out = {};
  Object.keys(states).forEach(function (id) { out[id] = balanceFromState(id, states[id]); });
  return out;
}

// One item's movements in posting order, each with the running quantity,
// value and average after it (the item movement ledger, docs/06 Inventory).
// opts: {from, to} only filter what is returned; balances run from the first move.
function movementLedger(stockMoves, itemId, opts) {
  const o = opts || {};
  const st = emptyState();
  const rows = [];
  let opening = null;
  stockMoves.forEach(function (m) {
    if (m.itemId !== itemId) return;
    if (o.from && m.date < o.from) { applyMove(st, m); return; }
    if (opening === null) opening = balanceFromState(itemId, st);
    applyMove(st, m);
    if (o.to && m.date > o.to) return;
    rows.push(Object.assign({}, m, { qtyAfter: fromMilli(st.qtyMilli), valueAfterPaisa: st.valuePaisa, avgCostMicroAfter: st.avgCostMicro }));
  });
  return { itemId: itemId, opening: opening || balanceFromState(itemId, st), rows: rows, closing: balanceFromState(itemId, st) };
}

// A working copy of item balances for one entry. Each operation returns the
// stock move it made; updates() returns the new balances of touched items.
function createStockLedger(itemBalances, opts) {
  const balances = itemBalances || {};
  const allowNegative = Validate.isTrue((opts || {}).allowNegativeStock);
  const states = {};
  const moved = {};

  function state(itemId) {
    if (!states[itemId]) states[itemId] = stateFromBalance(balances[itemId]);
    return states[itemId];
  }

  function positiveMilli(qty) {
    const qm = toMilli(qty);
    if (qm <= 0) Validate.fail('E_VALIDATION', 'Quantity must be more than zero', 'qty');
    return qm;
  }

  function checkStock(itemId, s, qm) {
    if (qm > s.qtyMilli && !allowNegative) {
      Validate.fail('E_NEG_STOCK', 'Not enough stock of ' + itemId + ': have ' + fromMilli(s.qtyMilli) + ', need ' + fromMilli(qm), 'qty');
    }
  }

  function record(itemId, s, qm, valuePaisa, moveType) {
    const move = {
      itemId: itemId,
      qty: fromMilli(qm),
      valuePaisa: valuePaisa,
      unitCostMicro: qm === 0 ? 0 : avgFrom(Math.abs(valuePaisa), Math.abs(qm)),
      moveType: moveType,
    };
    applyMove(s, move);
    moved[itemId] = true;
    return move;
  }

  return {
    // Stock in at a known value (purchase, batch output, return at original cost).
    receive: function (itemId, qty, valuePaisa, moveType) {
      Money.assertPaisa(valuePaisa, 'value');
      if (valuePaisa < 0) Validate.fail('E_VALIDATION', 'Stock value cannot be negative', 'value');
      return record(itemId, state(itemId), positiveMilli(qty), valuePaisa, moveType);
    },
    // Stock out at weighted-average cost (issue, sale, shortfall).
    issue: function (itemId, qty, moveType) {
      const s = state(itemId);
      const qm = positiveMilli(qty);
      checkStock(itemId, s, qm);
      const value = qm === s.qtyMilli ? s.valuePaisa : valueAt(qm, s.avgCostMicro);
      return record(itemId, s, -qm, -value, moveType);
    },
    // Reverse an inbound move: stock out at its original cost (R22).
    // If that empties the item but leaves value behind, the leftover is
    // returned as `residualPaisa` and cleared, for the caller to post.
    removeAtCost: function (itemId, qty, valuePaisa) {
      const s = state(itemId);
      const qm = positiveMilli(qty);
      checkStock(itemId, s, qm);
      const move = record(itemId, s, -qm, -valuePaisa, 'REVERSAL');
      let residualPaisa = 0;
      if (s.qtyMilli === 0 && s.valuePaisa !== 0) {
        residualPaisa = s.valuePaisa;
        return { move: move, residualPaisa: residualPaisa, residualMove: record(itemId, s, 0, -residualPaisa, 'ADJUSTMENT') };
      }
      if (s.qtyMilli > 0 && s.valuePaisa < 0) {
        Validate.fail('E_VALIDATION', 'Cannot reverse: the stock of ' + itemId + ' has already been used. Post a stock adjustment instead.');
      }
      return { move: move, residualPaisa: 0, residualMove: null };
    },
    // Current working balance of an item.
    balance: function (itemId) {
      return balanceFromState(itemId, state(itemId));
    },
    // New balances of the items that moved (only those: reading a balance is not a change).
    updates: function () {
      return Object.keys(moved).sort().map(function (id) { return balanceFromState(id, states[id]); });
    },
  };
}

if (typeof module !== 'undefined') module.exports = {
  MICRO,
  ACCOUNT_KEY_BY_CATEGORY,
  COMPONENT_BY_CATEGORY,
  INBOUND_TYPES,
  toMilli,
  fromMilli,
  avgFrom,
  valueAt,
  qtyTimesPaisa,
  itemBrand,
  applyMove,
  rebuildItemBalances,
  movementLedger,
  createStockLedger,
};
