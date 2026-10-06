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
  PAYMENT: 'Payments', STOCK_COUNT: 'StockCounts', CASHUP: 'CashUps',
};

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
    netPaisa: doc.netPaisa, taxPaisa: doc.taxPaisa, grossPaisa: doc.grossPaisa, paidPaisa: 0, whtPaisa: 0, balancePaisa: doc.balancePaisa,
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
    return { id: Ids.formatLineId(doc.id, i + 1), paymentId: doc.id, docType: a.docType, docId: a.docId, amountPaisa: a.amountPaisa };
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

  // TODO(M7): the close checklist (bank reconciled, cash-ups, stock count, TB balances).
  // TODO(decision-D-11): any Owner can close and reopen.
  'periods.close': function (p, env) {
    var b = Dates.periodBounds(p.periodId);
    var row = Db.get('Periods', b.id);
    if (row && row.status === 'CLOSED') throw Validate.coreError('E_VALIDATION', b.id + ' is already closed', 'periodId');
    var fields = { status: 'CLOSED', closedBy: env.user.email, closedAt: env.ts, reopenReason: '' };
    if (row) env.tx.update('Periods', b.id, fields);
    else env.tx.append('Periods', [Object.assign({}, b, fields)]);
    return { data: Object.assign({}, b, fields), audit: { docType: 'PERIOD', docId: b.id, summary: 'Closed ' + b.id, before: row ? row.status : 'OPEN', after: 'CLOSED' } };
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
    return {
      job: job,
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

  'receipts.render': function (p) {
    var settings = Db.settings();
    if (p.docType === 'INVOICE') {
      var data = Actions['invoices.get']({ id: p.docId });
      return Receipts.invoiceDocument({ settings: settings, invoice: data.invoice, lines: data.lines, contact: data.contact, job: data.job });
    }
    if (p.docType !== 'PAYMENT') throw Validate.coreError('E_VALIDATION', 'Receipts are for payments and invoices', 'docType');
    var pay = Db.get('Payments', p.docId);
    if (!pay) throw Validate.coreError('E_NOT_FOUND', 'Payment ' + p.docId + ' not found', 'docId');
    var alloc = Db.read('PaymentAllocations').filter(function (a) { return a.paymentId === pay.id; })[0];
    var acct = Db.get('Accounts', pay.moneyAccountCode);
    var payment = Object.assign({}, pay, { moneyAccountName: acct ? acct.name : '' });
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
    ctx.bills = Db.byKey('Bills');
    ctx.invoices = Db.byKey('Invoices');
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
