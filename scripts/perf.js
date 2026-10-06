#!/usr/bin/env node
// Performance check (milestone M9): build a year of synthetic activity
// (about 20k journal lines) through the real Apps Script code in the
// in-memory fake, then time every screen's read action and count the Sheet
// cells it reads.
//
//   npm run perf                (LINES=20000 to change the target)
//
// The fake has no network or Sheets latency, so the numbers are: server
// JavaScript time here, plus cells read. On Apps Script, reading a range
// costs roughly 1 s per 250k cells and V8 there runs about 3x slower than
// Node; "est. Apps Script" applies those factors. Targets (docs/02): any
// screen < 3 s, reports < 8 s.

'use strict';

const { createSystem } = require('../tests/helpers/gas.js');

const TARGET = Number(process.env.LINES || 20000);
const CELLS_PER_SECOND = 250000;
const V8_FACTOR = 3;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const rand = rng(2026);
const pick = (a) => a[Math.floor(rand() * a.length)];
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, n) => iso(new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000));

function build() {
  const { gas, users } = createSystem({ now: '2026-10-28T07:00:00Z' });
  const ok = (r) => { if (!r.ok) throw new Error(JSON.stringify(r)); return r.data; };
  const o = users.owner;
  ok(gas.call(o, 'taxCodes.upsert', { id: 'WHT-SVC-F', name: 'WHT services', kind: 'WHT', rateBps: 1000, whtBase: 'EXCL_SALES_TAX', appliesTo: 'SERVICES', vendorFilerStatus: 'FILER', effectiveFrom: '2025-07-01', isActive: true }));
  const customers = [];
  for (let i = 0; i < 300; i++) customers.push(ok(gas.call(o, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Customer ' + i, phone: '0300' + String(1000000 + i) })).contact.id);
  const karigars = [];
  for (let i = 0; i < 15; i++) karigars.push(ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Karigar ' + i, filerStatus: 'FILER', whtTaxCodeId: 'WHT-SVC-F' })).contact.id);
  const landlord = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'SERVICE', name: 'Landlord' })).contact.id;
  const skus = [];
  for (let i = 0; i < 60; i++) skus.push(ok(gas.call(o, 'items.upsert', { category: 'SKU', name: 'Kurta ' + i, taxCodeId: 'ST-STD', collection: 'C' + (i % 6), salePricePaisa: 590000 })).item.id);

  const lines = () => gas.ss.getSheetByName('JournalLines').getLastRow() - 1;
  let day = '2025-11-01';
  let docs = 0;
  const t0 = Date.now();
  while (lines() < TARGET && day < '2026-10-28') {
    // Monthly: a production batch, rent, and a few MTO orders.
    if (day.endsWith('-01')) {
      const batch = ok(gas.call(users.studio, 'jobs.create', { type: 'RTW_BATCH', title: 'Batch ' + day, bookedDate: day, lines: [{ itemId: skus[0], qty: 1 }] })).job;
      ok(gas.call(users.studio, 'karigar.logWork', { contactId: pick(karigars), jobId: batch.id, date: day, costComponent: 'STITCHING', pieces: 600, ratePaisa: 150000 }));
      ok(gas.call(users.studio, 'jobs.completeBatch', { jobId: batch.id, date: day, outputs: skus.map((id) => ({ itemId: id, qty: 15 })) }));
      ok(gas.call(users.finance, 'bills.create', { contactId: landlord, date: day, lines: [{ lineKind: 'EXPENSE', accountCode: '6020', brand: 'MIRAE', netPaisa: 25000000, description: 'Store rent' }] }));
      for (let j = 0; j < 12; j++) {
        const promised = addDays(day, 20 + Math.floor(rand() * 30));
        const job = ok(gas.call(users.studio, 'jobs.create', { type: 'MTO_ORDER', contactId: pick(customers), title: 'Order', taxCodeId: 'ST-STD', bookedDate: day, promisedDate: promised, budgetCostPaisa: 8000000, lines: [{ description: 'Outfit', unitPricePaisa: 20000000 + Math.floor(rand() * 30000000) }] })).job;
        ok(gas.call(users.studio, 'payments.receiveAdvance', { jobId: job.id, date: day, amountPaisa: 10000000, moneyAccountCode: '1100' }));
        ok(gas.call(users.studio, 'karigar.logWork', { contactId: pick(karigars), jobId: job.id, date: addDays(day, 5), costComponent: 'EMBROIDERY', pieces: 20, ratePaisa: 400000 }));
        if (addDays(day, 14) < '2026-10-28') {
          const inv = ok(gas.call(users.studio, 'jobs.deliver', { jobId: job.id, date: addDays(day, 14) })).invoice;
          if (rand() < 0.8) ok(gas.call(users.studio, 'payments.receive', { contactId: job.contactId, date: addDays(day, 14), moneyAccountCode: '1100', amountPaisa: inv.balancePaisa, allocations: [{ invoiceId: inv.id, amountPaisa: inv.balancePaisa }] }));
        }
        docs += 4;
      }
    }
    // Daily: store sales.
    for (let k = 0; k < 8; k++) {
      const a = pick(skus); const b = pick(skus);
      const card = rand() < 0.5;
      ok(gas.call(users.store, 'sale.create', { date: day, lines: [{ itemId: a, qty: 1, unitPricePaisa: 590000 }, { itemId: b, qty: 1, unitPricePaisa: 590000 }],
        payments: [{ method: card ? 'CARD' : 'CASH', accountCode: card ? '1210' : '1020', amountPaisa: 1180000 }] }));
      docs++;
    }
    day = addDays(day, 1);
    if (day.endsWith('-15')) process.stdout.write('  ' + day + ': ' + lines() + ' lines, ' + docs + ' documents, ' + Math.round((Date.now() - t0) / 1000) + ' s\n');
  }
  return { gas, users, lines: lines(), docs, ms: Date.now() - t0, customers, skus };
}

function measure(gas, label, email, action, payload) {
  gas.ss.stats.cellsRead = 0;
  const t = process.hrtime.bigint();
  const r = gas.call(email, action, payload);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  if (!r.ok) throw new Error(label + ': ' + JSON.stringify(r));
  const cells = gas.ss.stats.cellsRead;
  const est = cells / CELLS_PER_SECOND + (ms * V8_FACTOR) / 1000;
  return { label, action, ms: Math.round(ms), cells, est: Math.round(est * 10) / 10 };
}

if (require.main === module) {
  console.log('Building about ' + TARGET + ' journal lines through the API (takes a few minutes)...');
  const b = build();
  const { gas, users } = b;
  console.log('Built ' + b.lines + ' journal lines from ' + b.docs + ' documents in ' + Math.round(b.ms / 1000) + ' s.\n');
  const job = gas.rows('Jobs').find((j) => j.type === 'MTO_ORDER');
  const sale = gas.rows('Sales')[0];
  const bill = gas.rows('Bills')[0];
  const inv = gas.rows('Invoices')[0];
  const je = gas.rows('Journal')[0];
  const R = { from: '2026-10-01', to: '2026-10-31' };
  const screens = [
    ['Sign-in (session.me)', users.studio, 'session.me', {}],
    ['Orders list', users.studio, 'jobs.list', { type: 'MTO_ORDER' }],
    ['Order page', users.studio, 'jobs.get', { id: job.id }],
    ['Customers search', users.studio, 'contacts.search', { q: 'Customer 1', kind: 'CUSTOMER' }],
    ['Customer page', users.owner, 'contacts.get', { id: job.contactId }],
    ['Items search', users.store, 'items.search', { q: 'Kurta' }],
    ['Sales list', users.store, 'sales.list', { date: '2026-10-27' }],
    ['Sale receipt', users.store, 'receipts.render', { docType: 'SALE', docId: sale.id }],
    ['Today (daily sales)', users.store, 'reports.dailySales', { date: '2026-10-27', store: 'MIRAE-KHI-01' }],
    ['Cash-up preview', users.store, 'cashup.preview', { date: '2026-10-27' }],
    ['Bills list', users.finance, 'bills.list', {}],
    ['Bill page', users.finance, 'bills.get', { id: bill.id }],
    ['Vendors', users.finance, 'vendors.list', {}],
    ['Invoice', users.finance, 'invoices.get', { id: inv.id }],
    ['Stock valuation', users.finance, 'stock.valuation', { asOf: '2026-10-28' }],
    ['Item movements', users.finance, 'stock.movements', { itemId: b.skus[0] }],
    ['Journal entry', users.finance, 'journal.get', { jeId: je.id }],
    ['Journals list', users.finance, 'journal.list', R],
    ['Dashboard: Overview (MTD)', users.owner, 'dashboard.get', { tab: 'OVERVIEW', period: 'MTD' }],
    ['Dashboard: Overview (cached)', users.owner, 'dashboard.get', { tab: 'OVERVIEW', period: 'MTD' }],
    ['Dashboard: Overview (full months)', users.owner, 'dashboard.get', { tab: 'OVERVIEW', period: 'CUSTOM', from: '2026-09-01', to: '2026-09-30', compareTo: 'NONE' }],
    ['Dashboard: Cash', users.owner, 'dashboard.get', { tab: 'CASH', period: 'MTD' }],
    ['Dashboard: UMSHA', users.owner, 'dashboard.get', { tab: 'UMSHA', period: 'MTD' }],
    ['Dashboard: Mirae (Store)', users.store, 'dashboard.get', { tab: 'MIRAE', period: 'MTD' }],
    ['Dashboard: Operations', users.owner, 'dashboard.get', { tab: 'OPERATIONS', period: 'MTD' }],
    ['Dashboard: Customers', users.owner, 'dashboard.get', { tab: 'CUSTOMERS', period: 'MTD' }],
    ['Dashboard: Controls', users.owner, 'dashboard.get', { tab: 'CONTROLS', period: 'MTD' }],
    ['Banking', users.finance, 'bankrec.list', {}],
    ['Chart of accounts', users.finance, 'accounts.list', {}],
  ];
  const reports = [
    ['P&L by brand', users.owner, 'reports.pnl', Object.assign({ allocate: 'REVENUE' }, R)],
    ['Balance sheet', users.owner, 'reports.balanceSheet', { asOf: '2026-10-28' }],
    ['Trial balance', users.owner, 'reports.trialBalance', { asOf: '2026-10-28' }],
    ['Cash position', users.owner, 'reports.cashPosition', { asOf: '2026-10-28' }],
    ['Account ledger 1100', users.owner, 'ledger.account', { accountCode: '1100' }],
    ['Profit by order', users.owner, 'reports.jobProfitability', R],
    ['SKU margin', users.owner, 'reports.skuMargin', R],
    ['AR ageing', users.owner, 'reports.arAgeing', { asOf: '2026-10-28' }],
    ['AP ageing', users.owner, 'reports.apAgeing', { asOf: '2026-10-28' }],
    ['Sales tax', users.owner, 'reports.salesTax', R],
    ['WHT register', users.owner, 'reports.whtRegister', R],
    ['Audit log', users.owner, 'reports.auditLog', R],
    ['Month-end checklist', users.finance, 'periods.checklist', { periodId: '2026-09' }],
    ['QuickBooks export', users.finance, 'export.quickbooksJournals', R],
  ];
  const writes = [
    ['Sale (write)', users.store, 'sale.create', { date: '2026-10-28', lines: [{ itemId: b.skus[1], qty: 1, unitPricePaisa: 590000 }], payments: [{ method: 'CASH', accountCode: '1020', amountPaisa: 590000 }] }],
    ['Advance (write)', users.studio, 'contacts.upsert', { kind: 'CUSTOMER', name: 'New', phone: '03339999999' }],
  ];
  const rows = [];
  const run = (list, limit, kind) => list.forEach(([label, email, action, payload]) => rows.push(Object.assign(measure(gas, label, email, action, payload), { limit, kind })));
  run(screens, 3, 'screen');
  run(reports, 8, 'report');
  run(writes, 3, 'write');
  const pad = (x, n) => String(x).padEnd(n);
  const padL = (x, n) => String(x).padStart(n);
  console.log(pad('Screen / report', 36) + padL('Node ms', 9) + padL('cells read', 12) + padL('est. s', 8) + padL('limit', 7));
  let failed = 0;
  rows.forEach((r) => {
    const bad = r.est > r.limit;
    if (bad) failed++;
    console.log(pad(r.label, 36) + padL(r.ms, 9) + padL(r.cells, 12) + padL(r.est, 8) + padL(r.limit + ' s', 7) + (bad ? '  OVER' : ''));
  });
  console.log('\n' + (failed ? failed + ' over the target' : 'All within the targets') + ' (estimates; confirm on a copy of the real Sheet).');
  process.exitCode = failed ? 1 : 0;
}

module.exports = { build, measure };
