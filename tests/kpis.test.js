// Dashboard KPIs (M10, docs/10-dashboard-kpis.md): T23 on the state after
// T01-T12, T24 incremental MonthlySummary = full rebuild, periods, targets.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const Kpis = require('../core/kpis.js');
const Validate = require('../core/validate.js');
const { runThroughT12 } = require('./helpers/scenario.js');
const { Book, rs } = require('./helpers/book.js');

// Book documents -> the rows the server stores (as persistSale_ in Actions.gs).
function saleRows(book) {
  const sales = [];
  const lines = [];
  const pays = [];
  Object.values(book.sales).forEach(({ sale }) => {
    sales.push({ id: sale.id, date: sale.date, kind: sale.kind, status: sale.status, store: sale.store, channel: sale.channel || 'STORE', contactId: sale.contactId || '', netPaisa: sale.netPaisa, taxPaisa: sale.taxPaisa, grossPaisa: sale.grossPaisa });
    let n = 0;
    (sale.returnLines || (sale.kind === 'RETURN' ? sale.lines : [])).forEach((l) => {
      lines.push({ id: sale.id + '-' + ++n, saleId: sale.id, itemId: l.itemId, qty: -l.qty, netPaisa: -l.netPaisa, taxPaisa: -l.taxPaisa, costPaisa: -l.costPaisa });
    });
    if (sale.kind !== 'RETURN') (sale.lines || []).forEach((l) => lines.push(Object.assign({ id: sale.id + '-' + ++n, saleId: sale.id }, l)));
    (sale.payments || []).concat(sale.refund || []).forEach((p, i) => pays.push({ id: sale.id + '-p' + i, saleId: sale.id, method: p.method, accountCode: p.accountCode, amountPaisa: sale.kind === 'RETURN' ? -p.amountPaisa : p.amountPaisa }));
  });
  return { sales, lines, pays };
}

function dataFor(book) {
  const s = saleRows(book);
  const clearing = Object.values(book.acc.accountsByCode).filter((a) => a.isMoney && a.moneyKind === 'CLEARING' && a.systemKey !== 'STORE_CREDIT').map((a) => a.code);
  return {
    acc: book.acc,
    settings: book.settings,
    targets: [],
    monthly: Kpis.summarizeLines(book.lines),
    jobLines: book.lines.filter((l) => l.jobId),
    jobs: Object.values(book.jobs),
    invoices: Object.values(book.invoices),
    bills: Object.values(book.bills),
    payments: [],
    paymentAllocations: [],
    sales: s.sales,
    saleLines: s.lines,
    salePayments: s.pays,
    dailySales: Kpis.dailySalesRows(s.sales, s.lines, s.pays, clearing),
    items: Object.values(book.items),
    itemBalances: Object.values(book.itemBalances),
    stockMoves: book.stockMoves,
  };
}

const tileOf = (r, id) => r.tiles.find((t) => t.id === id);
const OCT = { today: '2026-10-31', period: 'CUSTOM', from: '2026-10-01', to: '2026-10-31', compareTo: 'NONE' };

