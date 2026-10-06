// Actions.gs: one handler per API action. Handlers load what they need with
// Db, call Core.gs for every decision and calculation, and queue writes on
// env.tx; Api.gs commits them. Read handlers return data; write handlers
// return {data, audit: {docType, docId, summary, before, after}}.

// ---------- shared ----------

// The posting ctx (core/posting.js header) from the Sheet. Parts are loaded
// only when asked for.
function loadCtx_(parts) {
  var p = parts || {};
  var ctx = Object.assign({}, Validate.indexAccounts(Db.read('Accounts')), {
    taxCodes: Db.read('TaxCodes'),
    settings: Db.settings(),
    periods: Db.read('Periods'),
  });
  if (p.jobs) {
    var linesByJob = {};
    Db.read('JobLines').forEach(function (l) { (linesByJob[l.jobId] = linesByJob[l.jobId] || []).push(l); });
    ctx.jobs = {};
    Db.read('Jobs').forEach(function (j) {
      ctx.jobs[j.id] = Object.assign({}, j, {
        lines: (linesByJob[j.id] || []).slice().sort(function (a, b) { return a.sortOrder - b.sortOrder; }),
      });
    });
  }
  if (p.ledger) {
    var lines = Db.read('JournalLines');
    ctx.jobWip = Reports.jobWip(lines, ctx);
    ctx.jobAdvances = Reports.jobAdvances(lines, ctx);
  }
  if (p.contacts) ctx.contacts = Db.byKey('Contacts');
  if (p.stock) {
    ctx.items = Db.byKey('Items');
    ctx.itemBalances = Db.byKey('ItemBalances');
    ctx.stockMoves = Db.read('StockMoves');
  }
  return ctx;
}

// Every journal line with Journal.isClosing joined on (reports need it).
function linesWithClosing_() {
  var closing = {};
  Db.read('Journal').forEach(function (j) { if (j.isClosing) closing[j.id] = true; });
  return Db.read('JournalLines').map(function (l) { return closing[l.jeId] ? Object.assign({}, l, { isClosing: true }) : l; });
}

var DOC_TABS = {
  BILL: 'Bills', INVOICE: 'Invoices', JOB: 'Jobs', JOURNAL: 'Journal', SALE: 'Sales', SALE_LINE: 'SaleLines',
  PAYMENT: 'Payments', STOCK_COUNT: 'StockCounts', CASHUP: 'CashUps', EXPENSE: 'Bills',
};

// Payments posted by a journal entry, with their allocations (for reversals).
function paymentsByJe_(jeId) {
  var out = {};
  var pays = Db.read('Payments').filter(function (p) { return p.jeId === jeId && p.status !== 'VOID'; });
  if (pays.length) {
    out[jeId] = pays.map(function (p) {
      return { payment: p, allocations: Db.read('PaymentAllocations').filter(function (a) { return a.paymentId === p.id; }) };
    });
  }
  return out;
}

// A sale with its lines, as Posting.returnSale/exchangeSale expect in ctx.sales.
function saleCtx_(id) {
  var sale = Db.get('Sales', id);
  if (!sale) throw Validate.coreError('E_NOT_FOUND', 'Sale ' + id + ' not found', 'originalSaleId');
  var out = {};
  out[id] = { sale: sale, lines: Db.read('SaleLines').filter(function (l) { return l.saleId === id; }) };
  return out;
}

// Store staff always sell, refund and count in their own store.
function storeFor_(env, p) {
  if (env.user.role === 'STORE') return env.user.store;
  return p.store || '';
}

function persistSale_(env, doc, jeId, payments) {
  env.tx.append('Sales', [Object.assign(docHeader_(env, doc, jeId), {
    brand: 'MIRAE', kind: doc.kind, channel: doc.channel || 'STORE', store: doc.store, netPaisa: doc.netPaisa, taxPaisa: doc.taxPaisa,
    grossPaisa: doc.grossPaisa, discountPaisa: doc.discountPaisa || 0, pricesIncludeTax: !!doc.pricesIncludeTax, fbrInvoiceNo: doc.fbrInvoiceNo || '',
    originalSaleId: doc.originalSaleId || '',
  })]);
  var n = 0;
  var lines = [];
  (doc.returnLines || (doc.kind === 'RETURN' ? doc.lines : [])).forEach(function (l) {
    lines.push({ id: Ids.formatLineId(doc.id, ++n), saleId: doc.id, itemId: l.itemId, qty: -l.qty, netPaisa: -l.netPaisa, taxPaisa: -l.taxPaisa, costPaisa: -l.costPaisa, restock: l.restock, originalLineId: l.originalLineId });
  });
  if (doc.kind !== 'RETURN') {
    (doc.lines || []).forEach(function (l) {
      lines.push(Object.assign({ id: Ids.formatLineId(doc.id, ++n), saleId: doc.id, restock: false, returnedQty: 0, returnedNetPaisa: 0, returnedTaxPaisa: 0, returnedCostPaisa: 0, originalLineId: '' }, l));
    });
  }
  env.tx.append('SaleLines', lines);
  env.tx.append('SalePayments', (payments || []).map(function (p, i) {
    return { id: Ids.formatLineId(doc.id, i + 1), saleId: doc.id, method: p.method, accountCode: p.accountCode, amountPaisa: p.amountPaisa, reference: p.reference || '' };
  }));
}

// Open / part-paid / paid, from a bill's balance.
function billState_(b) {
  if (b.status === 'VOID') return 'VOID';
  if (!b.balancePaisa) return 'PAID';
  return b.paidPaisa ? 'PART_PAID' : 'OPEN';
}

// Queue the rows of a posted entry: Journal, JournalLines, StockMoves,
// ItemBalances and the docUpdates. Returns the new IDs.
function postEntry_(env, entry) {
  var tx = env.tx;
  var jeId = '';
  if (entry.journal) {
    jeId = tx.nextDocId('JE', entry.journal.date);
    tx.append('Journal', [Object.assign({}, entry.journal, {
      id: jeId, requestId: env.requestId, createdBy: env.user.email, createdAt: env.ts,
    })]);
    tx.append('JournalLines', entry.lines.map(function (l, i) {
      return Object.assign({}, l, { id: Ids.formatLineId(jeId, i + 1), jeId: jeId, date: entry.journal.date, reconciled: false, reconciledDate: '' });
    }));
  }
  var lastMove = {};
  var moveIds = entry.stockMoves.map(function (m) {
    var id = tx.nextDocId('SM', m.date);
    tx.append('StockMoves', [Object.assign({}, m, { id: id, jeId: jeId, createdAt: env.ts })]);
    lastMove[m.itemId] = id;
    return id;
  });
  entry.itemBalanceUpdates.forEach(function (b) {
    tx.upsert('ItemBalances', Object.assign({}, b, { lastMoveId: lastMove[b.itemId] || '', updatedAt: env.ts }));
  });
  entry.docUpdates.forEach(function (u) {
    var tab = DOC_TABS[u.docType];
    if (!tab) throw Validate.coreError('E_INTERNAL', 'No tab for document type ' + u.docType);
    var fields = {};
    Object.keys(u.fields).forEach(function (k) { fields[k] = u.fields[k] === Posting.NEW_JE_ID ? jeId : u.fields[k]; });
    tx.update(tab, u.id, fields);
  });
  return { jeId: jeId, moveIds: moveIds };
}

// The header fields every document row shares (docs/04 Documents).
function docHeader_(env, doc, jeId) {
  return {
    id: doc.id, date: doc.date, contactId: doc.contactId || '', brand: doc.brand || '', status: 'POSTED', memo: doc.memo || '',
    jeId: jeId, attachmentIds: '', requestId: env.requestId, createdBy: env.user.email, createdAt: env.ts,
  };
}

// Bills with grossByBrand (Σ net + tax of their lines per brand), as payBills needs.
function billsCtx_() {
  var byBill = {};
  Db.read('BillLines').forEach(function (l) {
    var b = (byBill[l.billId] = byBill[l.billId] || {});
    b[l.brand] = (b[l.brand] || 0) + (l.netPaisa || 0) + (l.taxPaisa || 0);
  });
  var out = {};
  Db.read('Bills').forEach(function (b) { out[b.id] = Object.assign({}, b, { grossByBrand: byBill[b.id] || {} }); });
  return out;
}

function persistBill_(env, doc, jeId) {
  var brands = Object.keys(doc.grossByBrand || {});
  env.tx.append('Bills', [Object.assign(docHeader_(env, doc, jeId), {
    brand: brands.length === 1 ? brands[0] : 'SHARED', memo: doc.memo || '', vendorRef: doc.vendorRef, dueDate: doc.dueDate,
    netPaisa: doc.netPaisa, taxPaisa: doc.taxPaisa, grossPaisa: doc.grossPaisa, paidPaisa: doc.paidPaisa || 0, whtPaisa: doc.whtPaisa || 0,
    balancePaisa: doc.balancePaisa,
  })]);
  env.tx.append('BillLines', doc.lines.map(function (l, i) { return Object.assign({ id: Ids.formatLineId(doc.id, i + 1), billId: doc.id }, l); }));
}

function persistPayment_(env, doc, jeId, memo) {
  env.tx.append('Payments', [Object.assign(docHeader_(env, doc, jeId), {
    memo: memo || '', direction: doc.direction, kind: doc.kind, moneyAccountCode: doc.moneyAccountCode || '', amountPaisa: doc.amountPaisa,
    whtPaisa: doc.whtPaisa || 0, whtTaxCodeId: doc.whtTaxCodeId || '', currency: doc.currency || '', fxAmount: doc.fxAmount || '',
    fxRate: doc.fxRate || '', reference: doc.reference || '',
  })]);
  env.tx.append('PaymentAllocations', (doc.allocations || []).map(function (a, i) {
    return { id: Ids.formatLineId(doc.id, i + 1), paymentId: doc.id, docType: a.docType, docId: a.docId, amountPaisa: a.amountPaisa, whtPaisa: a.whtPaisa || 0 };
  }));
}

function persistInvoice_(env, doc, jeId) {
  env.tx.append('Invoices', [Object.assign(docHeader_(env, doc, jeId), {
    jobId: doc.jobId, dueDate: doc.dueDate, netPaisa: doc.netPaisa, taxPaisa: doc.taxPaisa, grossPaisa: doc.grossPaisa,
    taxCodeId: doc.taxCodeId, taxOverrideReason: doc.taxOverrideReason, advanceAppliedPaisa: doc.advanceAppliedPaisa,
    paidPaisa: 0, balancePaisa: doc.balancePaisa,
  })]);
  env.tx.append('InvoiceLines', doc.lines.map(function (l, i) { return Object.assign({ id: Ids.formatLineId(doc.id, i + 1), invoiceId: doc.id }, l); }));
}

