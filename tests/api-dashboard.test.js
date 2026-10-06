// Milestone M10 through the API: dashboard.get with role filtering (T25),
// MonthlySummary and DailySales kept in step with every write (T24 on the
// server), the nightly rebuild, caching and KPI targets.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSystem } = require('./helpers/gas.js');

const rs = (r) => Math.round(r * 100);
const NOW = '2026-10-20T10:00:00Z'; // 15:00 in Karachi

function setup() {
  const { gas, users } = createSystem({ now: NOW });
  const ok = (r) => { assert.ok(r.ok, JSON.stringify(r)); return r.data; };
  const o = users.owner;
  const cust = ok(gas.call(o, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Ayesha', phone: '03001234567' })).contact;
  const karigar = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Karigar' })).contact;
  for (const x of ['A', 'B']) ok(gas.call(o, 'items.upsert', { id: 'SKU-' + x, category: 'SKU', name: 'Kurta ' + x, taxCodeId: 'ST-STD', collection: 'Winter' }));
  const job = ok(gas.call(users.studio, 'jobs.create', { type: 'MTO_ORDER', contactId: cust.id, title: 'Bridal', taxCodeId: 'ST-STD', promisedDate: '2026-10-10', bookedDate: '2026-10-01', budgetCostPaisa: rs(50000), lines: [{ description: 'Lehenga', unitPricePaisa: rs(500000) }] })).job;
  ok(gas.call(users.studio, 'payments.receiveAdvance', { jobId: job.id, date: '2026-10-01', amountPaisa: rs(300000), moneyAccountCode: '1100' }));
  ok(gas.call(users.studio, 'karigar.logWork', { contactId: karigar.id, jobId: job.id, date: '2026-10-05', costComponent: 'EMBROIDERY', pieces: 40, ratePaisa: rs(2000) }));
  ok(gas.call(users.studio, 'jobs.deliver', { jobId: job.id, date: '2026-10-12' }));
  const late = ok(gas.call(users.studio, 'jobs.create', { type: 'MTO_ORDER', contactId: cust.id, title: 'Formal', taxCodeId: 'ST-STD', promisedDate: '2026-10-15', bookedDate: '2026-10-02', lines: [{ description: 'Kurta', unitPricePaisa: rs(80000) }] })).job;
  const batch = ok(gas.call(users.studio, 'jobs.create', { type: 'RTW_BATCH', title: 'Run', bookedDate: '2026-10-01', lines: [{ itemId: 'SKU-A', qty: 10 }] })).job;
  ok(gas.call(users.studio, 'karigar.logWork', { contactId: karigar.id, jobId: batch.id, date: '2026-10-08', costComponent: 'STITCHING', pieces: 1, ratePaisa: rs(100000) }));
  ok(gas.call(users.studio, 'jobs.completeBatch', { jobId: batch.id, date: '2026-10-08', outputs: [{ itemId: 'SKU-A', qty: 10 }, { itemId: 'SKU-B', qty: 20 }] }));
  // Two stores: the Store user's own (KHI-01) and another the Owner sells in.
  const own = ok(gas.call(users.store, 'sale.create', { date: '2026-10-09', lines: [{ itemId: 'SKU-A', qty: 1, unitPricePaisa: rs(9440) }, { itemId: 'SKU-B', qty: 2, unitPricePaisa: rs(5900) }],
    payments: [{ method: 'CASH', accountCode: '1020', amountPaisa: rs(10000) }, { method: 'CARD', accountCode: '1210', amountPaisa: rs(11240) }] }));
  const other = ok(gas.call(o, 'sale.create', { date: '2026-10-09', store: 'MIRAE-LHR-01', lines: [{ itemId: 'SKU-A', qty: 3, unitPricePaisa: rs(9440) }],
    payments: [{ method: 'CARD', accountCode: '1210', amountPaisa: rs(28320) }] }));
  const lineB = gas.rows('SaleLines').find((l) => l.saleId === own.saleId && l.itemId === 'SKU-B');
  ok(gas.call(users.store, 'sale.return', { originalSaleId: own.saleId, date: '2026-10-10', lines: [{ saleLineId: lineB.id, qty: 1 }], refund: [{ method: 'CARD', accountCode: '1210', amountPaisa: rs(5900) }] }));
  return { gas, users, ok, job, late, own, other };
}

const tileOf = (r, id) => r.tiles.find((t) => t.id === id);
const OCT = { period: 'CUSTOM', from: '2026-10-01', to: '2026-10-31', compareTo: 'NONE' };

describe('dashboard summaries stay in step with the ledger (M10)', () => {
  const { gas, users, ok, other } = setup();

  test('MonthlySummary and DailySales equal a full rebuild after every kind of write', () => {
    // A voided sale must leave DailySales as well.
    const je = gas.rows('Sales').find((s) => s.id === other.saleId).jeId;
    ok(gas.call(users.finance, 'journal.reverse', { jeId: je, date: '2026-10-11', reason: 'Wrong store' }));
    assert.equal(gas.rows('Sales').find((s) => s.id === other.saleId).status, 'VOID');
    const sum = (rows, f) => rows.reduce((t, r) => t + (r[f] || 0), 0);
    const lines = gas.rows('JournalLines');
    assert.equal(sum(gas.rows('MonthlySummary'), 'debitPaisa'), sum(lines, 'debitPaisa'));
    assert.equal(sum(gas.rows('MonthlySummary'), 'lineCount'), lines.length);
    assert.deepEqual(gas.rows('DailySales').filter((d) => d.netPaisa || d.returnsNetPaisa).map((d) => [d.date, d.store, d.netPaisa, d.returnsNetPaisa, d.transactions]), [
      ['2026-10-09', 'MIRAE-KHI-01', rs(18000), 0, 1],
      ['2026-10-10', 'MIRAE-KHI-01', 0, rs(5000), 0],
    ]);
    const r = ok(gas.call(users.owner, 'summaries.rebuild', {}));
    assert.deepEqual(r.monthlyDrift, []);
    assert.deepEqual(r.dailyDrift, []);
    assert.equal(gas.call(users.finance, 'summaries.rebuild', {}).code, 'E_ROLE');
  });

  test('the nightly job finds no drift, and logs it when a cache is edited by hand', () => {
    let res = gas.run('nightly');
    assert.equal(res.summaryDrift, 0);
    const sh = gas.ss.getSheetByName('MonthlySummary');
    const col = sh.values()[0].indexOf('debitPaisa') + 1;
    sh.getRange(2, col).setValue(Number(sh.getRange(2, col).getValues()[0][0]) + 1);
    res = gas.run('nightly');
    assert.equal(res.summaryDrift, 1);
    assert.ok(gas.rows('AuditLog').some((a) => a.action === 'nightly.drift' && a.docType === 'SUMMARY'));
    assert.equal(gas.run('nightly').summaryDrift, 0, 'the rebuild fixed it');
  });
});

describe('dashboard.get (M10)', () => {
  const { gas, users, ok, job, late } = setup();

  test('T25: Store cannot open the Overview; Mirae shows its own store only, no cost or margin', () => {
    assert.equal(gas.call(users.store, 'dashboard.get', { tab: 'OVERVIEW' }).code, 'E_ROLE');
    assert.equal(gas.call(users.store, 'dashboard.get', { tab: 'CASH' }).code, 'E_ROLE');
    const r = ok(gas.call(users.store, 'dashboard.get', Object.assign({ tab: 'MIRAE' }, OCT)));
    assert.equal(tileOf(r, 'D2').value, 1, 'only the KHI-01 sale');
    assert.equal(tileOf(r, 'D1').value, rs(13000));
    assert.ok(!/cost|margin/i.test(JSON.stringify(r)), 'no cost or margin fields');
    assert.ok(!tileOf(r, 'D7') && !r.tables.length);
    const owner = ok(gas.call(users.owner, 'dashboard.get', Object.assign({ tab: 'MIRAE' }, OCT)));
    assert.equal(tileOf(owner, 'D2').value, 2, 'both stores');
    assert.ok(tileOf(owner, 'D7').value > 0, 'stock at cost');
  });

  test('Studio sees UMSHA and Operations, not the company tabs', () => {
    assert.equal(gas.call(users.studio, 'dashboard.get', { tab: 'OVERVIEW' }).code, 'E_ROLE');
    assert.equal(gas.call(users.viewer, 'dashboard.get', { tab: 'UMSHA' }).code, 'E_ROLE');
    const r = ok(gas.call(users.studio, 'dashboard.get', Object.assign({ tab: 'UMSHA' }, OCT)));
    assert.equal(tileOf(r, 'C4').value, 8400, '(500,000 - 80,000) / 500,000');
    assert.equal(tileOf(r, 'C5').value, 10000, 'cost 80,000 is over the 50,000 budget');
    assert.equal(tileOf(r, 'C6').value, 0, 'delivered after the promised date');
    assert.equal(tileOf(r, 'C8').value, 1);
    assert.deepEqual(r.tables.find((t) => t.id === 'C8-list').rows.map((x) => [x.id, x.daysLate]), [[late.id, 5]]);
    assert.deepEqual(r.tables.find((t) => t.id === 'C5-worst').rows.map((x) => [x.id, x.overPct]), [[job.id, 6000]]);
    assert.ok(ok(gas.call(users.studio, 'dashboard.get', { tab: 'OPERATIONS' })).tiles.length);
  });

  test('Overview: tiles, alerts and the 12-month chart', () => {
    const r = ok(gas.call(users.owner, 'dashboard.get', { tab: 'OVERVIEW', period: 'MTD' }));
    assert.equal(r.from, '2026-10-01');
    assert.equal(r.to, '2026-10-20');
    assert.equal(tileOf(r, 'B1').value, rs(500000) + rs(13000) + rs(24000), 'MTO delivery + KHI-01 net of return + LHR-01');
    assert.equal(tileOf(r, 'A1').value, gas.rows('JournalLines').filter((l) => ['1010', '1020', '1030', '1100', '1101', '1120', '1121', '1210'].includes(l.accountCode)).reduce((t, l) => t + l.debitPaisa - l.creditPaisa, 0));
    assert.equal(tileOf(r, 'A1').spark.length, 12);
    assert.ok(r.alerts.some((a) => /past the promised date/.test(a.text) && a.level === 'red'));
    assert.ok(r.alerts.some((a) => /No month has been closed/.test(a.text)));
    assert.ok(r.alerts.length <= 8);
    assert.equal(r.charts.find((c) => c.id === 'B1-trend').labels.length, 12);
    assert.deepEqual(r.charts.map((c) => c.id), ['B5', 'B8', 'B1-trend']);
    assert.ok(r.asOf);
  });

  test('periods that cut across months read the lines and agree with the summary', () => {
    const viaLines = ok(gas.call(users.owner, 'dashboard.get', { tab: 'OVERVIEW', period: 'CUSTOM', from: '2026-10-01', to: '2026-10-19', compareTo: 'NONE' }));
    const viaSummary = ok(gas.call(users.owner, 'dashboard.get', { tab: 'OVERVIEW', period: 'CUSTOM', from: '2026-10-01', to: '2026-10-31', compareTo: 'NONE' }));
    assert.equal(tileOf(viaLines, 'B1').value, tileOf(viaSummary, 'B1').value);
    const today = ok(gas.call(users.owner, 'dashboard.get', { tab: 'OVERVIEW', period: 'TODAY' }));
    assert.equal(tileOf(today, 'B1').value, 0, 'nothing posted on the 20th');
  });

  test('results are cached for 5 minutes and dropped on any write', () => {
    const p = { tab: 'CUSTOMERS', period: 'MTD' };
    assert.ok(!ok(gas.call(users.owner, 'dashboard.get', p)).cached);
    assert.equal(ok(gas.call(users.owner, 'dashboard.get', p)).cached, true);
    assert.ok(!ok(gas.call(users.finance, 'dashboard.get', p)).cached, 'cached per role');
    ok(gas.call(users.owner, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Sana', phone: '03211234567' }));
    assert.ok(!ok(gas.call(users.owner, 'dashboard.get', p)).cached);
  });

  test('KPI targets: Owner only; they set the colour and the comparison', () => {
    assert.equal(gas.call(users.finance, 'kpiTargets.upsert', { kpi: 'minCash', target: 1 }).code, 'E_ROLE');
    const list = ok(gas.call(users.owner, 'kpiTargets.list', {}));
    const minCash = list.find((t) => t.kpi === 'minCash');
    ok(gas.call(users.owner, 'kpiTargets.upsert', Object.assign({}, minCash, { redAt: rs(100000000) })));
    const change = ok(gas.call(users.owner, 'reports.auditLog', { q: 'minCash' }))[0];
    assert.deepEqual([change.before.redAt, change.after.redAt], [0, rs(100000000)], 'the audit row keeps the old value');
    const t = ok(gas.call(users.owner, 'kpiTargets.upsert', { kpi: 'revenueTarget', brand: 'UMSHA', period: '2026-10', target: rs(600000) }));
    assert.equal(t.id, 'KT-013');
    const r = ok(gas.call(users.owner, 'dashboard.get', { tab: 'OVERVIEW', period: 'MTD', brand: 'UMSHA', compareTo: 'TARGET' }));
    assert.equal(tileOf(r, 'A1').rag, 'red', 'below the minimum cash');
    assert.equal(tileOf(r, 'B1').value, rs(500000));
    assert.equal(tileOf(r, 'B1').compare, rs(600000));
    assert.equal(tileOf(r, 'B1').deltaPct, -1667);
    assert.ok(gas.rows('AuditLog').some((a) => a.docType === 'KPI_TARGET' && a.docId === 'KT-013'));
  });

  test('every tab and period works for the Owner without NaN', () => {
    for (const tab of ['OVERVIEW', 'CASH', 'UMSHA', 'MIRAE', 'OPERATIONS', 'CUSTOMERS', 'CONTROLS']) {
      for (const period of ['TODAY', 'WTD', 'MTD', 'QTD', 'YTD', 'L12M']) {
        const r = ok(gas.call(users.owner, 'dashboard.get', { tab, period, compareTo: 'LAST_YEAR' }));
        assert.ok(!/NaN|Infinity/.test(JSON.stringify(r)), tab + ' ' + period);
      }
    }
    const c = ok(gas.call(users.owner, 'dashboard.get', { tab: 'CONTROLS', period: 'MTD' }));
    assert.equal(tileOf(c, 'G3-1100').rag, 'red', 'never reconciled');
    assert.ok(tileOf(c, 'G6'), 'drawings for the Owner');
    assert.ok(!tileOf(ok(gas.call(users.finance, 'dashboard.get', { tab: 'CONTROLS', period: 'MTD' })), 'G6'), 'not for Finance');
    assert.equal(gas.call(users.owner, 'dashboard.get', { tab: 'NOPE' }).code, 'E_VALIDATION');
  });
});