describe('T23: KPIs on the state after T01-T12', () => {
  const { book } = runThroughT12();
  const data = dataFor(book);

  test('C4 average job margin is 73.8%', () => {
    const r = Kpis.dashboard(data, Object.assign({ tab: 'UMSHA' }, OCT));
    assert.equal(tileOf(r, 'C4').value, 7380);
    assert.equal(tileOf(r, 'C4').unit, 'bps');
    assert.equal(tileOf(r, 'C6').value, 10000, 'delivered before the promised date');
    assert.equal(tileOf(r, 'C3').value, rs('500,000'));
  });

  test('D2 transactions 1, D3 average sale Rs 18,000, D9 returns 27.78%', () => {
    const r = Kpis.dashboard(data, Object.assign({ tab: 'MIRAE' }, OCT));
    assert.equal(tileOf(r, 'D2').value, 1);
    assert.equal(tileOf(r, 'D3').value, rs('18,000'));
    assert.equal(tileOf(r, 'D9').value, 2778);
    assert.equal(tileOf(r, 'D1').value, rs('13,000'), 'net of the return');
    assert.equal(tileOf(r, 'D4').value, 300, '3 pieces in one sale (hundredths)');
  });

  test('daily sales rows: sale and return on their own dates', () => {
    assert.deepEqual(data.dailySales.map((d) => [d.date, d.netPaisa, d.returnsNetPaisa, d.transactions, d.units, d.costPaisa > 0]), [
      ['2026-10-09', rs('18,000'), 0, 1, 3, true],
      ['2026-10-10', 0, rs('5,000'), 0, 0, false],
    ]);
  });

  test('A4: advances held are 0 after T12, so coverage is n/a; after T01 it is a ratio', () => {
    const r = Kpis.dashboard(data, Object.assign({ tab: 'CASH' }, OCT));
    assert.equal(tileOf(r, 'A4').value, null);
    assert.equal(tileOf(r, 'A4').note, 'Advances held Rs 0');
    const { newScenarioBook, steps } = require('./helpers/scenario.js');
    const b = newScenarioBook();
    steps.T01(b);
    const r1 = Kpis.dashboard(dataFor(b), Object.assign({ tab: 'CASH' }, OCT));
    assert.equal(tileOf(r1, 'A4').value, 10000, 'Rs 300,000 in the bank against Rs 300,000 held = 1.00x');
    assert.equal(tileOf(r1, 'A1').value, rs('300,000'));
  });

  test('A4 with no advances held is n/a, not a divide-by-zero', () => {
    const empty = new Book();
    const d = dataFor(empty);
    for (const tab of ['OVERVIEW', 'CASH']) {
      const r = Kpis.dashboard(d, Object.assign({ tab }, OCT));
      assert.equal(tileOf(r, 'A4').value, null);
      assert.equal(tileOf(r, 'A4').rag, null);
    }
    // Every tab renders on an empty book without throwing or NaN.
    for (const tab of Kpis.TABS) {
      const r = Kpis.dashboard(d, Object.assign({ tab, role: 'OWNER' }, OCT));
      assert.ok(!/NaN|Infinity/.test(JSON.stringify(r)), tab);
    }
  });

  test('P&L tiles from MonthlySummary equal the same from lines', () => {
    const viaSummary = Kpis.dashboard(data, Object.assign({ tab: 'OVERVIEW' }, OCT));
    const viaLines = Kpis.dashboard(Object.assign({}, data, { lines: book.lines }), Object.assign({ tab: 'OVERVIEW' }, OCT, { to: '2026-10-30', today: '2026-10-31' }));
    for (const id of ['B1', 'B2', 'B4', 'A1']) assert.equal(tileOf(viaLines, id).value, tileOf(viaSummary, id).value, id);
    assert.equal(tileOf(viaSummary, 'B1').value, rs('500,000') + rs('13,000'));
  });

  test('B5 brand contribution agrees with the P&L allocated by revenue; B3, B6, B8 present', () => {
    const { Reports } = require('./helpers/book.js');
    const r = Kpis.dashboard(Object.assign({}, data, { settings: Object.assign({}, data.settings, { allocationKey: 'REVENUE' }) }), Object.assign({ tab: 'OVERVIEW' }, OCT));
    const b5 = r.charts.find((c) => c.id === 'B5');
    const contribution = b5.series.find((x) => x.label === 'Contribution').data;
    const pnl = Reports.profitAndLoss(book.lines, book.acc, { from: OCT.from, to: OCT.to, allocate: 'REVENUE' });
    assert.equal(contribution[0] + contribution[1], pnl.summary.netProfit.TOTAL);
    assert.ok(Math.abs(contribution[0] - pnl.summary.netProfit.UMSHA) <= 2, 'within rounding of per-account splits');
    const b3 = tileOf(r, 'B3');
    const p = Kpis.dashboard(data, Object.assign({ tab: 'OVERVIEW' }, OCT));
    assert.equal(b3.unit, 'bps');
    assert.equal(tileOf(p, 'B6').value, null, 'no full months of history yet');
    const b8 = r.charts.find((c) => c.id === 'B8');
    const oct = b8.labels.indexOf('2026-10');
    assert.equal(b8.series.find((x) => x.label === 'Mirae goods sold').data[oct], Math.round((book.lines.filter((l) => l.accountCode === '5100').reduce((t, l) => t + l.debitPaisa - l.creditPaisa, 0) * 10000) / rs('513,000')));
  });

  test('every tab builds with comparison and no NaN', () => {
    for (const tab of Kpis.TABS) {
      for (const compareTo of ['PREVIOUS', 'LAST_YEAR', 'TARGET']) {
        const r = Kpis.dashboard(Object.assign({}, data, { lines: book.lines }), { tab, today: '2026-10-15', period: 'MTD', compareTo, role: 'OWNER' });
        assert.ok(r.tiles.length > 0, tab);
        assert.ok(!/NaN|Infinity/.test(JSON.stringify(r)), tab + ' ' + compareTo);
        r.tiles.forEach((t) => assert.ok(t.link === '' || t.link.startsWith('#/'), t.id));
      }
    }
  });

  test('Store sees its own store only, without cost or margin', () => {
    const r = Kpis.filterForRole(Kpis.dashboard(data, Object.assign({ tab: 'MIRAE', role: 'STORE', store: 'MIRAE-KHI-02' }, OCT)), { role: 'STORE' });
    assert.equal(tileOf(r, 'D2').value, 0, 'another store sold nothing');
    assert.ok(!/cost|margin/i.test(JSON.stringify(r)));
    const own = Kpis.dashboard(data, Object.assign({ tab: 'MIRAE', role: 'STORE', store: 'MIRAE-KHI-01' }, OCT));
    assert.equal(tileOf(own, 'D2').value, 1);
  });
});