// Sales tax rate of a job's tax code on a date (0 if none).
function jobRateBps_(ctx, job, date) {
  var code = Posting.findTaxCode(ctx, job.taxCodeId, date || job.bookedDate, ['SALES_OUTPUT', 'EXEMPT', 'ZERO']);
  return code ? code.rateBps : 0;
}

// What the customer still owes on an order: invoice balance once delivered,
// otherwise quoted gross less advances held.
function orderBalance_(ctx, job, advanceHeld) {
  if (job.invoiceId) {
    var inv = Db.get('Invoices', job.invoiceId);
    if (inv && inv.status !== 'VOID') return inv.balancePaisa;
  }
  return Math.max(0, Receipts.orderGross(job.quotedPricePaisa, jobRateBps_(ctx, job)) - Math.max(0, advanceHeld || 0));
}

function need_(value, field, label) {
  if (Validate.isBlank(value)) throw Validate.coreError('E_VALIDATION', label, field);
  return value;
}

function textMatch_(hay, q) {
  return String(hay || '').toLowerCase().indexOf(q) >= 0;
}

function byCode_(a, b) {
  return (a.sortOrder || 0) - (b.sortOrder || 0) || (a.code < b.code ? -1 : 1);
}

var SETTING_RULES = {
  allocationKey: function (v) { return ['REVENUE', 'FIXED', 'NONE'].indexOf(v) >= 0; },
  allocationUmshaPctBps: function (v) { return /^\d+$/.test(v) && Number(v) <= 10000; },
  rtwPricesIncludeTax: function (v) { return v === 'TRUE' || v === 'FALSE'; },
  allowNegativeStock: function (v) { return v === 'TRUE' || v === 'FALSE'; },
  fiscalYearStartMonth: function (v) { return /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 12; },
  currencyGrouping: function (v) { return v === 'STANDARD' || v === 'INDIAN'; },
  baseCurrency: function (v) { return v === 'PKR'; },
  timezone: function (v) { return v === 'Asia/Karachi'; },
};

// ---------- handlers ----------

