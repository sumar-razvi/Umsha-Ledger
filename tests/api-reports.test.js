// Milestone M7 through the API: reports (T16 P&L by brand with allocation,
// T17 integrity), month close checklist, year-end close (R23), tax reports.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSystem } = require('./helpers/gas.js');

const rs = (r) => Math.round(r * 100);

// UMSHA revenue 500,000 (MTO delivery); Mirae 18,000 less a 5,000 return;
// shared electricity 40,000; a karigar paid with WHT.
function setup() {
  const { gas, users } = createSystem();
  const ok = (r) => { assert.ok(r.ok, JSON.stringify(r)); return r.data; };
  const o = users.owner;
  ok(gas.call(o, 'taxCodes.upsert', { id: 'WHT-SVC-F', name: 'WHT services', kind: 'WHT', rateBps: 1000, whtBase: 'EXCL_SALES_TAX', appliesTo: 'SERVICES', vendorFilerStatus: 'FILER', effectiveFrom: '2025-07-01', isActive: true }));
  const cust = ok(gas.call(o, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Ayesha', phone: '03001234567' })).contact;
  const karigar = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Karigar', filerStatus: 'FILER', whtTaxCodeId: 'WHT-SVC-F' })).contact;
  const landlord = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'SERVICE', name: 'Landlord' })).contact;
  for (const x of ['A', 'B']) ok(gas.call(o, 'items.upsert', { id: 'SKU-' + x, category: 'SKU', name: 'Kurta ' + x, taxCodeId: 'ST-STD', collection: 'Winter' }));
  const job = ok(gas.call(users.studio, 'jobs.create', { type: 'MTO_ORDER', contactId: cust.id, title: 'Bridal', taxCodeId: 'ST-STD', promisedDate: '2026-10-10', bookedDate: '2026-10-01', budgetCostPaisa: rs(100000), lines: [{ description: 'Lehenga', unitPricePaisa: rs(500000) }] })).job;
  ok(gas.call(users.studio, 'payments.receiveAdvance', { jobId: job.id, date: '2026-10-01', amountPaisa: rs(300000), moneyAccountCode: '1100' }));
  const work = ok(gas.call(users.studio, 'karigar.logWork', { contactId: karigar.id, jobId: job.id, date: '2026-10-05', costComponent: 'EMBROIDERY', pieces: 40, ratePaisa: rs(2000) }));
  ok(gas.call(users.finance, 'payments.pay', { contactId: karigar.id, date: '2026-10-05', moneyAccountCode: '1100', allocations: [{ docType: 'BILL', docId: work.billId, amountPaisa: rs(80000) }] }));
  const inv = ok(gas.call(users.studio, 'jobs.deliver', { jobId: job.id, date: '2026-10-06' })).invoice;
  const batch = ok(gas.call(users.studio, 'jobs.create', { type: 'RTW_BATCH', title: 'Run', bookedDate: '2026-10-01', lines: [{ itemId: 'SKU-A', qty: 10 }] })).job;
  ok(gas.call(users.studio, 'karigar.logWork', { contactId: karigar.id, jobId: batch.id, date: '2026-10-08', costComponent: 'STITCHING', pieces: 1, ratePaisa: rs(100000) }));
  ok(gas.call(users.studio, 'jobs.completeBatch', { jobId: batch.id, date: '2026-10-08', outputs: [{ itemId: 'SKU-A', qty: 10 }, { itemId: 'SKU-B', qty: 20 }] }));
  const sale = ok(gas.call(users.store, 'sale.create', {
    date: '2026-10-09', lines: [{ itemId: 'SKU-A', qty: 1, unitPricePaisa: rs(9440) }, { itemId: 'SKU-B', qty: 2, unitPricePaisa: rs(5900) }],
    payments: [{ method: 'CASH', accountCode: '1020', amountPaisa: rs(10000) }, { method: 'CARD', accountCode: '1210', amountPaisa: rs(11240) }],
  }));
  const lineB = gas.rows('SaleLines').find((l) => l.saleId === sale.saleId && l.itemId === 'SKU-B');
  ok(gas.call(users.store, 'sale.return', { originalSaleId: sale.saleId, date: '2026-10-10', lines: [{ saleLineId: lineB.id, qty: 1 }], refund: [{ method: 'CARD', accountCode: '1210', amountPaisa: rs(5900) }] }));
  ok(gas.call(users.finance, 'bills.create', { contactId: landlord.id, date: '2026-10-07', lines: [{ lineKind: 'EXPENSE', accountCode: '6040', brand: 'SHARED', netPaisa: rs(40000), description: 'Electricity' }] }));
  return { gas, users, ok, job, inv };
}