describe('T24: MonthlySummary incremental = full rebuild', () => {
  // Deterministic random documents: 2-6 lines each, random month, account,
  // brand and the occasional year-end closing entry.
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  for (const seed of [1, 7, 42]) {
    test('500 random documents, seed ' + seed, () => {
      const rand = rng(seed);
      const codes = ['1100', '1020', '1200', '2010', '2100', '4010', '4100', '4900', '5100', '6040', '3030'];
      const brands = Validate.BRANDS;
      let stored = [];
      const all = [];
      for (let d = 0; d < 500; d++) {
        const month = '2026-' + String(1 + Math.floor(rand() * 12)).padStart(2, '0');
        const date = month + '-' + String(1 + Math.floor(rand() * 28)).padStart(2, '0');
        const closing = rand() < 0.05;
        const n = 2 + Math.floor(rand() * 5);
        const lines = [];
        for (let i = 0; i < n; i++) {
          const amt = 1 + Math.floor(rand() * 1e7);
          lines.push({ date, accountCode: codes[Math.floor(rand() * codes.length)], brand: brands[Math.floor(rand() * brands.length)], debitPaisa: i % 2 ? 0 : amt, creditPaisa: i % 2 ? amt : 0, isClosing: closing });
        }
        all.push(...lines);
        // What Summaries.apply does on each write.
        const m = Kpis.mergeSummary(stored, Kpis.summarizeLines(lines));
        m.updates.forEach((u) => Object.assign(u.row, u.fields));
        stored = stored.concat(m.appends.map((r) => Object.assign({}, r)));
      }
      const rebuilt = Kpis.summarizeLines(all);
      assert.deepEqual(Kpis.summaryDrift(stored, rebuilt), []);
      assert.equal(stored.length, rebuilt.length);
      // And a drift is reported when the cache is wrong.
      stored[0].debitPaisa += 1;
      assert.equal(Kpis.summaryDrift(stored, rebuilt).length, 1);
    });
  }
});

