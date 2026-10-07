// An in-memory stand-in for the Apps Script server, for tests only. It holds
// the "tabs", assembles the posting ctx from them, posts through
// core/posting.js and stores the result the way the Sheet will (allocating
// IDs, applying docUpdates). The real server is milestone M2.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const Money = require('../../core/money.js');
const Ids = require('../../core/ids.js');
const Validate = require('../../core/validate.js');
const Inventory = require('../../core/inventory.js');
const Posting = require('../../core/posting.js');
const Reports = require('../../core/reports.js');

const SEED = path.join(__dirname, '..', '..', 'seed');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
}

function seedCsv(name) {
  return parseCsv(fs.readFileSync(path.join(SEED, name), 'utf8'));
}

// Tax codes used by docs/08-test-scenarios.md. TEST FIXTURES ONLY.
const TEST_TAX_CODES = [
  { id: 'TEST-ST-18', kind: 'SALES_OUTPUT', rateBps: 1800, claimable: 'FALSE', whtBase: '', appliesTo: 'GOODS', vendorFilerStatus: 'ANY', effectiveFrom: '2025-07-01', effectiveTo: '', isActive: 'TRUE' },
  { id: 'TEST-ST-IN-18', kind: 'PURCHASE_INPUT', rateBps: 1800, claimable: 'TRUE', whtBase: '', appliesTo: 'GOODS', vendorFilerStatus: 'ANY', effectiveFrom: '2025-07-01', effectiveTo: '', isActive: 'TRUE' },
  { id: 'TEST-WHT-SVC-10', kind: 'WHT', rateBps: 1000, claimable: 'FALSE', whtBase: 'EXCL_SALES_TAX', appliesTo: 'SERVICES', vendorFilerStatus: 'ANY', effectiveFrom: '2025-07-01', effectiveTo: '', isActive: 'TRUE' },
  { id: 'TEST-WHT-GOODS-4.5', kind: 'WHT', rateBps: 450, claimable: 'FALSE', whtBase: 'EXCL_SALES_TAX', appliesTo: 'GOODS', vendorFilerStatus: 'ANY', effectiveFrom: '2025-07-01', effectiveTo: '', isActive: 'TRUE' },
];

const DOC_PREFIX = {
  createBill: 'BILL', karigarWork: 'BILL', deliverJob: 'INV', createSale: 'SALE', returnSale: 'SALE', exchangeSale: 'SALE',
  postStockCount: 'CNT', cashUp: 'CUP',
};

class Book {
  constructor(opts) {
    const o = opts || {};
    this.accountRows = seedCsv('chart_of_accounts.csv');
    this.settings = Object.fromEntries(seedCsv('settings.csv').map((r) => [r.key, r.value]));
    Object.assign(this.settings, o.settings || {});
    this.taxCodes = TEST_TAX_CODES.concat(seedCsv('tax_codes.csv'));
    this.periods = [];
    this.contacts = {};
    this.items = {};
    this.jobs = {};
    this.bills = {};
    this.invoices = {};
    this.sales = {};
    this.otherDocs = {};
    this.journals = {};
    this.journalOrder = [];
    this.lines = [];
    this.stockMoves = [];
    this.itemBalances = {};
    this.sequences = {};
    this.acc = Validate.indexAccounts(this.accountRows);
  }

  nextDocId(prefix, date) {
    const key = Ids.docSequenceKey(prefix, Ids.yearOfDate(date));
    const r = Ids.reserveNumbers(this.sequences[key], 1);
    this.sequences[key] = r.next;
    return Ids.formatDocId(prefix, Ids.yearOfDate(date), r.numbers[0]);
  }

  addContact(c) { this.contacts[c.id] = Object.assign({ kind: 'VENDOR', name: c.id, strn: '', filerStatus: '', whtTaxCodeId: '' }, c); return this.contacts[c.id]; }
  addItem(i) { this.items[i.id] = Object.assign({ unit: 'PC', taxCodeId: '' }, i); return this.items[i.id]; }
  addJob(j) {
    const job = Object.assign({ status: 'OPEN', lines: [], brand: j.type === 'RTW_BATCH' ? 'MIRAE' : 'UMSHA' }, j);
    if (!job.id) job.id = this.nextDocId('JOB', job.bookedDate || '2026-10-01');
    this.jobs[job.id] = job;
    return job;
  }

  ctx() {
    return Object.assign({}, this.acc, {
      taxCodes: this.taxCodes,
      settings: this.settings,
      periods: this.periods,
      itemBalances: this.itemBalances,
      items: this.items,
      contacts: this.contacts,
      jobs: this.jobs,
      jobWip: Reports.jobWip(this.lines, this.acc),
      jobAdvances: Reports.jobAdvances(this.lines, this.acc),
      bills: this.bills,
      invoices: this.invoices,
      sales: this.sales,
      stockMoves: this.stockMoves,
      journals: this.journals,
      paymentsByJe: this.paymentsByJe(),
    });
  }

