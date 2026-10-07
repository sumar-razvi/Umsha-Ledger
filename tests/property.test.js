// T22: post 500 random valid documents across every document type, with
// random dates in open periods. After each one: the entry balances, every
// line has a brand, no item goes negative, the trial balance nets to zero
// and ItemBalances equals a full rebuild from StockMoves. Control accounts
// are reconciled to their sub-ledgers along the way and at the end.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rs, Reports, Inventory, Money, Validate } = require('./helpers/book.js');
const { newScenarioBook } = require('./helpers/scenario.js');

const TARGET = 500;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runProperty(seed) {
  const rand = mulberry32(seed);
  const int = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const chance = (p) => rand() < p;
  const date = () => '2026-' + String(int(7, 12)).padStart(2, '0') + '-' + String(int(1, 28)).padStart(2, '0');
  const money = (maxRupees) => int(1, maxRupees) * 100 + (chance(0.5) ? int(0, 99) : 0);

  const book = newScenarioBook();
  book.periods.push({ id: '2026-06', status: 'CLOSED' });
  book.addItem({ id: 'FAB-0002', category: 'FABRIC', name: 'Raw silk', unit: 'M' });
  book.addItem({ id: 'TRM-0002', category: 'TRIM', name: 'Sequins', unit: 'G' });
  book.addItem({ id: 'PKG-0001', category: 'PACKAGING', name: 'Garment bag' });
  book.addItem({ id: 'SKU-D', category: 'SKU', name: 'SKU-D', taxCodeId: 'TEST-ST-18' });
  const raw = ['FAB-0001', 'FAB-0002', 'TRM-0001', 'TRM-0002', 'PKG-0001'];
  const skus = ['SKU-A', 'SKU-B', 'SKU-C', 'SKU-D'];
  const vendors = ['VEN-00001', 'VEN-00002', 'VEN-00003', 'VEN-00004', 'VEN-00005', 'VEN-00006'];
  const karigars = ['VEN-00003', 'VEN-00004', 'VEN-00006'];
  const expenseAccounts = ['6010', '6020', '6030', '6040', '6100', '6200', '6300', '6800', '1600', '1700'];
  const components = ['FABRIC', 'TRIMS', 'EMBROIDERY', 'STITCHING', 'OUTSOURCED', 'PACKAGING', 'OTHER'];
  const brands = ['UMSHA', 'MIRAE', 'SHARED'];
  const moneyAccounts = ['1010', '1020', '1030', '1100', '1101', '1120'];

  const openJobs = (type) => Object.values(book.jobs).filter((j) => (!type || j.type === type) && ['OPEN', 'IN_PRODUCTION', 'READY'].includes(j.status));
  const costJobs = () => Object.values(book.jobs).filter((j) => j.status !== 'CANCELLED' && !(j.type === 'RTW_BATCH' && j.status === 'COMPLETED'));
  const qtyOf = (id) => (book.itemBalances[id] ? book.itemBalances[id].qty : 0);
  const balanceOf = (code) => Reports.accountBalances(book.lines)[code] || 0;

  function newMtoJob() {
    const lines = [];
    for (let i = 0; i < int(1, 3); i++) lines.push({ description: 'Piece ' + i, qty: int(1, 2), unitPricePaisa: money(300000), discountPaisa: chance(0.2) ? money(1000) : 0 });
    return book.addJob({
      type: 'MTO_ORDER', contactId: pick(['CUS-00001', 'CUS-00002']), title: 'Order', taxCodeId: pick(['TEST-ST-18', '', 'EXEMPT']),
      revenueAccount: pick(['4010', '4020', '4030']), lines: lines, bookedDate: '2026-07-01',
    });
  }

  const actions = {
    receiveAdvance() {
      const j = pick(openJobs('MTO_ORDER'));
      return j && { date: date(), jobId: j.id, amountPaisa: money(200000), moneyAccountCode: pick(moneyAccounts) };
    },
    createBill() {
      const lines = [];
      for (let i = 0; i < int(1, 3); i++) {
        const kind = pick(['STOCK', 'STOCK', 'JOB', 'EXPENSE']);
        const tax = pick(['', '', 'TEST-ST-IN-18', 'EXEMPT']);
        if (kind === 'STOCK') lines.push({ lineKind: 'STOCK', itemId: pick(raw), qty: int(1, 5000) / 100, unitCostPaisa: money(3000), taxCodeId: tax });
        else if (kind === 'JOB') {
          const j = pick(costJobs());
          if (j) lines.push({ lineKind: 'JOB', jobId: j.id, costComponent: pick(components), netPaisa: money(50000), taxCodeId: tax });
        } else lines.push({ lineKind: 'EXPENSE', accountCode: pick(expenseAccounts), brand: pick(brands), netPaisa: money(100000), taxCodeId: tax });
      }
      return lines.length && { date: date(), contactId: pick(vendors), lines };
    },
    karigarWork() {
      const j = pick(costJobs());
      return j && { date: date(), contactId: pick(karigars), jobId: j.id, costComponent: pick(['EMBROIDERY', 'STITCHING', 'OUTSOURCED']), pieces: int(1, 50), ratePaisa: money(3000) };
    },
    payBills() {
      const b = pick(Object.values(book.bills).filter((x) => x.status !== 'VOID' && x.grossPaisa - x.paidPaisa > 0));
      if (!b) return null;
      const left = b.grossPaisa - b.paidPaisa;
      return { date: date(), contactId: b.contactId, moneyAccountCode: pick(['1100', '1101', '1030']), allocations: [{ billId: b.id, amountPaisa: chance(0.5) ? left : int(1, left) }] };
    },
    createExpense() {
      return {
        date: date(), moneyAccountCode: pick(moneyAccounts), contactId: pick(['', '', 'VEN-00001', 'VEN-00003']),
        lines: [{ accountCode: pick(expenseAccounts), brand: pick(brands), netPaisa: money(50000), taxCodeId: pick(['', 'TEST-ST-IN-18']) }],
      };
    },
    recordDrawings() {
      return { date: date(), contactId: 'FAM-001', moneyAccountCode: pick(moneyAccounts), amountPaisa: money(50000) };
    },
    issueStock() {
      const j = pick(costJobs());
      const item = pick(raw.filter((id) => qtyOf(id) > 0));
      if (!j || !item) return null;
      const max = Inventory.toMilli(qtyOf(item));
      return { date: date(), jobId: j.id, lines: [{ itemId: item, qty: Inventory.fromMilli(chance(0.2) ? max : int(1, max)) }] };
    },
    returnStock() {
      const open = new Set(openJobs().map((j) => j.id));
      const issues = book.stockMoves.filter((m) => m.moveType === 'ISSUE' && open.has(m.jobId));
      const issue = pick(issues.filter((m) => {
        const back = book.stockMoves.filter((x) => x.sourceMoveId === m.id && x.moveType === 'RETURN_TO_STOCK').reduce((s, x) => s + Inventory.toMilli(x.qty), 0);
        return -Inventory.toMilli(m.qty) - back > 0;
      }));
      if (!issue) return null;
      const back = book.stockMoves.filter((x) => x.sourceMoveId === issue.id && x.moveType === 'RETURN_TO_STOCK').reduce((s, x) => s + Inventory.toMilli(x.qty), 0);
      const left = -Inventory.toMilli(issue.qty) - back;
      return { date: date(), jobId: issue.jobId, issueMoveId: issue.id, qty: Inventory.fromMilli(chance(0.4) ? left : int(1, left)) };
    },
    deliverJob() {
      const j = pick(openJobs('MTO_ORDER'));
      return j && { date: date(), jobId: j.id };
    },
    receivePayment() {
      const inv = pick(Object.values(book.invoices).filter((i) => i.status !== 'VOID' && i.balancePaisa > 0));
      if (!inv) return null;
      const amt = chance(0.5) ? inv.balancePaisa : int(1, inv.balancePaisa);
      return { date: date(), contactId: inv.contactId, moneyAccountCode: pick(moneyAccounts), amountPaisa: amt, allocations: [{ invoiceId: inv.id, amountPaisa: amt }] };
    },
    completeBatch() {
      const wip = book.ctx().jobWip;
      const j = pick(openJobs('RTW_BATCH').filter((x) => wip[x.id] && Object.values(wip[x.id]).reduce((a, b) => a + b, 0) > 0));
      if (!j) return null;
      const outs = skus.filter(() => chance(0.6));
      if (!outs.length) outs.push(pick(skus));
      return { date: date(), jobId: j.id, outputs: outs.map((id) => ({ itemId: id, qty: int(1, 40), weight: pick([1, 1, 1.5, 2]) })) };
    },
    createSale() {
      const avail = skus.filter((id) => qtyOf(id) >= 1);
      if (!avail.length) return null;
      const lines = avail.filter(() => chance(0.5)).slice(0, 2);
      if (!lines.length) lines.push(pick(avail));
      const saleLines = lines.map((id) => {
        const qty = int(1, Math.min(3, Math.floor(qtyOf(id))));
        const price = money(15000);
        return { itemId: id, qty, unitPricePaisa: price, discountPaisa: chance(0.2) ? int(0, price) : 0 };
      });
      const gross = saleLines.reduce((s, l) => s + Inventory.qtyTimesPaisa(l.qty, l.unitPricePaisa) - l.discountPaisa, 0);
      if (gross === 0) return null;
      const cash = chance(0.5) ? int(0, gross) : gross;
      const payments = [{ method: 'CASH', accountCode: '1020', amountPaisa: cash }, { method: 'CARD', accountCode: '1210', amountPaisa: gross - cash }].filter((p) => p.amountPaisa > 0);
      return { date: date(), channel: pick(['STORE', 'STORE', 'ONLINE', 'EXHIBITION']), lines: saleLines, payments };
    },
    returnSale() {
      const candidates = [];
      Object.values(book.sales).forEach((s) => {
        if (s.sale.kind !== 'SALE' || s.sale.status === 'VOID') return;
        s.lines.forEach((l) => { if (Inventory.toMilli(l.qty) - Inventory.toMilli(l.returnedQty || 0) > 0) candidates.push({ s, l }); });
      });
      const c = pick(candidates);
      if (!c) return null;
      const soldM = Inventory.toMilli(c.l.qty);
      const leftM = soldM - Inventory.toMilli(c.l.returnedQty || 0);
      const qm = chance(0.5) ? leftM : int(1, leftM / 1000) * 1000;
      const part = (total, done) => (qm === leftM ? total - (done || 0) : Money.divRoundHalfEven(BigInt(total) * BigInt(qm), soldM));
      const g = part(c.l.netPaisa, c.l.returnedNetPaisa) + part(c.l.taxPaisa, c.l.returnedTaxPaisa);
      const refund = g > 0 ? [{ method: 'CASH', accountCode: pick(['1020', '1210', '2110']), amountPaisa: g }] : [];
      return { date: date(), originalSaleId: c.s.sale.id, lines: [{ saleLineId: c.l.id, qty: Inventory.fromMilli(qm), restock: chance(0.8) }], refund };
    },
    settleCards() {
      const bal = balanceOf('1210');
      if (bal <= 1) return null;
      const gross = chance(0.5) ? bal : int(2, bal);
      return { date: date(), clearingCode: '1210', bankCode: '1100', grossPaisa: gross, feePaisa: Money.applyBps(gross, 200) };
    },
    transfer() {
      const from = pick(moneyAccounts);
      const to = pick(moneyAccounts.filter((c) => c !== from));
      return { date: date(), fromCode: from, toCode: to, amountPaisa: money(100000) };
    },
    postStockCount() {
      const id = pick(raw.concat(skus));
      const q = Inventory.toMilli(qtyOf(id));
      const counted = Math.max(0, q + int(-3000, 3000));
      return { date: date(), lines: [{ itemId: id, countedQty: Inventory.fromMilli(id.startsWith('SKU') ? Math.round(counted / 1000) * 1000 : counted) }] };
    },
    cashUp() {
      const expected = balanceOf('1020');
      return { date: date(), cashAccountCode: '1020', expectedCashPaisa: expected, countedCashPaisa: Math.max(0, expected + int(-500, 500)) };
    },
    cancelJob() {
      const j = pick(openJobs());
      if (!j) return null;
      const held = Math.max(0, book.ctx().jobAdvances[j.id] || 0);
      return { date: date(), jobId: j.id, refundPaisa: held ? int(0, held) : 0, moneyAccountCode: '1100', wipTreatment: pick(['RETURN', 'WRITE_OFF']) };
    },
    reverseEntry() {
      const je = pick(book.journalOrder.filter((id) => {
        const j = book.journals[id].journal;
        return !j.reversesJeId && !j.reversedByJeId && !j.isClosing;
      }));
      return je && { date: date(), jeId: je, reason: 'Random reversal' };
    },
    depositWht() {
      const bal = -balanceOf('2210');
      return bal > 0 && { date: date(), amountPaisa: chance(0.5) ? bal : int(1, bal), bankCode: '1100' };
    },
    settleSalesTax() {
      return { date: date(), outputPaisa: money(5000), inputPaisa: money(3000), bankCode: '1100' };
    },
  };

  // Rejections the generator can legitimately run into (its inputs are
  // random). Anything else is a bug.
  const EXPECTED_REJECTIONS = [
    ['E_NEG_STOCK', /Not enough stock/],
    ['E_VALIDATION', /already been used|Reverse the payments first|cannot be reversed|has been reversed|is itself a reversal|already been reversed/],
    ['E_OVERPAY', /left to pay|is held as advance/],
    ['E_JOB_CLOSED', /cancelled|completed|delivered/],
  ];

  const weights = {
    receiveAdvance: 6, createBill: 10, karigarWork: 6, payBills: 7, createExpense: 4, recordDrawings: 2, issueStock: 8, returnStock: 3,
    deliverJob: 3, receivePayment: 4, completeBatch: 3, createSale: 9, returnSale: 3, settleCards: 3, transfer: 2, postStockCount: 3,
    cashUp: 2, cancelJob: 1, reverseEntry: 3, depositWht: 1, settleSalesTax: 1,
  };
  const bag = Object.entries(weights).flatMap(([k, w]) => Array(w).fill(k));

  const counts = {};
  let posted = 0;
  let rejected = 0;
  let debits = 0;
  let credits = 0;
  let attempts = 0;
  while (posted < TARGET) {
    assert.ok(attempts++ < TARGET * 10, 'generator stalled');
    if (openJobs('MTO_ORDER').length < 3) newMtoJob();
    if (openJobs('RTW_BATCH').length < 1) book.addJob({ type: 'RTW_BATCH', title: 'Batch', bookedDate: '2026-07-01' });
    const name = pick(bag);
    const input = actions[name]();
    if (!input) continue;
    let result;
    try {
      result = book.post(name, input);
    } catch (e) {
      const ok = EXPECTED_REJECTIONS.some(([c, re]) => e.code === c && re.test(e.message));
      if (!ok) throw new Error('Unexpected failure in ' + name + ' ' + JSON.stringify(input) + ': ' + (e.code || '') + ' ' + e.message + '\n' + e.stack);
      rejected++;
      continue;
    }
    posted++;
    counts[name] = (counts[name] || 0) + 1;

    for (const l of result.lines) {
      assert.ok(Validate.BRANDS.includes(l.brand), 'line without brand');
      debits += l.debitPaisa;
      credits += l.creditPaisa;
    }
    const t = result.lines.reduce((s, l) => s + l.debitPaisa - l.creditPaisa, 0);
    assert.equal(t, 0, name + ' entry unbalanced');
    assert.equal(debits, credits, 'trial balance does not net to zero after ' + name);
    for (const b of Object.values(book.itemBalances)) assert.ok(b.qty >= 0, 'negative stock of ' + b.itemId + ' after ' + name);
    assert.deepEqual(book.itemBalances, Inventory.rebuildItemBalances(book.stockMoves), 'ItemBalances drifted from StockMoves after ' + name);
    if (posted % 50 === 0 || posted === TARGET) {
      for (const c of Reports.integrityChecks(book.lines, book.stockMoves, book.acc, book.items)) {
        assert.ok(c.ok, c.name + ' after ' + posted + ' documents: GL ' + c.glPaisa + ' vs ' + c.subledgerPaisa);
      }
      assert.ok(Reports.balanceSheet(book.lines, book.acc, {}).balanced, 'balance sheet does not balance');
    }
  }
  return { counts, rejected, book };
}

for (const seed of [1, 2026, 424242]) {
  test('T22 property: ' + TARGET + ' random valid documents (seed ' + seed + ')', () => {
    const { counts, rejected } = runProperty(seed);
    // Every document type was exercised.
    for (const name of ['receiveAdvance', 'createBill', 'karigarWork', 'payBills', 'createExpense', 'recordDrawings', 'issueStock', 'returnStock',
      'deliverJob', 'receivePayment', 'completeBatch', 'createSale', 'returnSale', 'settleCards', 'transfer', 'postStockCount', 'cashUp',
      'cancelJob', 'reverseEntry', 'depositWht', 'settleSalesTax']) {
      assert.ok(counts[name] > 0, name + ' never posted');
    }
    assert.ok(rejected < TARGET, 'too many rejected documents: ' + rejected);
  });
}

test('rs helper sanity', () => assert.equal(rs('1'), 100));