describe('periods, comparisons and targets', () => {
  test('period ranges (fiscal year from July, weeks from Monday)', () => {
    const r = (p) => { const x = Kpis.periodRange(p, '2026-10-15', { fyStartMonth: 7 }); return [x.from, x.to]; };
    assert.deepEqual(r('TODAY'), ['2026-10-15', '2026-10-15']);
    assert.deepEqual(r('WTD'), ['2026-10-12', '2026-10-15']);
    assert.deepEqual(r('MTD'), ['2026-10-01', '2026-10-15']);
    assert.deepEqual(r('QTD'), ['2026-10-01', '2026-10-15']);
    assert.deepEqual(r('YTD'), ['2026-07-01', '2026-10-15']);
    assert.deepEqual(r('L12M'), ['2025-11-01', '2026-10-15']);
    assert.deepEqual(Kpis.periodRange('YTD', '2027-03-31', {}).from, '2026-07-01');
    assert.deepEqual(Kpis.periodRange('QTD', '2027-03-31', {}).from, '2027-01-01');
    assert.throws(() => Kpis.periodRange('CUSTOM', '2026-10-15', { from: '2026-10-10', to: '2026-10-01' }), (e) => e.code === 'E_VALIDATION');
  });

  test('comparison ranges', () => {
    const mtd = Kpis.periodRange('MTD', '2026-03-31', {});
    assert.deepEqual(Kpis.compareRange(mtd, 'PREVIOUS'), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(Kpis.compareRange(mtd, 'LAST_YEAR'), { from: '2025-03-01', to: '2025-03-31' });
    const custom = Kpis.periodRange('CUSTOM', '2026-03-31', { from: '2026-03-10', to: '2026-03-19' });
    assert.deepEqual(Kpis.compareRange(custom, 'PREVIOUS'), { from: '2026-02-28', to: '2026-03-09' });
    assert.equal(Kpis.compareRange(mtd, 'TARGET'), null);
    assert.ok(Kpis.monthAligned(mtd, '2026-03-31'));
    assert.ok(!Kpis.monthAligned({ from: '2026-03-01', to: '2026-03-15' }, '2026-03-31'));
  });

  test('RAG from KpiTargets thresholds, both directions', () => {
    const cov = { kpi: 'advanceCoverage', amberAt: 12000, redAt: 10000, direction: 'HIGHER_BETTER' };
    assert.deepEqual([9999, 10000, 11999, 12000].map((v) => Kpis.ragOf(v, cov)), ['red', 'amber', 'amber', 'green']);
    const ret = { kpi: 'maxReturnPct', amberAt: 800, redAt: '', direction: 'LOWER_BETTER' };
    assert.deepEqual([800, 801].map((v) => Kpis.ragOf(v, ret)), ['green', 'amber']);
    assert.equal(Kpis.ragOf(null, cov), null);
    const rows = [{ kpi: 'revenueTarget', brand: 'MIRAE', period: 'ANY', target: 1 }, { kpi: 'revenueTarget', brand: 'MIRAE', period: '2026-10', target: 2 }];
    assert.equal(Kpis.targetFor(rows, 'revenueTarget', 'MIRAE', '2026-10').target, 2);
    assert.equal(Kpis.targetFor(rows, 'revenueTarget', 'MIRAE', '2026-11').target, 1);
  });

  test('revenue target comparison adds up months and brands', () => {
    const { book } = runThroughT12();
    const data = Object.assign(dataFor(book), { targets: [
      { kpi: 'revenueTarget', brand: 'UMSHA', period: 'ANY', target: rs('400,000') },
      { kpi: 'revenueTarget', brand: 'MIRAE', period: 'ANY', target: rs('100,000') },
    ] });
    const r = Kpis.dashboard(data, { tab: 'OVERVIEW', today: '2026-10-31', period: 'MTD', compareTo: 'TARGET' });
    const b1 = tileOf(r, 'B1');
    assert.equal(b1.compare, rs('500,000'));
    assert.equal(b1.delta, rs('13,000'));
  });

  test('prepareTarget validates and numbers new targets after the seeded ones', () => {
    const rows = [{ id: 'KT-012', kpi: 'minCash', brand: 'ALL', period: 'ANY' }];
    const t = Kpis.prepareTarget({ kpi: 'revenueTarget', brand: 'MIRAE', period: '2026-11', target: '5000000' }, rows);
    assert.deepEqual(t, { id: 'KT-013', kpi: 'revenueTarget', brand: 'MIRAE', period: '2026-11', target: 5000000, amberAt: '', redAt: '', direction: 'HIGHER_BETTER', notes: '' });
    assert.throws(() => Kpis.prepareTarget({ kpi: 'minCash' }, rows), /already a target/);
    assert.throws(() => Kpis.prepareTarget({ kpi: 'nope' }, rows), (e) => e.field === 'kpi');
    assert.throws(() => Kpis.prepareTarget({ kpi: 'onTimePct', period: '2026-13' }, rows), (e) => e.field === 'period');
    assert.throws(() => Kpis.prepareTarget({ kpi: 'onTimePct', target: '1.5' }, rows), (e) => e.field === 'target');
  });
});