describe('reports through the API (M7)', () => {
  const { gas, users, ok, job } = setup();

  test('T16: P&L by brand, unallocated and allocated by revenue, with comparison', () => {
    const r = ok(gas.call(users.viewer, 'reports.pnl', { from: '2026-10-01', to: '2026-10-31', allocate: 'NONE', compareTo: { from: '2026-09-01', to: '2026-09-30' } }));
    assert.equal(r.current.summary.netRevenue.UMSHA, rs(500000));
    assert.equal(r.current.summary.netRevenue.MIRAE, rs(13000));
    assert.equal(r.previous.summary.netRevenue.TOTAL, 0);
    const a = ok(gas.call(users.viewer, 'reports.pnl', { from: '2026-10-01', to: '2026-10-31', allocate: 'REVENUE' }));
    const elec = a.current.sections.expenses.rows.find((x) => x.code === '6040');
    assert.deepEqual([elec.amounts.UMSHA, elec.amounts.MIRAE, elec.amounts.SHARED], [rs(38986.35), rs(1013.65), 0]);
    assert.equal(gas.call(users.studio, 'reports.pnl', { from: '2026-10-01', to: '2026-10-31' }).code, 'E_ROLE');
  });

  test('T17: trial balance and balance sheet balance; cash position; sales tax; WHT register', () => {
    assert.ok(ok(gas.call(users.viewer, 'reports.trialBalance', { asOf: '2026-10-31' })).balanced);
    assert.ok(ok(gas.call(users.viewer, 'reports.balanceSheet', { asOf: '2026-10-31' })).balanced);
    const tax = ok(gas.call(users.viewer, 'reports.salesTax', { from: '2026-10-01', to: '2026-10-31' }));
    assert.equal(tax.outputPaisa, rs(90000) + rs(3240) - rs(900));
    const wht = ok(gas.call(users.viewer, 'reports.whtRegister', { from: '2026-10-01', to: '2026-10-31' }));
    assert.equal(wht.totalWhtPaisa, rs(8000));
    const cash = ok(gas.call(users.viewer, 'reports.cashPosition', { asOf: '2026-10-31' }));
    assert.equal(cash.receivable.totalPaisa, rs(290000));
    assert.equal(cash.payable.totalPaisa, rs(40000) + rs(100000));
  });

  test('job profitability with budget and on-time; SKU margin by collection', () => {
    const jobs = ok(gas.call(users.studio, 'reports.jobProfitability', { from: '2026-10-01', to: '2026-10-31' }));
    assert.deepEqual(jobs.map((x) => [x.jobId, x.marginPaisa, x.marginBps, x.onTime, x.overBudget, x.contactName]), [[job.id, rs(420000), 8400, true, false, 'Ayesha']]);
    const sku = ok(gas.call(users.viewer, 'reports.skuMargin', { from: '2026-10-01', to: '2026-10-31', collection: 'Winter' }));
    assert.deepEqual(sku.rows.map((x) => [x.itemId, x.units]), [['SKU-A', 1], ['SKU-B', 1]]);
  });

  test('journal list and audit log', () => {
    const manual = ok(gas.call(users.finance, 'journal.create', { date: '2026-10-20', memo: 'Audit fee accrual', lines: [{ accountCode: '6300', brand: 'SHARED', debitPaisa: rs(25000) }, { accountCode: '2300', brand: 'SHARED', creditPaisa: rs(25000) }] }));
    const list = ok(gas.call(users.viewer, 'journal.list', { manualOnly: true }));
    assert.deepEqual(list.map((j) => [j.id, j.totalPaisa]), [[manual.jeId, rs(25000)]]);
    assert.ok(ok(gas.call(users.viewer, 'journal.list', { accountCode: '1210' })).length >= 2);
    const audit = ok(gas.call(users.owner, 'reports.auditLog', { q: 'Audit fee' }));
    assert.equal(audit[0].userEmail, users.finance);
  });
});

describe('month and year close (M7)', () => {
  test('checklist, close with acknowledged warnings, year-end close', () => {
    const { gas, users, ok } = setup();
    const list = ok(gas.call(users.finance, 'periods.checklist', { periodId: '2026-10' }));
    const byKey = Object.fromEntries(list.checks.map((c) => [c.key, c]));
    assert.ok(byKey.TB.ok && byKey.CONTROL.ok);
    assert.equal(byKey.CASHUP.ok, false);
    assert.match(byKey.CASHUP.detail, /2026-10-09 MIRAE-KHI-01/);
    assert.equal(gas.call(users.owner, 'periods.close', { periodId: '2026-10' }).field, 'acknowledgeWarnings');
    ok(gas.call(users.owner, 'periods.close', { periodId: '2026-10', acknowledgeWarnings: true }));
    assert.match(gas.rows('AuditLog').at(-1).summary, /acknowledged: Cash-up done for every trading day/);

    assert.equal(gas.call(users.finance, 'year.close', { fiscalYearEnd: '2027-06-30' }).code, 'E_ROLE');
    const close = ok(gas.call(users.owner, 'year.close', { fiscalYearEnd: '2027-06-30' }));
    const pnlAfter = ok(gas.call(users.viewer, 'reports.pnl', { from: '2026-07-01', to: '2027-06-30', allocate: 'NONE' }));
    assert.equal(pnlAfter.current.summary.netProfit.TOTAL, close.netProfitPaisa, 'the P&L for the year still shows its result');
    assert.equal(gas.call(users.owner, 'year.close', { fiscalYearEnd: '2027-06-30' }).code, 'E_VALIDATION');
    const tb = ok(gas.call(users.viewer, 'reports.trialBalance', { asOf: '2027-06-30' }));
    assert.ok(tb.balanced);
    assert.ok(!tb.rows.some((r) => ['REVENUE', 'COGS', 'EXPENSE'].includes(r.type)), 'P&L accounts are at zero after the close');
  });

  test('sales tax settlement and WHT deposit', () => {
    const { gas, users, ok } = setup();
    ok(gas.call(users.finance, 'tax.settleSalesTax', { date: '2026-11-15', outputPaisa: rs(92340), inputPaisa: 0, bankCode: '1100', reference: 'Oct return' }));
    ok(gas.call(users.finance, 'tax.depositWht', { date: '2026-11-15', amountPaisa: rs(8000), bankCode: '1100' }));
    const tax = ok(gas.call(users.viewer, 'reports.salesTax', { from: '2026-10-01', to: '2026-11-30' }));
    assert.equal(tax.outputPaisa, rs(92340), 'settlements are left out of what arose in the period');
    assert.equal(ok(gas.call(users.viewer, 'ledger.account', { accountCode: '2210' })).closingPaisa, 0);
  });
});