var Actions = {
  'session.me': function (p, env) {
    var u = env.user;
    return {
      email: u.email, name: u.name, role: u.role, store: u.store,
      settings: Db.settings(),
      accounts: Db.read('Accounts').filter(function (a) { return a.isActive; }).slice().sort(byCode_),
      taxCodes: Db.read('TaxCodes').filter(function (t) { return t.isActive; }),
      today: env.today,
    };
  },

  'setup.run': function (p, env) {
    var result = Setup.run(env.tx);
    return { data: result, audit: { docType: 'SETUP', summary: Setup.summary_(result), after: result } };
  },

  'settings.update': function (p, env) {
    var key = need_(p.key, 'key', 'Choose a setting');
    var known = SEED.settings.map(function (s) { return s.key; });
    if (known.indexOf(key) === -1) throw Validate.coreError('E_VALIDATION', 'Unknown setting ' + key, 'key');
    var value = Validate.isBlank(p.value) ? '' : String(p.value).trim();
    if (SETTING_RULES[key] && !SETTING_RULES[key](value)) throw Validate.coreError('E_VALIDATION', 'That is not a valid value for ' + key, 'value');
    if (key === 'defaultMtoRevenueAccount') {
      var a = Db.get('Accounts', value);
      if (!a || a.type !== 'REVENUE') throw Validate.coreError('E_VALIDATION', 'Choose a revenue account', 'value');
    }
    var before = Db.get('Settings', key);
    if (before) env.tx.update('Settings', key, { value: value });
    else env.tx.append('Settings', [{ key: key, value: value }]);
    return { data: { key: key, value: value }, audit: { docType: 'SETTING', docId: key, summary: 'Changed ' + key, before: before ? before.value : '', after: value } };
  },

  'users.list': function () {
    return Db.read('Users');
  },

  'users.upsert': function (p, env) {
    var users = Db.read('Users');
    var existing = p.id ? Db.get('Users', p.id) : null;
    if (p.id && !existing) throw Validate.coreError('E_NOT_FOUND', 'User ' + p.id + ' not found', 'id');
    var row = Master.prepareUser(p, existing, users).row;
    var owners = users.filter(function (u) { return u.role === 'OWNER' && u.isActive && (!existing || u.id !== existing.id); });
    if (!owners.length && (row.role !== 'OWNER' || !row.isActive)) {
      throw Validate.coreError('E_VALIDATION', 'There must always be at least one active Owner', 'role');
    }
    var id = existing ? existing.id : env.tx.nextMasterId('USR');
    if (existing) env.tx.update('Users', id, row);
    else env.tx.append('Users', [Object.assign({ id: id, createdAt: env.ts }, row)]);
    return { data: Object.assign({ id: id }, row), audit: { docType: 'USER', docId: id, summary: (existing ? 'Updated' : 'Added') + ' user ' + row.email + ' as ' + row.role, before: existing || '', after: row } };
  },

  'periods.list': function () {
    return Db.read('Periods').slice().sort(function (a, b) { return a.id < b.id ? 1 : -1; });
  },

  'periods.checklist': function (p) {
    Dates.periodBounds(p.periodId);
    return Reports.closeChecklist(p.periodId, {
      lines: Db.read('JournalLines'), stockMoves: Db.read('StockMoves'), acc: Validate.indexAccounts(Db.read('Accounts')), items: Db.byKey('Items'),
      sales: Db.read('Sales'), cashUps: Db.read('CashUps'), stockCounts: Db.read('StockCounts'), periods: Db.read('Periods'), bankRecs: Db.read('BankRecs'),
    });
  },

  // TODO(decision-D-11): any Owner can close and reopen.
  'periods.close': function (p, env) {
    var b = Dates.periodBounds(p.periodId);
    var row = Db.get('Periods', b.id);
    if (row && row.status === 'CLOSED') throw Validate.coreError('E_VALIDATION', b.id + ' is already closed', 'periodId');
    var list = Actions['periods.checklist']({ periodId: b.id });
    var failing = list.checks.filter(function (c) { return !c.ok; });
    if (!list.canClose) {
      throw Validate.coreError('E_VALIDATION', 'Cannot close ' + b.id + ': ' + failing.filter(function (c) { return c.blocking; }).map(function (c) { return c.label + (c.detail ? ' (' + c.detail + ')' : ''); }).join('; '), 'periodId');
    }
    if (failing.length && !p.acknowledgeWarnings) {
      throw Validate.coreError('E_VALIDATION', 'Before closing ' + b.id + ', confirm these: ' + failing.map(function (c) { return c.label; }).join('; '), 'acknowledgeWarnings');
    }
    var fields = { status: 'CLOSED', closedBy: env.user.email, closedAt: env.ts, reopenReason: '' };
    if (row) env.tx.update('Periods', b.id, fields);
    else env.tx.append('Periods', [Object.assign({}, b, fields)]);
    return {
      data: Object.assign({}, b, fields, { warnings: failing.map(function (c) { return c.label; }) }),
      audit: { docType: 'PERIOD', docId: b.id, summary: 'Closed ' + b.id + (failing.length ? ' (acknowledged: ' + failing.map(function (c) { return c.label; }).join('; ') + ')' : ''), before: row ? row.status : 'OPEN', after: 'CLOSED' },
    };
  },

  // R23: close the fiscal year's P&L into retained earnings.
  'year.close': function (p, env) {
    var ctx = loadCtx_({});
    var entry = Posting.closeYear({ date: need_(p.fiscalYearEnd, 'fiscalYearEnd', 'Enter the last day of the fiscal year'), lines: linesWithClosing_() }, ctx);
    var ids = postEntry_(env, entry);
    return { data: Object.assign({ jeId: ids.jeId }, entry.doc), audit: { docType: 'JOURNAL', docId: ids.jeId, summary: 'Year-end close to ' + p.fiscalYearEnd + ': net profit ' + Money.formatPaisa(entry.doc.netProfitPaisa) } };
  },

  'periods.reopen': function (p, env) {
    var b = Dates.periodBounds(p.periodId);
    var reason = need_(p.reason && String(p.reason).trim(), 'reason', 'Say why the period is being reopened');
    var row = Db.get('Periods', b.id);
    if (!row || row.status !== 'CLOSED') throw Validate.coreError('E_VALIDATION', b.id + ' is not closed', 'periodId');
    env.tx.update('Periods', b.id, { status: 'OPEN', reopenReason: reason });
    return { data: Object.assign({}, row, { status: 'OPEN', reopenReason: reason }), audit: { docType: 'PERIOD', docId: b.id, summary: 'Reopened ' + b.id + ': ' + reason, before: 'CLOSED', after: 'OPEN' } };
  },

  // ---------- master data ----------

  'contacts.search': function (p) {
    var q = String(p.q || '').trim().toLowerCase();
    var digits = q.replace(/\D/g, '');
    var kind = p.kind;
    return Db.read('Contacts').filter(function (c) {
      if (!c.isActive && !p.includeInactive) return false;
      if (kind && c.kind !== kind && !(c.kind === 'BOTH' && (kind === 'CUSTOMER' || kind === 'VENDOR'))) return false;
      if (p.vendorType && c.vendorType !== p.vendorType) return false;
      if (!q) return true;
      return textMatch_(c.name, q) || textMatch_(c.id, q) || (digits.length >= 3 && String(c.phone).indexOf(digits.replace(/^0/, '')) >= 0);
    }).slice(0, Math.min(Number(p.limit) || 20, 100));
  },

  'contacts.get': function (p) {
    var c = Db.get('Contacts', p.id);
    if (!c) throw Validate.coreError('E_NOT_FOUND', 'Contact ' + p.id + ' not found', 'id');
    var acc = Validate.indexAccounts(Db.read('Accounts'));
    var lines = Db.read('JournalLines');
    var cust = Reports.customerBalances(lines, acc)[c.id] || { owesPaisa: 0, advanceHeldPaisa: 0 };
    return Object.assign({}, c, { owesPaisa: cust.owesPaisa, advanceHeldPaisa: cust.advanceHeldPaisa, weOwePaisa: Reports.vendorBalances(lines, acc)[c.id] || 0 });
  },

  'contacts.upsert': function (p, env) {
    var existing = p.id ? Db.get('Contacts', p.id) : null;
    if (p.id && !existing) throw Validate.coreError('E_NOT_FOUND', 'Contact ' + p.id + ' not found', 'id');
    var r = Master.prepareContact(p, existing, Db.read('Contacts'), { taxCodes: Db.read('TaxCodes') });
    var id = existing ? existing.id : env.tx.nextMasterId(r.prefix);
    if (existing) env.tx.update('Contacts', id, r.row);
    else env.tx.append('Contacts', [Object.assign({ id: id, createdBy: env.user.email, createdAt: env.ts }, r.row)]);
    return {
      data: { contact: Object.assign({ id: id }, r.row), warnings: r.warnings },
      audit: { docType: 'CONTACT', docId: id, summary: (existing ? 'Updated ' : 'Added ') + r.row.name, before: existing || '', after: r.row },
    };
  },

  'items.search': function (p) {
    var q = String(p.q || '').trim().toLowerCase();
    var bal = Db.byKey('ItemBalances');
    return Db.read('Items').filter(function (i) {
      if (!i.isActive && !p.includeInactive) return false;
      if (p.category && i.category !== p.category) return false;
      return !q || textMatch_(i.name, q) || textMatch_(i.id, q) || String(i.barcode) === q || textMatch_(i.style, q);
    }).slice(0, Math.min(Number(p.limit) || 50, 500)).map(function (i) {
      var b = bal[i.id] || { qty: 0, avgCostMicro: 0, valuePaisa: 0 };
      return Object.assign({}, i, { qty: b.qty, avgCostMicro: b.avgCostMicro, valuePaisa: b.valuePaisa });
    });
  },

  'items.get': function (p) {
    var i = Db.get('Items', p.id);
    if (!i) throw Validate.coreError('E_NOT_FOUND', 'Item ' + p.id + ' not found', 'id');
    var b = Db.get('ItemBalances', i.id) || { qty: 0, avgCostMicro: 0, valuePaisa: 0 };
    return Object.assign({}, i, { qty: b.qty, avgCostMicro: b.avgCostMicro, valuePaisa: b.valuePaisa });
  },

  'items.upsert': function (p, env) {
    var existing = p.id ? Db.get('Items', p.id) : null;
    var items = Db.read('Items');
    var r = Master.prepareItem(p, existing, items, { taxCodes: Db.read('TaxCodes') });
    var id = existing ? existing.id : (r.id || env.tx.nextMasterId(r.prefix));
    if (existing) env.tx.update('Items', id, r.row);
    else env.tx.append('Items', [Object.assign({ id: id, createdAt: env.ts }, r.row)]);
    return {
      data: { item: Object.assign({ id: id }, r.row), warnings: r.warnings },
      audit: { docType: 'ITEM', docId: id, summary: (existing ? 'Updated ' : 'Added ') + r.row.name, before: existing || '', after: r.row },
    };
  },

  // ---------- jobs ----------

  'jobs.create': function (p, env) {
    var ctx = loadCtx_({ contacts: true });
    ctx.items = Db.byKey('Items');
    var r = Master.prepareJob(p, ctx, env.today);
    var id = env.tx.nextDocId('JOB', r.job.bookedDate);
    env.tx.append('Jobs', [Object.assign({ id: id, createdBy: env.user.email, createdAt: env.ts }, r.job)]);
    env.tx.append('JobLines', r.lines.map(function (l, i) { return Object.assign({ id: Ids.formatLineId(id, i + 1), jobId: id }, l); }));
    return {
      data: { job: Object.assign({ id: id }, r.job), lines: r.lines },
      audit: { docType: 'JOB', docId: id, summary: 'New ' + (r.job.type === 'MTO_ORDER' ? 'order' : 'batch') + ' ' + r.job.title, after: r.job },
    };
  },

  'jobs.get': function (p) {
    var job = Db.get('Jobs', p.id);
    if (!job) throw Validate.coreError('E_NOT_FOUND', 'Job ' + p.id + ' not found', 'id');
    var acc = Validate.indexAccounts(Db.read('Accounts'));
    var lines = Db.read('JournalLines');
    var payments = Db.read('PaymentAllocations').filter(function (a) { return a.docType === 'JOB' && a.docId === job.id; }).map(function (a) {
      return Object.assign({}, Db.get('Payments', a.paymentId) || {}, { allocatedPaisa: a.amountPaisa });
    });
    var cost = Reports.jobCostSheet(lines, acc, job.id);
    var ctx = Object.assign({}, acc, { taxCodes: Db.read('TaxCodes') });
    var held = Reports.jobAdvances(lines, acc)[job.id] || 0;
    var journals = Db.byKey('Journal');
    var entries = {};
    lines.forEach(function (l) {
      if (l.jobId !== job.id) return;
      var e = entries[l.jeId];
      if (!e) {
        var j = journals[l.jeId] || {};
        e = entries[l.jeId] = { jeId: l.jeId, date: l.date, docType: j.docType || '', docId: j.docId || '', memo: j.memo || '', reversed: !!j.reversedByJeId, isReversal: !!j.reversesJeId, amountPaisa: 0, dr: 0, cr: 0 };
      }
      e.dr += l.debitPaisa;
      e.cr += l.creditPaisa;
    });
    // What a person would call the amount: the invoice total for a delivery,
    // otherwise the larger side of this job's lines in the entry.
    Object.keys(entries).forEach(function (k) {
      var e = entries[k];
      var inv = e.docType === 'INVOICE' ? Db.get('Invoices', e.docId) : null;
      e.amountPaisa = inv ? inv.grossPaisa : Math.max(e.dr, e.cr);
      delete e.dr; delete e.cr;
    });
    var rate = job.type === 'MTO_ORDER' ? jobRateBps_(ctx, job) : 0;
    var moves = Db.read('StockMoves');
    var items = Db.byKey('Items');
    var issues = moves.filter(function (m) { return m.moveType === 'ISSUE' && m.jobId === job.id; }).map(function (m) {
      var back = 0;
      moves.forEach(function (x) { if (x.sourceMoveId === m.id && x.moveType === 'RETURN_TO_STOCK') back += Inventory.toMilli(x.qty); });
      var it = items[m.itemId] || {};
      return { moveId: m.id, date: m.date, itemId: m.itemId, itemName: it.name || m.itemId, unit: it.unit || '', qty: -m.qty, valuePaisa: -m.valuePaisa, returnableQty: Inventory.fromMilli(-Inventory.toMilli(m.qty) - back) };
    });
    return {
      job: job,
      issues: issues,
      contact: job.contactId ? Db.get('Contacts', job.contactId) : null,
      lines: Db.read('JobLines').filter(function (l) { return l.jobId === job.id; }).sort(function (a, b) { return a.sortOrder - b.sortOrder; }),
      costSheet: cost,
      advanceHeldPaisa: held,
      advances: payments,
      invoice: job.invoiceId ? Db.get('Invoices', job.invoiceId) : null,
      taxRateBps: rate,
      orderGrossPaisa: job.type === 'MTO_ORDER' ? Receipts.orderGross(job.quotedPricePaisa, rate) : null,
      balanceDuePaisa: job.type === 'MTO_ORDER' ? orderBalance_(ctx, job, held) : null,
      projectedMarginPaisa: job.type === 'MTO_ORDER' ? job.quotedPricePaisa - cost.totalPaisa : null,
      entries: Object.keys(entries).map(function (k) { return entries[k]; }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.jeId < b.jeId ? -1 : 1; }),
    };
  },

  'jobs.list': function (p) {
    var acc = Validate.indexAccounts(Db.read('Accounts'));
    var lines = Db.read('JournalLines');
    var adv = Reports.jobAdvances(lines, acc);
    var costs = {};
    var wipCode = acc.accountsBySystemKey.WIP.code;
    lines.forEach(function (l) {
      if (!l.jobId) return;
      var a = acc.accountsByCode[l.accountCode];
      if (l.accountCode === wipCode || (a && a.type === 'COGS')) costs[l.jobId] = (costs[l.jobId] || 0) + l.debitPaisa - l.creditPaisa;
    });
    return Db.read('Jobs').filter(function (j) {
      return (!p.type || j.type === p.type) && (!p.status || j.status === p.status) && (!p.contactId || j.contactId === p.contactId) &&
        (!p.from || j.bookedDate >= p.from) && (!p.to || j.bookedDate <= p.to);
    }).map(function (j) {
      var c = j.contactId ? Db.get('Contacts', j.contactId) : null;
      return Object.assign({}, j, { contactName: c ? c.name : '', advanceHeldPaisa: adv[j.id] || 0, costToDatePaisa: costs[j.id] || 0 });
    });
  },

  // ---------- money in ----------

  'payments.receiveAdvance': function (p, env) {
    var ctx = loadCtx_({ jobs: true });
    var docId = env.tx.nextDocId('PAY', need_(p.date, 'date', 'Enter the date'));
    var entry = Posting.receiveAdvance(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    var doc = entry.doc;
    persistPayment_(env, doc, ids.jeId, p.memo);
    var job = ctx.jobs[p.jobId];
    return {
      data: { paymentId: docId, jeId: ids.jeId, amountPaisa: doc.amountPaisa, jobId: job.id, contactId: job.contactId },
      audit: { docType: 'PAYMENT', docId: docId, summary: 'Advance ' + Money.formatPaisa(doc.amountPaisa) + ' on ' + job.id },
    };
  },

  'jobs.update': function (p, env) {
    var job = Db.get('Jobs', need_(p.id, 'id', 'Choose the job'));
    if (!job) throw Validate.coreError('E_NOT_FOUND', 'Job ' + p.id + ' not found', 'id');
    var existing = Db.read('JobLines').filter(function (l) { return l.jobId === job.id; });
    var r = Master.prepareJobUpdate(job, existing, p, { items: Db.byKey('Items') });
    if (Object.keys(r.fields).length) env.tx.update('Jobs', job.id, r.fields);
    r.lineUpdates.forEach(function (u) { env.tx.update('JobLines', u.id, u.fields); });
    var n = existing.length;
    if (r.newLines.length) env.tx.append('JobLines', r.newLines.map(function (l, i) { return Object.assign({ id: Ids.formatLineId(job.id, n + i + 1), jobId: job.id }, l); }));
    return {
      data: { job: Object.assign({}, job, r.fields), addedLines: r.newLines.length },
      audit: { docType: 'JOB', docId: job.id, summary: 'Updated ' + job.id, before: job, after: r },
    };
  },

  'jobs.deliver': function (p, env) {
    var ctx = loadCtx_({ jobs: true, ledger: true });
    var date = need_(p.date, 'date', 'Enter the delivery date');
    var docId = env.tx.nextDocId('INV', date);
    var entry = Posting.deliverJob(Object.assign({}, p, { docId: docId, date: date }), ctx);
    var ids = postEntry_(env, entry);
    var doc = Object.assign({}, entry.doc, { memo: p.memo || '' });
    persistInvoice_(env, doc, ids.jeId);
    return {
      data: { invoice: doc, jeId: ids.jeId },
      audit: { docType: 'INVOICE', docId: docId, summary: 'Delivered ' + p.jobId + ', invoice ' + Money.formatPaisa(doc.grossPaisa) + ', margin ' + Money.formatPaisa(doc.marginPaisa) },
    };
  },

  'payments.receive': function (p, env) {
    var ctx = loadCtx_({ contacts: true });
    ctx.invoices = Db.byKey('Invoices');
    var docId = env.tx.nextDocId('PAY', need_(p.date, 'date', 'Enter the date'));
    var allocations = (p.allocations || []).map(function (a, i) {
      if (a.docType && a.docType !== 'INVOICE') throw Validate.coreError('E_VALIDATION', 'Payments are applied to invoices', 'allocations[' + i + '].docType');
      return { invoiceId: a.docId || a.invoiceId, amountPaisa: a.amountPaisa };
    });
    var entry = Posting.receivePayment(Object.assign({}, p, { docId: docId, allocations: allocations }), ctx);
    var ids = postEntry_(env, entry);
    persistPayment_(env, entry.doc, ids.jeId, p.memo);
    return {
      data: { paymentId: docId, jeId: ids.jeId, amountPaisa: entry.doc.amountPaisa },
      audit: { docType: 'PAYMENT', docId: docId, summary: 'Received ' + Money.formatPaisa(entry.doc.amountPaisa) + ' from ' + p.contactId },
    };
  },

  'invoices.get': function (p) {
    var inv = Db.get('Invoices', p.id);
    if (!inv) throw Validate.coreError('E_NOT_FOUND', 'Invoice ' + p.id + ' not found', 'id');
    return {
      invoice: inv,
      lines: Db.read('InvoiceLines').filter(function (l) { return l.invoiceId === inv.id; }),
      contact: Db.get('Contacts', inv.contactId),
      job: inv.jobId ? Db.get('Jobs', inv.jobId) : null,
      payments: Db.read('PaymentAllocations').filter(function (a) { return a.docType === 'INVOICE' && a.docId === inv.id; }).map(function (a) {
        return Object.assign({}, Db.get('Payments', a.paymentId) || {}, { allocatedPaisa: a.amountPaisa });
      }),
    };
  },

  'invoices.list': function (p) {
    return Db.read('Invoices').filter(function (i) {
      return (!p.contactId || i.contactId === p.contactId) && (!p.open || (i.balancePaisa > 0 && i.status !== 'VOID')) &&
        (!p.from || i.date >= p.from) && (!p.to || i.date <= p.to);
    });
  },

  'receipts.render': function (p, env) {
    var settings = Db.settings();
    if (p.docType === 'INVOICE') {
      var data = Actions['invoices.get']({ id: p.docId });
      return Receipts.invoiceDocument({ settings: settings, invoice: data.invoice, lines: data.lines, contact: data.contact, job: data.job });
    }
    if (p.docType === 'SALE') {
      var sd = Actions['sales.get']({ id: p.docId }, env);
      return Receipts.saleReceipt({ settings: settings, sale: sd.sale, lines: sd.lines, payments: sd.payments, contact: sd.contact, items: Db.byKey('Items') });
    }
    if (p.docType !== 'PAYMENT') throw Validate.coreError('E_VALIDATION', 'Receipts are for payments, invoices and sales', 'docType');
    var pay = Db.get('Payments', p.docId);
    if (!pay) throw Validate.coreError('E_NOT_FOUND', 'Payment ' + p.docId + ' not found', 'docId');
    var allocs = Db.read('PaymentAllocations').filter(function (a) { return a.paymentId === pay.id; });
    var alloc = allocs[0];
    var acct = Db.get('Accounts', pay.moneyAccountCode);
    var payment = Object.assign({}, pay, { moneyAccountName: acct ? acct.name : '' });
    if (pay.direction === 'OUT') {
      return Receipts.paymentVoucher({
        settings: settings, payment: payment, contact: Db.get('Contacts', pay.contactId) || {},
        allocations: allocs.filter(function (a) { return a.docType === 'BILL'; }).map(function (a) {
          var b = Db.get('Bills', a.docId) || {};
          return { docId: a.docId, vendorRef: b.vendorRef || '', amountPaisa: a.amountPaisa, whtPaisa: a.whtPaisa || 0 };
        }),
      });
    }
    var args = { settings: settings, payment: payment, contact: Db.get('Contacts', pay.contactId) || {} };
    if (alloc && alloc.docType === 'JOB') {
      var job = Db.get('Jobs', alloc.docId);
      var acc = Validate.indexAccounts(Db.read('Accounts'));
      var ctx = Object.assign({}, acc, { taxCodes: Db.read('TaxCodes') });
      args.job = job;
      args.balancePaisa = orderBalance_(ctx, job, Reports.jobAdvances(Db.read('JournalLines'), acc)[job.id] || 0);
    } else if (alloc && alloc.docType === 'INVOICE') {
      args.invoice = Db.get('Invoices', alloc.docId);
      args.job = args.invoice && args.invoice.jobId ? Db.get('Jobs', args.invoice.jobId) : null;
      args.balancePaisa = args.invoice ? args.invoice.balancePaisa : 0;
    }
    return Receipts.paymentReceipt(args);
  },

  'jobs.issueStock': function (p, env) {
    var ctx = loadCtx_({ jobs: true, stock: true });
    var entry = Posting.issueStock(Object.assign({}, p, { date: need_(p.date, 'date', 'Enter the date') }), ctx);
    var ids = postEntry_(env, entry);
    return {
      data: { jeId: ids.jeId, moveIds: ids.moveIds, valuePaisa: entry.stockMoves.reduce(function (s, m) { return s - m.valuePaisa; }, 0) },
      audit: { docType: 'JOB', docId: p.jobId, summary: 'Issued ' + entry.stockMoves.length + ' item(s) to ' + p.jobId },
    };
  },

  'jobs.returnStock': function (p, env) {
    var ctx = loadCtx_({ jobs: true, stock: true });
    var entry = Posting.returnStock(Object.assign({}, p, { date: need_(p.date, 'date', 'Enter the date') }), ctx);
    var ids = postEntry_(env, entry);
    return { data: { jeId: ids.jeId, moveIds: ids.moveIds }, audit: { docType: 'JOB', docId: p.jobId, summary: 'Returned stock from ' + p.jobId } };
  },

  'bills.create': function (p, env) {
    var ctx = loadCtx_({ jobs: true, contacts: true, stock: true });
    var docId = env.tx.nextDocId('BILL', need_(p.date, 'date', 'Enter the bill date'));
    var entry = Posting.createBill(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    persistBill_(env, Object.assign({}, entry.doc, { memo: p.memo || '' }), ids.jeId);
    return {
      data: { billId: docId, jeId: ids.jeId, grossPaisa: entry.doc.grossPaisa, bill: entry.doc },
      audit: { docType: 'BILL', docId: docId, summary: 'Bill ' + (p.vendorRef || '') + ' ' + Money.formatPaisa(entry.doc.grossPaisa) + ' from ' + p.contactId },
    };
  },

  'karigar.logWork': function (p, env) {
    var ctx = loadCtx_({ jobs: true, contacts: true });
    var docId = env.tx.nextDocId('BILL', need_(p.date, 'date', 'Enter the date'));
    var entry = Posting.karigarWork(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    persistBill_(env, Object.assign({}, entry.doc, { memo: p.description || '' }), ids.jeId);
    return {
      data: { billId: docId, jeId: ids.jeId, amountPaisa: entry.doc.grossPaisa },
      audit: { docType: 'BILL', docId: docId, summary: 'Karigar work ' + Money.formatPaisa(entry.doc.grossPaisa) + ' on ' + p.jobId },
    };
  },

  'jobs.cancel': function (p, env) {
    var ctx = loadCtx_({ jobs: true, ledger: true, stock: true });
    var date = need_(p.date, 'date', 'Enter the date');
    var entry = Posting.cancelJob(Object.assign({}, p, { date: date }), ctx);
    var ids = postEntry_(env, entry);
    var job = ctx.jobs[p.jobId];
    var refundId = '';
    if (entry.doc.refundPaisa > 0) {
      refundId = env.tx.nextDocId('PAY', date);
      persistPayment_(env, {
        id: refundId, date: date, contactId: job.contactId, brand: job.brand, direction: 'OUT', kind: 'REFUND',
        moneyAccountCode: String(p.moneyAccountCode), amountPaisa: entry.doc.refundPaisa, reference: p.reference || '',
        allocations: [{ docType: 'JOB', docId: job.id, amountPaisa: entry.doc.refundPaisa }],
      }, ids.jeId, 'Refund on cancellation');
    }
    return {
      data: Object.assign({ jeId: ids.jeId, refundPaymentId: refundId }, entry.doc),
      audit: { docType: 'JOB', docId: job.id, summary: 'Cancelled ' + job.id + ': refund ' + Money.formatPaisa(entry.doc.refundPaisa) + ', kept ' + Money.formatPaisa(entry.doc.forfeitedPaisa) },
    };
  },

  // ---------- purchases (M4) ----------

  'bills.list': function (p) {
    return Db.read('Bills').filter(function (b) {
      var st = billState_(b);
      return (!p.contactId || b.contactId === p.contactId) && (!p.from || b.date >= p.from) && (!p.to || b.date <= p.to) &&
        (!p.state || (p.state === 'UNPAID' ? (st === 'OPEN' || st === 'PART_PAID') : st === p.state));
    }).map(function (b) {
      var c = Db.get('Contacts', b.contactId);
      return Object.assign({}, b, { state: billState_(b), contactName: c ? c.name : '' });
    }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : -1); });
  },

  'bills.get': function (p) {
    var b = Db.get('Bills', p.id);
    if (!b) throw Validate.coreError('E_NOT_FOUND', 'Bill ' + p.id + ' not found', 'id');
    var ids = Array.isArray(b.attachmentIds) ? b.attachmentIds : [];
    return {
      bill: Object.assign({}, b, { state: billState_(b) }),
      contact: Db.get('Contacts', b.contactId),
      lines: Db.read('BillLines').filter(function (l) { return l.billId === b.id; }),
      payments: Db.read('PaymentAllocations').filter(function (a) { return a.docType === 'BILL' && a.docId === b.id; }).map(function (a) {
        return Object.assign({}, Db.get('Payments', a.paymentId) || {}, { allocatedPaisa: a.amountPaisa, allocatedWhtPaisa: a.whtPaisa || 0 });
      }),
      attachments: Db.read('Attachments').filter(function (x) { return ids.indexOf(x.id) >= 0 || (x.docType === 'BILL' && x.docId === b.id); }),
    };
  },

  'vendors.list': function (p) {
    var acc = Validate.indexAccounts(Db.read('Accounts'));
    var lines = Db.read('JournalLines');
    var owed = Reports.vendorBalances(lines, acc);
    var advCode = acc.accountsBySystemKey.VENDOR_ADV.code;
    var adv = {};
    lines.forEach(function (l) { if (l.accountCode === advCode && l.contactId) adv[l.contactId] = (adv[l.contactId] || 0) + l.debitPaisa - l.creditPaisa; });
    return Db.read('Contacts').filter(function (c) {
      return (c.kind === 'VENDOR' || c.kind === 'BOTH') && (c.isActive || p.includeInactive) && (!p.vendorType || c.vendorType === p.vendorType);
    }).map(function (c) { return Object.assign({}, c, { weOwePaisa: owed[c.id] || 0, advancePaisa: adv[c.id] || 0 }); });
  },

  'payments.pay': function (p, env) {
    var ctx = loadCtx_({ contacts: true });
    ctx.bills = billsCtx_();
    var docId = env.tx.nextDocId('PAY', need_(p.date, 'date', 'Enter the date'));
    var allocations = (p.allocations || []).map(function (a, i) {
      if (a.docType && a.docType !== 'BILL') throw Validate.coreError('E_VALIDATION', 'Vendor payments are applied to bills', 'allocations[' + i + '].docType');
      var out = { billId: a.docId || a.billId, amountPaisa: a.amountPaisa };
      if (a.whtPaisa !== undefined && a.whtPaisa !== null && a.whtPaisa !== '') out.whtPaisa = a.whtPaisa;
      return out;
    });
    var entry = Posting.payBills(Object.assign({}, p, { docId: docId, allocations: allocations }), ctx);
    var ids = postEntry_(env, entry);
    var doc = entry.doc;
    var brands = {};
    allocations.forEach(function (a) { brands[ctx.bills[a.billId].brand] = true; });
    doc.brand = Object.keys(brands).length === 1 ? Object.keys(brands)[0] : 'SHARED';
    persistPayment_(env, doc, ids.jeId, p.memo || doc.whtOverrideReason);
    return {
      data: { paymentId: docId, jeId: ids.jeId, amountPaisa: doc.amountPaisa, whtPaisa: doc.whtPaisa },
      audit: { docType: 'PAYMENT', docId: docId, summary: 'Paid ' + Money.formatPaisa(doc.amountPaisa) + ' to ' + p.contactId + (doc.whtPaisa ? ', WHT ' + Money.formatPaisa(doc.whtPaisa) : '') + (doc.whtOverrideReason ? ' (WHT changed: ' + doc.whtOverrideReason + ')' : '') },
    };
  },

  'payments.vendorAdvance': function (p, env) {
    var ctx = loadCtx_({ contacts: true });
    var docId = env.tx.nextDocId('PAY', need_(p.date, 'date', 'Enter the date'));
    var entry = Posting.payVendorAdvance(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    persistPayment_(env, entry.doc, ids.jeId, p.memo);
    return { data: { paymentId: docId, jeId: ids.jeId }, audit: { docType: 'PAYMENT', docId: docId, summary: 'Advance ' + Money.formatPaisa(entry.doc.amountPaisa) + ' to ' + p.contactId } };
  },

  // Quick expense (R6) is kept as a paid bill plus its payment, both from one
  // journal entry; "Personal / family" posts drawings (R18) instead.
  'expenses.create': function (p, env) {
    var ctx = loadCtx_({ contacts: true });
    var date = need_(p.date, 'date', 'Enter the date');
    if (p.isDrawings) {
      var payId = env.tx.nextDocId('PAY', date);
      var d = Posting.recordDrawings(Object.assign({}, p, { docId: payId }), ctx);
      var dIds = postEntry_(env, d);
      persistPayment_(env, d.doc, dIds.jeId, p.memo || p.description);
      return { data: { paymentId: payId, jeId: dIds.jeId, isDrawings: true }, audit: { docType: 'PAYMENT', docId: payId, summary: 'Drawings ' + Money.formatPaisa(d.doc.amountPaisa) + ' for ' + p.contactId } };
    }
    var billId = env.tx.nextDocId('BILL', date);
    var entry = Posting.createExpense(Object.assign({}, p, { docId: billId }), ctx);
    var ids = postEntry_(env, entry);
    var doc = entry.doc;
    var byBrand = {};
    doc.lines.forEach(function (l) { byBrand[l.brand] = (byBrand[l.brand] || 0) + l.netPaisa + l.taxPaisa; });
    persistBill_(env, {
      id: billId, date: date, contactId: doc.contactId, vendorRef: p.vendorRef || '', dueDate: date, memo: p.memo || '',
      netPaisa: doc.netPaisa, taxPaisa: doc.taxPaisa, grossPaisa: doc.grossPaisa, paidPaisa: doc.grossPaisa, whtPaisa: doc.whtPaisa,
      balancePaisa: 0, grossByBrand: byBrand,
      lines: doc.lines.map(function (l) { return Object.assign({ lineKind: 'EXPENSE' }, l); }),
    }, ids.jeId);
    var payId2 = env.tx.nextDocId('PAY', date);
    persistPayment_(env, {
      id: payId2, date: date, contactId: doc.contactId, brand: Object.keys(byBrand).length === 1 ? Object.keys(byBrand)[0] : 'SHARED',
      direction: 'OUT', kind: 'EXPENSE_PAID', moneyAccountCode: doc.moneyAccountCode, amountPaisa: doc.amountPaisa, whtPaisa: doc.whtPaisa,
      whtTaxCodeId: doc.whtTaxCodeId, reference: p.reference || '',
      allocations: [{ docType: 'BILL', docId: billId, amountPaisa: doc.grossPaisa, whtPaisa: doc.whtPaisa }],
    }, ids.jeId, p.memo || (doc.lines[0] && doc.lines[0].description) || '');
    return {
      data: { billId: billId, paymentId: payId2, jeId: ids.jeId, amountPaisa: doc.amountPaisa, whtPaisa: doc.whtPaisa },
      audit: { docType: 'EXPENSE', docId: billId, summary: 'Expense ' + Money.formatPaisa(doc.grossPaisa) + (doc.taxOverrideReason ? ' (tax changed: ' + doc.taxOverrideReason + ')' : '') },
    };
  },

  'reports.apAgeing': function (p) {
    var asOf = p.asOf || Dates.karachiDate();
    var bills = Db.read('Bills').filter(function (b) { return b.status !== 'VOID'; });
    var r = Reports.ageing(bills, { asOf: asOf });
    r.rows.forEach(function (row) { var c = Db.get('Contacts', row.contactId); row.contactName = c ? c.name : row.contactId; });
    return r;
  },

  'reports.arAgeing': function (p) {
    var asOf = p.asOf || Dates.karachiDate();
    var r = Reports.ageing(Db.read('Invoices').filter(function (i) { return i.status !== 'VOID'; }), { asOf: asOf });
    r.rows.forEach(function (row) { var c = Db.get('Contacts', row.contactId); row.contactName = c ? c.name : row.contactId; });
    return r;
  },

  'accounts.upsert': function (p, env) {
    // id means "edit this account"; without it the code must be new.
    var existing = p.id ? Db.get('Accounts', String(p.id)) : null;
    if (p.id && !existing) throw Validate.coreError('E_NOT_FOUND', 'Account ' + p.id + ' not found', 'id');
    var used = existing ? Db.read('JournalLines').some(function (l) { return l.accountCode === existing.code; }) : false;
    var r = Master.prepareAccount(p, existing, Db.read('Accounts'), used);
    if (existing) env.tx.update('Accounts', existing.id, r.row);
    else env.tx.append('Accounts', [r.row]);
    return { data: r.row, audit: { docType: 'ACCOUNT', docId: r.row.code, summary: (existing ? 'Updated' : 'Added') + ' account ' + r.row.code + ' ' + r.row.name, before: existing || '', after: r.row } };
  },

  'accounts.deactivate': function (p, env) {
    var a = Db.get('Accounts', String(need_(p.code, 'code', 'Choose the account')));
    if (!a) throw Validate.coreError('E_NOT_FOUND', 'Account ' + p.code + ' not found', 'code');
    if (a.systemKey) throw Validate.coreError('E_VALIDATION', a.name + ' is used by the system and cannot be switched off', 'code');
    var bal = Reports.accountBalances(Db.read('JournalLines'))[a.code] || 0;
    if (bal) throw Validate.coreError('E_VALIDATION', a.name + ' still has a balance of ' + Money.formatPaisa(bal) + '. Move it first.', 'code');
    env.tx.update('Accounts', a.id, { isActive: false });
    return { data: { code: a.code }, audit: { docType: 'ACCOUNT', docId: a.code, summary: 'Deactivated account ' + a.code + ' ' + a.name } };
  },

  'accounts.list': function () {
    var bal = Reports.accountBalances(Db.read('JournalLines'));
    return Db.read('Accounts').slice().sort(byCode_).map(function (a) { return Object.assign({}, a, { balancePaisa: bal[a.code] || 0 }); });
  },

  'taxCodes.list': function () {
    return Db.read('TaxCodes').slice().sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : (a.effectiveFrom < b.effectiveFrom ? -1 : 1); });
  },

  // Effective-dated: the same effectiveFrom edits that version; a later one
  // starts a new version and closes the previous one the day before.
  'taxCodes.upsert': function (p, env) {
    var t = Master.prepareTaxCode(p, Db.read('TaxCodes'));
    var rows = Db.read('TaxCodes').filter(function (x) { return x.id === t.row.id; });
    var same = rows.filter(function (x) { return x.effectiveFrom === t.row.effectiveFrom; })[0];
    if (same) {
      env.tx.updateWhere('TaxCodes', function (x) { return x.id === t.row.id && x.effectiveFrom === t.row.effectiveFrom; }, t.row);
    } else {
      rows.forEach(function (x) {
        if (x.effectiveFrom < t.row.effectiveFrom && (!x.effectiveTo || x.effectiveTo >= t.row.effectiveFrom)) {
          env.tx.updateWhere('TaxCodes', function (y) { return y.id === x.id && y.effectiveFrom === x.effectiveFrom; }, { effectiveTo: Dates.addDays(t.row.effectiveFrom, -1) });
        }
      });
      env.tx.append('TaxCodes', [t.row]);
    }
    return { data: t.row, audit: { docType: 'TAX_CODE', docId: t.row.id, summary: 'Tax code ' + t.row.id + ' ' + (t.row.rateBps / 100) + '% from ' + t.row.effectiveFrom, before: same || '', after: t.row } };
  },

  // Photos of bills and receipts go to the attachments folder in Drive.
  'attachments.upload': function (p, env) {
    var folderId = Db.settings().attachmentsFolderId;
    if (!folderId) throw Validate.coreError('E_VALIDATION', 'The Owner needs to set the attachments folder in Settings first', 'attachmentsFolderId');
    var tab = { BILL: 'Bills', PAYMENT: 'Payments', INVOICE: 'Invoices', SALE: 'Sales' }[p.docType];
    if (!tab) throw Validate.coreError('E_VALIDATION', 'Attachments go on bills, payments, invoices or sales', 'docType');
    var doc = Db.get(tab, need_(p.docId, 'docId', 'Choose the document'));
    if (!doc) throw Validate.coreError('E_NOT_FOUND', p.docType + ' ' + p.docId + ' not found', 'docId');
    var mime = String(p.mimeType || '');
    if (!/^image\/(jpeg|png|webp|heic)$|^application\/pdf$/.test(mime)) throw Validate.coreError('E_VALIDATION', 'Attach a photo or a PDF', 'mimeType');
    var bytes = Utilities.base64Decode(need_(p.dataBase64, 'dataBase64', 'Choose a file'));
    if (bytes.length > 5 * 1024 * 1024) throw Validate.coreError('E_VALIDATION', 'The file is larger than 5 MB', 'dataBase64');
    var id = env.tx.nextDocId('ATT', env.today);
    var name = (p.fileName || p.docId) .toString().replace(/[^\w.\- ]/g, '_').slice(0, 80);
    var file = DriveApp.getFolderById(folderId).createFile(Utilities.newBlob(bytes, mime, id + ' ' + name));
    env.tx.append('Attachments', [{ id: id, docType: p.docType, docId: doc.id, driveFileId: file.getId(), fileName: name, mimeType: mime, uploadedBy: env.user.email, uploadedAt: env.ts }]);
    var list = Array.isArray(doc.attachmentIds) ? doc.attachmentIds.slice() : [];
    list.push(id);
    env.tx.update(tab, doc.id, { attachmentIds: list });
    return { data: { attachmentId: id }, audit: { docType: p.docType, docId: doc.id, summary: 'Attached ' + name } };
  },

  'attachments.get': function (p) {
    var a = Db.get('Attachments', p.id);
    if (!a) throw Validate.coreError('E_NOT_FOUND', 'Attachment ' + p.id + ' not found', 'id');
    var blob = DriveApp.getFileById(a.driveFileId).getBlob();
    return { id: a.id, fileName: a.fileName, mimeType: a.mimeType, dataBase64: Utilities.base64Encode(blob.getBytes()) };
  },

  // ---------- inventory (M5) ----------

  'stock.movements': function (p) {
    var item = Db.get('Items', need_(p.itemId, 'itemId', 'Choose an item'));
    if (!item) throw Validate.coreError('E_NOT_FOUND', 'Item ' + p.itemId + ' not found', 'itemId');
    var r = Inventory.movementLedger(Db.read('StockMoves'), item.id, { from: p.from, to: p.to });
    r.item = item;
    return r;
  },

  'stock.valuation': function (p) {
    var acc = Validate.indexAccounts(Db.read('Accounts'));
    return Reports.inventoryReconciliation(Db.read('JournalLines'), Db.read('StockMoves'), acc, Db.byKey('Items'), { asOf: p.asOf || Dates.karachiDate() });
  },

  'jobs.completeBatch': function (p, env) {
    var ctx = loadCtx_({ jobs: true, ledger: true, stock: true });
    var entry = Posting.completeBatch(Object.assign({}, p, { date: need_(p.date, 'date', 'Enter the date') }), ctx);
    var ids = postEntry_(env, entry);
    return {
      data: Object.assign({ jeId: ids.jeId }, entry.doc),
      audit: { docType: 'JOB', docId: p.jobId, summary: 'Batch ' + p.jobId + ' completed: ' + entry.doc.outputs.length + ' SKU(s), ' + Money.formatPaisa(entry.doc.totalCostPaisa) },
    };
  },

  // Blind count: the page hides system quantities until review; the server
  // compares with its own balances at posting time (R15).
  'stock.count.post': function (p, env) {
    var ctx = loadCtx_({ stock: true });
    var date = need_(p.date, 'date', 'Enter the count date');
    var docId = env.tx.nextDocId('CNT', date);
    var entry = Posting.postStockCount(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    env.tx.append('StockCounts', [{ id: docId, date: date, location: p.location || '', status: 'POSTED', jeId: ids.jeId, createdBy: env.user.email, createdAt: env.ts }]);
    env.tx.append('StockCountLines', entry.doc.lines.map(function (l, i) { return Object.assign({ id: Ids.formatLineId(docId, i + 1), countId: docId }, l); }));
    var net = entry.doc.lines.reduce(function (s, l) { return s + l.valuePaisa; }, 0);
    return {
      data: { countId: docId, jeId: ids.jeId, lines: entry.doc.lines, netValuePaisa: net },
      audit: { docType: 'STOCK_COUNT', docId: docId, summary: 'Stock count: ' + entry.doc.lines.filter(function (l) { return l.diffQty; }).length + ' difference(s), net ' + Money.formatPaisa(net) },
    };
  },

  // ---------- store (M6) ----------

  'sale.create': function (p, env) {
    var ctx = loadCtx_({ stock: true, contacts: true });
    var date = need_(p.date, 'date', 'Enter the date');
    var docId = env.tx.nextDocId('SALE', date);
    var store = storeFor_(env, p);
    var entry = Posting.createSale(Object.assign({}, p, { docId: docId, store: store }), ctx);
    var ids = postEntry_(env, entry);
    persistSale_(env, entry.doc, ids.jeId, entry.doc.payments);
    return {
      data: { saleId: docId, jeId: ids.jeId, grossPaisa: entry.doc.grossPaisa },
      audit: { docType: 'SALE', docId: docId, summary: 'Sale ' + Money.formatPaisa(entry.doc.grossPaisa) + (store ? ' at ' + store : '') },
    };
  },

  'sale.return': function (p, env) {
    var ctx = loadCtx_({ stock: true });
    ctx.sales = saleCtx_(need_(p.originalSaleId, 'originalSaleId', 'Find the original sale'));
    var orig = ctx.sales[p.originalSaleId].sale;
    if (env.user.role === 'STORE' && orig.store && orig.store !== env.user.store) throw Validate.coreError('E_ROLE', 'That sale was made at another store');
    var date = need_(p.date, 'date', 'Enter the date');
    var docId = env.tx.nextDocId('SALE', date);
    var entry = Posting.returnSale(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    var doc = Object.assign({}, entry.doc, { store: storeFor_(env, p) || orig.store });
    // Refunds are stored as negative payments so a day's takings by method net them off.
    persistSale_(env, doc, ids.jeId, doc.payments.map(function (x) { return Object.assign({}, x, { amountPaisa: -x.amountPaisa }); }));
    return {
      data: { saleId: docId, jeId: ids.jeId, grossPaisa: doc.grossPaisa },
      audit: { docType: 'SALE', docId: docId, summary: 'Return ' + Money.formatPaisa(doc.grossPaisa) + ' against ' + orig.id },
    };
  },

  'sale.exchange': function (p, env) {
    var ctx = loadCtx_({ stock: true });
    ctx.sales = saleCtx_(need_(p.originalSaleId, 'originalSaleId', 'Find the original sale'));
    var orig = ctx.sales[p.originalSaleId].sale;
    if (env.user.role === 'STORE' && orig.store && orig.store !== env.user.store) throw Validate.coreError('E_ROLE', 'That sale was made at another store');
    var date = need_(p.date, 'date', 'Enter the date');
    var docId = env.tx.nextDocId('SALE', date);
    var entry = Posting.exchangeSale(Object.assign({}, p, { docId: docId, store: storeFor_(env, p) || orig.store }), ctx);
    var ids = postEntry_(env, entry);
    var pays = (entry.doc.payments || []).concat((entry.doc.refund || []).map(function (r) { return Object.assign({}, r, { amountPaisa: -r.amountPaisa }); }));
    persistSale_(env, entry.doc, ids.jeId, pays);
    return {
      data: { saleId: docId, jeId: ids.jeId, grossPaisa: entry.doc.grossPaisa },
      audit: { docType: 'SALE', docId: docId, summary: 'Exchange against ' + orig.id + ', difference ' + Money.formatPaisa(entry.doc.grossPaisa) },
    };
  },

  'sales.list': function (p, env) {
    var store = env.user.role === 'STORE' ? env.user.store : p.store;
    var q = String(p.q || '').trim().toLowerCase();
    var digits = q.replace(/\D/g, '');
    var contacts = Db.byKey('Contacts');
    return Db.read('Sales').filter(function (x) {
      if (store && x.store !== store) return false;
      if (p.date && x.date !== p.date) return false;
      if (p.from && x.date < p.from) return false;
      if (p.to && x.date > p.to) return false;
      if (p.kind && x.kind !== p.kind) return false;
      if (!q) return true;
      var c = contacts[x.contactId];
      return x.id.toLowerCase().indexOf(q) >= 0 || (c && (String(c.name).toLowerCase().indexOf(q) >= 0 || (digits.length >= 4 && String(c.phone).indexOf(digits.replace(/^0/, '')) >= 0)));
    }).map(function (x) {
      var c = contacts[x.contactId];
      return Object.assign({}, x, { contactName: c ? c.name : '' });
    }).sort(function (a, b) { return a.id < b.id ? 1 : -1; }).slice(0, Number(p.limit) || 100);
  },

  'sales.get': function (p, env) {
    var sale = Db.get('Sales', p.id);
    if (!sale) throw Validate.coreError('E_NOT_FOUND', 'Sale ' + p.id + ' not found', 'id');
    if (env.user.role === 'STORE' && sale.store && sale.store !== env.user.store) throw Validate.coreError('E_ROLE', 'That sale was made at another store');
    var items = Db.byKey('Items');
    return {
      sale: sale,
      lines: Db.read('SaleLines').filter(function (l) { return l.saleId === sale.id; }).map(function (l) { return Object.assign({}, l, { itemName: (items[l.itemId] || {}).name || l.itemId }); }),
      payments: Db.read('SalePayments').filter(function (x) { return x.saleId === sale.id; }),
      contact: sale.contactId ? Db.get('Contacts', sale.contactId) : null,
      returns: Db.read('Sales').filter(function (x) { return x.originalSaleId === sale.id; }),
    };
  },

  // Expected cash = the store cash account's balance at the end of the day;
  // expected card = card and wallet takings that day.
  'cashup.preview': function (p, env) {
    var date = p.date || Dates.karachiDate();
    var store = storeFor_(env, p);
    var cashCode = String(p.cashAccountCode || Db.settings().storeCashAccount || '1020');
    var acc = Validate.indexAccounts(Db.read('Accounts'));
    var cash = Reports.accountLedger(Db.read('JournalLines'), acc, { accountCode: cashCode, to: date });
    var sales = Db.read('Sales').filter(function (x) { return x.date === date && x.status !== 'VOID' && (!store || x.store === store); });
    var ids = {};
    sales.forEach(function (x) { ids[x.id] = true; });
    var byMethod = {};
    Db.read('SalePayments').forEach(function (x) { if (ids[x.saleId]) byMethod[x.method] = (byMethod[x.method] || 0) + x.amountPaisa; });
    var done = Db.read('CashUps').filter(function (c) { return c.date === date && (!store || c.store === store); });
    return {
      date: date, store: store, cashAccountCode: cashCode, expectedCashPaisa: cash.closingPaisa,
      expectedCardPaisa: (byMethod.CARD || 0) + (byMethod.WALLET || 0), takingsByMethod: byMethod, alreadyDone: done,
    };
  },

  'cashup.submit': function (p, env) {
    var preview = Actions['cashup.preview'](p, env);
    if (preview.alreadyDone.length) throw Validate.coreError('E_VALIDATION', 'The cash-up for ' + preview.date + ' is already done', 'date');
    var ctx = loadCtx_({});
    var docId = env.tx.nextDocId('CUP', preview.date);
    var entry = Posting.cashUp({
      docId: docId, date: preview.date, store: preview.store, cashAccountCode: preview.cashAccountCode,
      expectedCashPaisa: preview.expectedCashPaisa, countedCashPaisa: p.countedCashPaisa, expectedCardPaisa: preview.expectedCardPaisa, notes: p.notes,
    }, ctx);
    var ids = postEntry_(env, entry);
    env.tx.append('CashUps', [Object.assign({}, entry.doc, { id: docId, jeId: ids.jeId, createdBy: env.user.email, createdAt: env.ts })]);
    var d = entry.doc.diffPaisa;
    return {
      data: Object.assign({ cashUpId: docId, jeId: ids.jeId }, entry.doc),
      audit: { docType: 'CASHUP', docId: docId, summary: 'Cash-up ' + preview.date + ': ' + (d === 0 ? 'exact' : (d > 0 ? 'over ' : 'short ') + Money.formatPaisa(Math.abs(d))) },
    };
  },

  'reports.dailySales': function (p, env) {
    var date = p.date || Dates.karachiDate();
    var store = storeFor_(env, p);
    var sales = Actions['sales.list']({ date: date, store: store, limit: 1000 }, env).filter(function (x) { return x.status !== 'VOID'; });
    var ids = {};
    sales.forEach(function (x) { ids[x.id] = true; });
    var byMethod = {};
    Db.read('SalePayments').forEach(function (x) { if (ids[x.saleId]) byMethod[x.method] = (byMethod[x.method] || 0) + x.amountPaisa; });
    var totals = { salesGrossPaisa: 0, returnsGrossPaisa: 0, netPaisa: 0, taxPaisa: 0, transactions: 0 };
    sales.forEach(function (x) {
      if (x.kind === 'SALE') { totals.salesGrossPaisa += x.grossPaisa; totals.transactions++; }
      if (x.kind === 'RETURN') totals.returnsGrossPaisa += x.grossPaisa;
      if (x.kind === 'EXCHANGE') totals.salesGrossPaisa += x.grossPaisa;
      totals.netPaisa += x.kind === 'RETURN' ? -x.netPaisa : x.netPaisa;
      totals.taxPaisa += x.kind === 'RETURN' ? -x.taxPaisa : x.taxPaisa;
    });
    var out = { date: date, store: store, sales: sales, byMethod: byMethod, totals: totals };
    if (env.user.role === 'STORE') return out;
    var cost = 0;
    Db.read('SaleLines').forEach(function (l) { if (ids[l.saleId]) cost += l.costPaisa || 0; });
    out.totals.costPaisa = cost;
    return out;
  },

  'settlements.create': function (p, env) {
    var ctx = loadCtx_({});
    var date = need_(p.date, 'date', 'Enter the date');
    var docId = env.tx.nextDocId('PAY', date);
    var entry = Posting.settleCards(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    persistPayment_(env, Object.assign({}, entry.doc, { brand: 'SHARED' }), ids.jeId, 'Settlement from ' + entry.doc.clearingCode + ', fee ' + Money.formatPaisa(entry.doc.feePaisa));
    return { data: Object.assign({ paymentId: docId, jeId: ids.jeId }, entry.doc), audit: { docType: 'PAYMENT', docId: docId, summary: 'Card settlement ' + Money.formatPaisa(entry.doc.grossPaisa) + ', fee ' + Money.formatPaisa(entry.doc.feePaisa) } };
  },

  'transfers.create': function (p, env) {
    var ctx = loadCtx_({});
    var date = need_(p.date, 'date', 'Enter the date');
    var docId = env.tx.nextDocId('PAY', date);
    var entry = Posting.transfer(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    persistPayment_(env, Object.assign({}, entry.doc, { brand: 'SHARED' }), ids.jeId, 'Transfer to ' + entry.doc.toAccountCode + (p.memo ? ': ' + p.memo : ''));
    return { data: { paymentId: docId, jeId: ids.jeId }, audit: { docType: 'PAYMENT', docId: docId, summary: 'Transfer ' + Money.formatPaisa(entry.doc.amountPaisa) + ' ' + entry.doc.moneyAccountCode + ' to ' + entry.doc.toAccountCode } };
  },

  // ---------- reports (M7) ----------

  'reports.pnl': function (p) {
    var settings = Db.settings();
    var acc = Validate.indexAccounts(Db.read('Accounts'));
    var lines = linesWithClosing_();
    var opts = { from: need_(p.from, 'from', 'Choose a start date'), to: need_(p.to, 'to', 'Choose an end date'), allocate: p.allocate || settings.allocationKey || 'NONE', umshaPctBps: Number(settings.allocationUmshaPctBps || 0) };
    var out = { current: Reports.profitAndLoss(lines, acc, opts) };
    if (p.compareTo && p.compareTo.from && p.compareTo.to) out.previous = Reports.profitAndLoss(lines, acc, Object.assign({}, opts, { from: p.compareTo.from, to: p.compareTo.to }));
    return out;
  },

  'reports.balanceSheet': function (p) {
    return Reports.balanceSheet(Db.read('JournalLines'), Validate.indexAccounts(Db.read('Accounts')), { asOf: p.asOf || Dates.karachiDate() });
  },

  'reports.trialBalance': function (p) {
    return Reports.trialBalance(Db.read('JournalLines'), Validate.indexAccounts(Db.read('Accounts')), { asOf: p.asOf || Dates.karachiDate() });
  },

  'reports.jobProfitability': function (p) {
    var rows = Reports.jobProfitability(linesWithClosing_(), Validate.indexAccounts(Db.read('Accounts')), Db.byKey('Jobs'), { from: p.from, to: p.to });
    var contacts = Db.byKey('Contacts');
    var jobs = Db.byKey('Jobs');
    return rows.map(function (r) {
      var j = jobs[r.jobId];
      var cost = r.costPaisa;
      return Object.assign({}, r, { contactName: (contacts[r.contactId] || {}).name || '', budgetCostPaisa: j.budgetCostPaisa, promisedDate: j.promisedDate, onTime: !j.promisedDate || r.deliveredDate <= j.promisedDate, overBudget: !!j.budgetCostPaisa && cost > j.budgetCostPaisa });
    });
  },

  'reports.skuMargin': function (p) {
    return Reports.skuMargin(Db.read('Sales'), Db.read('SaleLines'), Db.byKey('Items'), { from: p.from, to: p.to, collection: p.collection });
  },

  'reports.cashPosition': function (p) {
    return Reports.cashPosition(Db.read('JournalLines'), Validate.indexAccounts(Db.read('Accounts')), Db.read('Invoices'), Db.read('Bills'), { asOf: p.asOf || Dates.karachiDate(), days: Number(p.days) || 7 });
  },

  'reports.salesTax': function (p) {
    var settlements = {};
    Db.read('Payments').forEach(function (x) { if (x.kind === 'TAX_PAYMENT' && x.jeId) settlements[x.jeId] = true; });
    return Reports.salesTaxSummary(Db.read('JournalLines'), Validate.indexAccounts(Db.read('Accounts')), { from: p.from, to: p.to, excludeJeIds: settlements });
  },

  'reports.whtRegister': function (p) {
    return Reports.whtRegister(Db.read('Payments'), Db.read('PaymentAllocations'), Db.byKey('Contacts'), { from: p.from, to: p.to });
  },

  'reports.auditLog': function (p) {
    return Db.read('AuditLog').filter(function (a) {
      var d = String(a.ts).slice(0, 10);
      return (!p.from || d >= p.from) && (!p.to || d <= p.to) && (!p.user || a.userEmail === p.user) && (!p.docType || a.docType === p.docType) &&
        (!p.q || (a.summary + ' ' + a.docId).toLowerCase().indexOf(String(p.q).toLowerCase()) >= 0);
    }).slice(-Math.min(Number(p.limit) || 500, 2000)).reverse();
  },

  'journal.list': function (p) {
    var totals = {};
    var hits = {};
    Db.read('JournalLines').forEach(function (l) {
      totals[l.jeId] = (totals[l.jeId] || 0) + l.debitPaisa;
      if (p.accountCode && l.accountCode === String(p.accountCode)) hits[l.jeId] = true;
    });
    return Db.read('Journal').filter(function (j) {
      return (!p.from || j.date >= p.from) && (!p.to || j.date <= p.to) && (!p.docType || j.docType === p.docType) &&
        (!p.accountCode || hits[j.id]) && (!p.manualOnly || j.isManual) &&
        (!p.q || (j.id + ' ' + j.docId + ' ' + j.memo).toLowerCase().indexOf(String(p.q).toLowerCase()) >= 0);
    }).map(function (j) { return Object.assign({}, j, { totalPaisa: totals[j.id] || 0 }); }).slice(-Math.min(Number(p.limit) || 300, 2000)).reverse();
  },

  'tax.settleSalesTax': function (p, env) {
    var ctx = loadCtx_({});
    var date = need_(p.date, 'date', 'Enter the date');
    var docId = env.tx.nextDocId('PAY', date);
    var entry = Posting.settleSalesTax(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    persistPayment_(env, Object.assign({}, entry.doc, { brand: 'SHARED' }), ids.jeId, 'Sales tax return' + (p.reference ? ' ' + p.reference : ''));
    return { data: { paymentId: docId, jeId: ids.jeId }, audit: { docType: 'PAYMENT', docId: docId, summary: 'Sales tax paid ' + Money.formatPaisa(entry.doc.amountPaisa) } };
  },

  'tax.depositWht': function (p, env) {
    var ctx = loadCtx_({});
    var date = need_(p.date, 'date', 'Enter the date');
    var docId = env.tx.nextDocId('PAY', date);
    var entry = Posting.depositWht(Object.assign({}, p, { docId: docId }), ctx);
    var ids = postEntry_(env, entry);
    persistPayment_(env, Object.assign({}, entry.doc, { brand: 'SHARED' }), ids.jeId, 'WHT deposit' + (p.reference ? ' ' + p.reference : ''));
    return { data: { paymentId: docId, jeId: ids.jeId }, audit: { docType: 'PAYMENT', docId: docId, summary: 'WHT deposited ' + Money.formatPaisa(entry.doc.amountPaisa) } };
  },

  // ---------- banking and export (M8) ----------

  // Import a statement CSV. The column mapping is remembered per account
  // (Settings key bankMapping:<code>) so next month it is one click.
  'bankrec.import': function (p, env) {
    var acct = Db.get('Accounts', need_(p.accountCode, 'accountCode', 'Choose the bank account'));
    if (!acct || !acct.isMoney || ['BANK', 'WALLET', 'CLEARING'].indexOf(acct.moneyKind) === -1) throw Validate.coreError('E_VALIDATION', 'Choose a bank, wallet or clearing account', 'accountCode');
    var key = 'bankMapping:' + acct.code;
    var saved = Db.settings()[key];
    var mapping = p.mapping || (saved ? JSON.parse(saved) : null);
    if (!mapping) throw Validate.coreError('E_VALIDATION', 'Tell the system which columns hold the date, description and amount', 'mapping');
    var lines = Bankrec.parseStatement(need_(p.csvText, 'csvText', 'Choose the statement file'), mapping);
    var date = Validate.checkDate(need_(p.statementDate, 'statementDate', 'Enter the statement end date'), 'statementDate');
    Money.assertPaisa(p.statementBalancePaisa, 'statementBalancePaisa');
    var id = env.tx.nextDocId('REC', date);
    env.tx.append('BankRecs', [{ id: id, accountCode: acct.code, statementDate: date, statementBalancePaisa: p.statementBalancePaisa, status: 'OPEN', createdBy: env.user.email, createdAt: env.ts }]);
    env.tx.append('BankStatementLines', lines.map(function (l, i) { return Object.assign({ id: Ids.formatLineId(id, i + 1), recId: id, matchedJeLineId: '' }, l); }));
    if (p.mapping) {
      if (saved !== undefined) env.tx.update('Settings', key, { value: JSON.stringify(p.mapping) });
      else env.tx.append('Settings', [{ key: key, value: JSON.stringify(p.mapping) }]);
    }
    return { data: { recId: id, lines: lines.length }, audit: { docType: 'BANK_REC', docId: id, summary: 'Imported ' + lines.length + ' statement lines for ' + acct.name + ' to ' + date } };
  },

  'bankrec.list': function (p) {
    return Db.read('BankRecs').filter(function (r) { return !p.accountCode || r.accountCode === String(p.accountCode); }).slice().reverse();
  },

  'bankrec.get': function (p) {
    var rec = Db.get('BankRecs', p.recId);
    if (!rec) throw Validate.coreError('E_NOT_FOUND', 'Reconciliation ' + p.recId + ' not found', 'recId');
    var stmt = Db.read('BankStatementLines').filter(function (l) { return l.recId === rec.id; });
    var journals = Db.byKey('Journal');
    var ledger = Db.read('JournalLines').filter(function (l) { return l.accountCode === rec.accountCode && l.date <= rec.statementDate; }).map(function (l) {
      var j = journals[l.jeId] || {};
      return Object.assign({}, l, { docType: j.docType || '', docId: j.docId || '', jeMemo: j.memo || '' });
    });
    var open = ledger.filter(function (l) { return !l.reconciled; });
    var acct = Db.get('Accounts', rec.accountCode);
    return {
      rec: rec, account: acct, statementLines: stmt, ledgerLines: ledger,
      suggestions: rec.status === 'OPEN' ? Bankrec.suggestMatches(stmt, open) : [],
      summary: Bankrec.reconciliationSummary(rec, stmt, ledger, []),
    };
  },

  // Save matches; with finish: true the statement must fully reconcile.
  'bankrec.match': function (p, env) {
    var data = Actions['bankrec.get']({ recId: p.recId });
    var rec = data.rec;
    if (rec.status !== 'OPEN') throw Validate.coreError('E_VALIDATION', 'This reconciliation is already finished', 'recId');
    var stmtById = {};
    data.statementLines.forEach(function (s) { stmtById[s.id] = s; });
    var ledgerById = {};
    data.ledgerLines.forEach(function (l) { ledgerById[l.id] = l; });
    var seen = {};
    (p.matches || []).forEach(function (m, i) {
      var s = stmtById[m.statementLineId];
      var l = ledgerById[m.jeLineId];
      if (!s || s.matchedJeLineId) throw Validate.coreError('E_VALIDATION', 'Statement line ' + m.statementLineId + ' is not open on this reconciliation', 'matches[' + i + ']');
      if (!l || l.reconciled || seen[l.id]) throw Validate.coreError('E_VALIDATION', 'Ledger line ' + m.jeLineId + ' cannot be matched', 'matches[' + i + ']');
      if (l.debitPaisa - l.creditPaisa !== s.amountPaisa) throw Validate.coreError('E_VALIDATION', 'Amounts differ: ' + Money.formatPaisa(s.amountPaisa) + ' on the statement, ' + Money.formatPaisa(l.debitPaisa - l.creditPaisa) + ' in the ledger', 'matches[' + i + ']');
      seen[l.id] = true;
      env.tx.update('BankStatementLines', s.id, { matchedJeLineId: l.id });
      env.tx.update('JournalLines', l.id, { reconciled: true, reconciledDate: rec.statementDate });
    });
    var summary = Bankrec.reconciliationSummary(rec, data.statementLines, data.ledgerLines, p.matches || []);
    if (p.finish) {
      if (!summary.balanced) {
        throw Validate.coreError('E_VALIDATION', summary.unmatchedStatement.length ? summary.unmatchedStatement.length + ' statement line(s) are not matched yet. Post them (e.g. bank charges) and match them first.' : 'Still out by ' + Money.formatPaisa(summary.differencePaisa), 'matches');
      }
      env.tx.update('BankRecs', rec.id, { status: 'RECONCILED', reconciledBy: env.user.email, reconciledAt: env.ts });
    }
    return {
      data: { recId: rec.id, matched: (p.matches || []).length, summary: { differencePaisa: summary.differencePaisa, balanced: summary.balanced }, finished: !!p.finish },
      audit: { docType: 'BANK_REC', docId: rec.id, summary: (p.finish ? 'Reconciled ' : 'Matched ' + (p.matches || []).length + ' lines on ') + rec.accountCode + ' to ' + rec.statementDate },
    };
  },

  'export.quickbooksJournals': function (p) {
    var acc = Validate.indexAccounts(Db.read('Accounts'));
    var settings = Db.settings();
    return Export.quickbooksJournals(Db.read('Journal'), Db.read('JournalLines'), acc.accountsByCode, Db.byKey('Contacts'), { from: p.from, to: p.to, dateFormat: settings.qbDateFormat || 'DD/MM/YYYY', currency: settings.baseCurrency || 'PKR' });
  },

  'export.table': function (p) {
    if (!Schema.TABS[p.tab]) throw Validate.coreError('E_VALIDATION', 'Unknown tab ' + p.tab, 'tab');
    var header = Db.header(p.tab);
    var rows = Db.read(p.tab).map(function (r) {
      var o = {};
      header.forEach(function (h) { o[h] = typeof r[h] === 'object' && r[h] !== null ? JSON.stringify(r[h]) : r[h]; });
      return o;
    });
    return { filename: p.tab + '.csv', csv: Csv.toCsv(rows, header), rows: rows.length };
  },

  // ---------- ledger ----------

  'journal.create': function (p, env) {
    var ctx = loadCtx_({ jobs: true });
    var entry = Posting.manualJournal(p, ctx);
    var ids = postEntry_(env, entry);
    var total = entry.lines.reduce(function (s, l) { return s + l.debitPaisa; }, 0);
    return { data: { jeId: ids.jeId }, audit: { docType: 'JOURNAL', docId: ids.jeId, summary: 'Manual journal ' + Money.formatPaisa(total) + ': ' + p.memo } };
  },

  'journal.reverse': function (p, env) {
    var ctx = loadCtx_({ stock: true, contacts: true });
    var jeId = need_(p.jeId, 'jeId', 'Choose the entry to reverse');
    var journal = Db.get('Journal', jeId);
    if (!journal) throw Validate.coreError('E_NOT_FOUND', 'Entry ' + jeId + ' not found', 'jeId');
    ctx.journals = {};
    ctx.journals[jeId] = {
      journal: journal,
      lines: Db.read('JournalLines').filter(function (l) { return l.jeId === jeId; }),
      stockMoves: ctx.stockMoves.filter(function (m) { return m.jeId === jeId; }),
    };
    ctx.bills = billsCtx_();
    ctx.invoices = Db.byKey('Invoices');
    ctx.paymentsByJe = paymentsByJe_(jeId);
    var entry = Posting.reverseEntry({ date: p.date || env.today, jeId: jeId, reason: p.reason }, ctx);
    var ids = postEntry_(env, entry);
    return { data: { jeId: ids.jeId, reversesJeId: jeId }, audit: { docType: 'JOURNAL', docId: ids.jeId, summary: 'Reversed ' + jeId + ': ' + p.reason } };
  },

  'journal.get': function (p) {
    var j = Db.get('Journal', p.jeId);
    if (!j) throw Validate.coreError('E_NOT_FOUND', 'Entry ' + p.jeId + ' not found', 'jeId');
    var accounts = Db.byKey('Accounts');
    return {
      journal: j,
      lines: Db.read('JournalLines').filter(function (l) { return l.jeId === j.id; }).map(function (l) {
        return Object.assign({}, l, { accountName: accounts[l.accountCode] ? accounts[l.accountCode].name : '' });
      }),
    };
  },

  'ledger.account': function (p) {
    var acc = Validate.indexAccounts(Db.read('Accounts'));
    return Reports.accountLedger(Db.read('JournalLines'), acc, { accountCode: need_(p.accountCode, 'accountCode', 'Choose an account'), from: p.from, to: p.to, brand: p.brand });
  },

  'backup.now': function (p, env) {
    var r = Backup.now();
    return { data: r, audit: { docType: 'BACKUP', docId: r.fileId, summary: 'Backup ' + r.name } };
  },
};