  // Build, validate and store one document. Throws the builder's coded error.
  post(builder, input) {
    const data = Object.assign({}, input);
    if (!data.docId && DOC_PREFIX[builder]) data.docId = this.nextDocId(DOC_PREFIX[builder], data.date);
    if (!data.docId && ['receiveAdvance', 'payBills', 'payVendorAdvance', 'createExpense', 'recordDrawings', 'receivePayment',
      'settleCards', 'transfer', 'settleSalesTax', 'depositWht'].indexOf(builder) >= 0) {
      data.docId = this.nextDocId('PAY', data.date);
    }
    const ctx = this.ctx();
    const entry = Posting[builder](data, ctx);
    assert.deepEqual(Validate.validateEntry(entry, ctx), [], builder + ' produced an invalid entry');
    return this.apply(builder, entry);
  }

  apply(builder, entry) {
    let jeId = '';
    const stored = { lines: [], stockMoves: [] };
    if (entry.journal) {
      jeId = this.nextDocId('JE', entry.journal.date);
      stored.journal = Object.assign({}, entry.journal, { id: jeId });
      entry.lines.forEach((l, i) => {
        const line = Object.assign({ id: Ids.formatLineId(jeId, i + 1), jeId: jeId, date: entry.journal.date, isClosing: !!entry.journal.isClosing }, l);
        stored.lines.push(line);
        this.lines.push(line);
      });
      this.journals[jeId] = stored;
      this.journalOrder.push(jeId);
    }
    entry.stockMoves.forEach((m) => {
      const move = Object.assign({ id: this.nextDocId('SM', m.date), jeId: jeId }, m);
      stored.stockMoves.push(move);
      this.stockMoves.push(move);
    });
    entry.itemBalanceUpdates.forEach((b) => { this.itemBalances[b.itemId] = b; });
    entry.docUpdates.forEach((u) => this.applyUpdate(u, jeId));
    if (entry.doc) this.storeDoc(builder, entry.doc, jeId);
    return { jeId: jeId, entry: entry, lines: stored.lines, stockMoves: stored.stockMoves, doc: entry.doc };
  }

  applyUpdate(u, jeId) {
    const fields = {};
    Object.keys(u.fields).forEach((k) => { fields[k] = u.fields[k] === Posting.NEW_JE_ID ? jeId : u.fields[k]; });
    let target;
    if (u.docType === 'BILL') target = this.bills[u.id];
    else if (u.docType === 'INVOICE') target = this.invoices[u.id];
    else if (u.docType === 'JOB') target = this.jobs[u.id];
    else if (u.docType === 'JOURNAL') target = this.journals[u.id].journal;
    else if (u.docType === 'SALE') target = this.sales[u.id] && this.sales[u.id].sale;
    else if (u.docType === 'SALE_LINE') {
      Object.values(this.sales).forEach((s) => s.lines.forEach((l) => { if (l.id === u.id) target = l; }));
    } else target = this.otherDocs[u.id];
    assert.ok(target, 'docUpdate target ' + u.docType + ' ' + u.id + ' not found');
    Object.assign(target, fields);
  }

  storeDoc(builder, doc, jeId) {
    const d = Object.assign({ jeId: jeId, status: 'POSTED' }, doc);
    if (builder === 'createBill' || builder === 'karigarWork') this.bills[d.id] = d;
    else if (builder === 'deliverJob') this.invoices[d.id] = d;
    else if (DOC_PREFIX[builder] === 'SALE') {
      d.lines = (d.lines || []).map((l, i) => Object.assign({ id: Ids.formatLineId(d.id, i + 1) }, l));
      this.sales[d.id] = { sale: d, lines: d.lines };
    } else if (d.id) this.otherDocs[d.id] = d;
  }

  // Payments with allocations, by the journal entry that posted them.
  paymentsByJe() {
    const out = {};
    Object.values(this.otherDocs).forEach((d) => {
      if (!d.jeId || !Array.isArray(d.allocations) || !d.allocations.length) return;
      (out[d.jeId] = out[d.jeId] || []).push({ payment: d, allocations: d.allocations });
    });
    return out;
  }

  docOf(id) {
    return this.bills[id] || this.invoices[id] || (this.sales[id] && this.sales[id].sale) || this.otherDocs[id];
  }
}

// Rupees as written in the docs ("27,777.78") to paisa.
function rs(x) {
  return Money.parseRupees(String(x));
}

// Debits and credits summed per account and brand, for comparing an entry
// with the expected journal in docs/08 (which shows one line per account).
function summarize(lines) {
  const out = {};
  lines.forEach((l) => {
    if (l.debitPaisa) out['Dr ' + l.accountCode + ' ' + l.brand] = (out['Dr ' + l.accountCode + ' ' + l.brand] || 0) + l.debitPaisa;
    if (l.creditPaisa) out['Cr ' + l.accountCode + ' ' + l.brand] = (out['Cr ' + l.accountCode + ' ' + l.brand] || 0) + l.creditPaisa;
  });
  return out;
}

// expected: [['Dr', '1100', 'UMSHA', '300,000'], ...] in rupees.
function expectJournal(lines, expected) {
  const want = {};
  expected.forEach((e) => { want[e[0] + ' ' + e[1] + ' ' + e[2]] = (want[e[0] + ' ' + e[1] + ' ' + e[2]] || 0) + rs(e[3]); });
  assert.deepEqual(summarize(lines), want);
}

function lineTotals(lines) {
  return {
    debit: lines.reduce((s, l) => s + l.debitPaisa, 0),
    credit: lines.reduce((s, l) => s + l.creditPaisa, 0),
  };
}

module.exports = { Book, rs, summarize, expectJournal, lineTotals, parseCsv, Inventory, Reports, Posting, Validate, Money };
