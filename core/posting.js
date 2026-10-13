// core/posting.js: the posting engine. One builder per document type,
// implementing rules R1-R23 in docs/03-accounting-rules.md.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.
//
// Every builder is   build(input, ctx) -> entry   where entry is
//   {journal, lines, stockMoves, itemBalanceUpdates, docUpdates, doc}
//   journal             Journal header (no id: the server allocates it), or null
//                       when nothing needs posting (e.g. a stock count with no differences)
//   lines               JournalLines (no ids)
//   stockMoves          StockMoves (no ids)
//   itemBalanceUpdates  new ItemBalances rows for every item touched
//   docUpdates          [{docType, id, fields}] changes to existing documents;
//                       the value NEW_JE_ID stands for the new journal's id
//   doc                 the document this entry creates, with computed amounts
// Builders validate their own output (core/validate.js) and throw a coded
// error ({code, message, field}) instead of returning an invalid entry.
//
// ctx, assembled by the server from the Sheet (only what a builder needs):
//   accountsByCode, accountsBySystemKey  from Validate.indexAccounts(Accounts rows)
//   taxCodes      TaxCodes rows
//   settings      Settings as key -> value
//   periods       Periods rows
//   itemBalances  {itemId: {qty, avgCostMicro, valuePaisa}}
//   items         {itemId: Items row}
//   contacts      {contactId: Contacts row}
//   jobs          {jobId: Jobs row + lines: JobLines rows}
//   jobWip        {jobId: {component: paisa}}   Reports.jobWip(lines)
//   jobAdvances   {jobId: paisa}                Reports.jobAdvances(lines)
//   bills         {billId: Bills row + grossByBrand: {brand: Σ(net+tax) of its lines}}
//   invoices      {invoiceId: Invoices row}
//   sales         {saleId: {sale: Sales row, lines: SaleLines rows}}
//   stockMoves    StockMoves rows (with ids) needed for returns, reversals, cancellations
//   journals      {jeId: {journal, lines, stockMoves}} for reversals

const Money = require('./money.js');
const Validate = require('./validate.js');
const Inventory = require('./inventory.js');

const NEW_JE_ID = '$NEW_JE';
const BRANDS = Validate.BRANDS;
const fail = Validate.fail;
const isBlank = Validate.isBlank;
const isTrue = Validate.isTrue;

const SALES_KEY_BY_CHANNEL = { STORE: 'RTW_SALES_STORE', ONLINE: 'RTW_SALES_ONLINE', EXHIBITION: 'RTW_SALES_EXHIBITION' };
const OPEN_MTO_STATUSES = ['OPEN', 'IN_PRODUCTION', 'READY'];

// Accounts that only the posting engine may touch, never a free-choice line.
const ENGINE_ONLY_KEYS = ['AR', 'AP', 'CUSTOMER_ADV', 'VENDOR_ADV', 'WIP', 'INPUT_TAX', 'OUTPUT_TAX', 'WHT_PAYABLE',
  'INV_FABRIC', 'INV_TRIMS', 'INV_PACKAGING', 'INV_FG', 'STORE_CREDIT', 'CARD_CLEARING', 'RETAINED_EARNINGS'];

// ---------- lookups ----------

function sysCode(ctx, key) {
  const a = ctx.accountsBySystemKey[key];
  if (!a) fail('E_VALIDATION', 'The chart of accounts has no account with systemKey ' + key, 'systemKey');
  return a.code;
}

function getAccount(ctx, code, field) {
  const a = ctx.accountsByCode[String(code)];
  if (!a) fail('E_VALIDATION', 'Unknown account ' + code, field || 'accountCode');
  return a;
}

function moneyCode(ctx, code, field) {
  const a = getAccount(ctx, code, field || 'moneyAccountCode');
  if (!a.isMoney) fail('E_VALIDATION', a.code + ' ' + a.name + ' is not a cash, bank, wallet or clearing account', field || 'moneyAccountCode');
  return a.code;
}

function cogsCode(ctx, component) {
  return sysCode(ctx, 'COGS_' + (component || 'OTHER'));
}

function lookup(map, id, what, field) {
  const row = map && map[id];
  if (!row) fail('E_NOT_FOUND', what + ' ' + id + ' not found', field);
  return row;
}

function getJob(ctx, jobId) { return lookup(ctx.jobs, jobId, 'Job', 'jobId'); }
function getItem(ctx, itemId) { return lookup(ctx.items, itemId, 'Item', 'itemId'); }
function getContact(ctx, contactId) { return lookup(ctx.contacts, contactId, 'Contact', 'contactId'); }

function checkBrand(brand, field) {
  if (BRANDS.indexOf(brand) === -1) fail('E_EMPTY_BRAND', 'Brand must be UMSHA, MIRAE or SHARED', field || 'brand');
  return brand;
}

function positivePaisa(x, field) {
  Money.assertPaisa(x, field);
  if (x <= 0) fail('E_VALIDATION', (field || 'amount') + ' must be more than zero', field);
  return x;
}

function nonNegativePaisa(x, field) {
  Money.assertPaisa(x, field);
  if (x < 0) fail('E_VALIDATION', (field || 'amount') + ' cannot be negative', field);
  return x;
}

// The TaxCodes row for id in force on date. Blank id means no tax.
function findTaxCode(ctx, id, date, kinds) {
  if (isBlank(id)) return null;
  const rows = (ctx.taxCodes || []).filter(function (t) {
    return t.id === id && (isBlank(t.isActive) || isTrue(t.isActive)) &&
      (isBlank(t.effectiveFrom) || t.effectiveFrom <= date) && (isBlank(t.effectiveTo) || date <= t.effectiveTo);
  });
  if (!rows.length) fail('E_VALIDATION', 'Tax code ' + id + ' is not active on ' + date, 'taxCodeId');
  rows.sort(function (a, b) { return String(a.effectiveFrom || '') < String(b.effectiveFrom || '') ? -1 : 1; });
  const t = rows[rows.length - 1];
  if (kinds && kinds.indexOf(t.kind) === -1) {
    fail('E_VALIDATION', 'Tax code ' + id + ' is a ' + t.kind + ' code and cannot be used here', 'taxCodeId');
  }
  const rate = Number(t.rateBps || 0);
  if (!Number.isSafeInteger(rate) || rate < 0) fail('E_VALIDATION', 'Tax code ' + id + ' has an invalid rate', 'taxCodeId');
  return {
    id: t.id, kind: t.kind, rateBps: rate, claimable: isTrue(t.claimable),
    whtBase: t.whtBase || 'EXCL_SALES_TAX', vendorFilerStatus: t.vendorFilerStatus || 'ANY', appliesTo: t.appliesTo || 'ANY',
  };
}

// Tax on tax-exclusive amounts, computed per tax code across the document,
// then split back to lines pro-rata by net (docs/03 Rounding).
function exclusiveTax(nets, codes) {
  const taxes = nets.map(function () { return 0; });
  groupByCode(codes).forEach(function (g) {
    const n = g.idx.reduce(function (s, i) { return s + nets[i]; }, 0);
    if (n === 0 || g.code.rateBps === 0) return;
    const t = Money.applyBps(n, g.code.rateBps);
    const split = Money.splitProRata(t, g.idx.map(function (i) { return nets[i]; }));
    g.idx.forEach(function (i, k) { taxes[i] = split[k]; });
  });
  return taxes;
}

// Tax inside tax-inclusive amounts (R11): N = round(G x 10000 / (10000 + rate))
// per tax code, N split to lines by gross, each line's tax = its gross - net.
function inclusiveTax(grosses, codes) {
  const nets = grosses.slice();
  groupByCode(codes).forEach(function (g) {
    const gross = g.idx.reduce(function (s, i) { return s + grosses[i]; }, 0);
    if (gross === 0 || g.code.rateBps === 0) return;
    const n = Money.divRoundHalfEven(BigInt(gross) * BigInt(10000), 10000 + g.code.rateBps);
    const split = Money.splitProRata(n, g.idx.map(function (i) { return grosses[i]; }));
    g.idx.forEach(function (i, k) { nets[i] = split[k]; });
  });
  return { nets: nets, taxes: grosses.map(function (g, i) { return g - nets[i]; }) };
}

function groupByCode(codes) {
  const groups = {};
  const order = [];
  codes.forEach(function (c, i) {
    if (!c) return;
    if (!groups[c.id]) { groups[c.id] = { code: c, idx: [] }; order.push(c.id); }
    groups[c.id].idx.push(i);
  });
  return order.map(function (id) { return groups[id]; });
}

// Split an amount across brands in proportion to brandWeights ({brand: paisa}),
// residual on the last brand in BRANDS order. Returns {brand: share}.
function splitByBrand(amount, brandWeights) {
  const brands = BRANDS.filter(function (b) { return (brandWeights[b] || 0) > 0; });
  const out = {};
  if (!brands.length) return out;
  const shares = Money.splitProRata(amount, brands.map(function (b) { return brandWeights[b]; }));
  brands.forEach(function (b, i) { out[b] = shares[i]; });
  return out;
}

function addTo(map, key, amount) {
  map[key] = (map[key] || 0) + amount;
}

// ---------- entry assembly ----------

function start(input, ctx, docType, docId, memo) {
  Validate.checkDate(input.date);
  if (Validate.isPeriodLocked(ctx.periods, input.date)) {
    fail('E_PERIOD_LOCKED', 'The period ' + Validate.periodIdOf(input.date) + ' is closed', 'date');
  }
  return {
    journal: {
      date: input.date, docType: docType, docId: docId || '', memo: memo || input.memo || '',
      isManual: false, isClosing: false, reversesJeId: '', reversedByJeId: '',
    },
    lines: [],
    stockMoves: [],
    itemBalanceUpdates: [],
    docUpdates: [],
    doc: null,
  };
}

// Add a line for a signed amount: positive = debit, negative = credit, zero = nothing.
function post(e, accountCode, brand, signedPaisa, refs) {
  Money.assertPaisa(signedPaisa, 'amount');
  if (signedPaisa === 0) return;
  const r = refs || {};
  e.lines.push({
    accountCode: String(accountCode),
    brand: brand,
    debitPaisa: signedPaisa > 0 ? signedPaisa : 0,
    creditPaisa: signedPaisa < 0 ? -signedPaisa : 0,
    contactId: r.contactId || '',
    jobId: r.jobId || '',
    itemId: r.itemId || '',
    qty: r.qty === undefined || r.qty === null ? '' : r.qty,
    costComponent: r.costComponent || '',
    currency: r.currency || '',
    fxAmount: r.fxAmount === undefined ? '' : r.fxAmount,
    fxRate: r.fxRate === undefined ? '' : r.fxRate,
    lateCost: !!r.lateCost,
    memo: r.memo || '',
  });
}

function dr(e, code, brand, amount, refs) { nonNegativePaisa(amount); post(e, code, brand, amount, refs); }
function cr(e, code, brand, amount, refs) { nonNegativePaisa(amount); post(e, code, brand, -amount, refs); }

function addMove(e, move, extra) {
  e.stockMoves.push(Object.assign({
    date: e.journal.date, itemId: move.itemId, qty: move.qty, unitCostMicro: move.unitCostMicro,
    valuePaisa: move.valuePaisa, moveType: move.moveType, docType: e.journal.docType, docId: e.journal.docId,
    jobId: '', sourceMoveId: '',
  }, extra || {}));
}

function ledgerFor(ctx) {
  return Inventory.createStockLedger(ctx.itemBalances, { allowNegativeStock: (ctx.settings || {}).allowNegativeStock });
}

function finish(e, ctx, ledger) {
  if (ledger) e.itemBalanceUpdates = ledger.updates();
  if (!e.lines.length) e.journal = null;
  return Validate.assertValid(e, ctx);
}

// Amount of a money movement, from PKR paisa or a foreign amount x rate (R19).
// TODO(decision-D-08): no month-end revaluation of foreign balances in v1.
function resolveAmount(input) {
  if (!isBlank(input.currency) && input.currency !== 'PKR') {
    const paisa = Money.fxToPaisa(input.fxAmount, input.fxRate);
    if (!isBlank(input.amountPaisa) && input.amountPaisa !== paisa) {
      fail('E_VALIDATION', 'Amount does not match foreign amount x rate (' + Money.formatPaisa(paisa) + ')', 'amountPaisa');
    }
    return { amount: paisa, fx: { currency: input.currency, fxAmount: input.fxAmount, fxRate: input.fxRate } };
  }
  return { amount: positivePaisa(input.amountPaisa, 'amountPaisa'), fx: {} };
}

// Can cost be added to this job now? Returns true when it is a late cost (R8).
function checkJobTakesCost(job) {
  if (job.status === 'CANCELLED') fail('E_JOB_CLOSED', 'Job ' + job.id + ' is cancelled', 'jobId');
  if (job.type === 'RTW_BATCH' && job.status === 'COMPLETED') {
    // TODO(decision-D-22): late costs on a completed RTW batch are refused for now.
    fail('E_JOB_CLOSED', 'Batch ' + job.id + ' is already completed', 'jobId');
  }
  return job.type === 'MTO_ORDER' && job.status === 'DELIVERED';
}

// Post cost to a job's WIP; a late cost on a delivered order is released to
// COGS in the same entry (R8).
function postJobCost(e, ctx, job, amount, component, refs, late) {
  const base = Object.assign({ jobId: job.id, costComponent: component }, refs || {});
  dr(e, sysCode(ctx, 'WIP'), job.brand, amount, Object.assign({}, base, { lateCost: late }));
  if (late) {
    const lateRefs = Object.assign({}, base, { lateCost: true, itemId: '', qty: '' });
    dr(e, cogsCode(ctx, component), job.brand, amount, lateRefs);
    cr(e, sysCode(ctx, 'WIP'), job.brand, amount, lateRefs);
  }
}

// An account a person may pick for an expense line: not a control, stock,
// tax or money account.
function freeChoiceAccount(ctx, code, field) {
  const a = getAccount(ctx, code, field);
  if (ENGINE_ONLY_KEYS.indexOf(a.systemKey) >= 0 || a.isMoney) {
    fail('E_VALIDATION', a.code + ' ' + a.name + ' cannot be chosen here', field || 'accountCode');
  }
  return a;
}

// ---------- R1. Customer advance ----------

function receiveAdvance(input, ctx) {
  const job = getJob(ctx, input.jobId);
  if (job.type !== 'MTO_ORDER') fail('E_VALIDATION', 'Advances are taken on made-to-order jobs only', 'jobId');
  if (OPEN_MTO_STATUSES.indexOf(job.status) === -1) fail('E_JOB_CLOSED', 'Order ' + job.id + ' is ' + String(job.status).toLowerCase(), 'jobId');
  // TODO(decision-D-03): no sales tax on advances; tax is charged on the delivery invoice.
  const amt = resolveAmount(input);
  const e = start(input, ctx, 'PAYMENT', input.docId);
  const refs = { contactId: job.contactId, jobId: job.id };
  dr(e, moneyCode(ctx, input.moneyAccountCode), job.brand, amt.amount, Object.assign({}, refs, amt.fx));
  cr(e, sysCode(ctx, 'CUSTOMER_ADV'), job.brand, amt.amount, refs);
  e.doc = {
    id: input.docId || '', date: input.date, direction: 'IN', kind: 'CUSTOMER_ADVANCE', contactId: job.contactId,
    brand: job.brand, moneyAccountCode: String(input.moneyAccountCode), amountPaisa: amt.amount,
    currency: amt.fx.currency || '', fxAmount: amt.fx.fxAmount || '', fxRate: amt.fx.fxRate || '', reference: input.reference || '',
    allocations: [{ docType: 'JOB', docId: job.id, amountPaisa: amt.amount }],
  };
  return finish(e, ctx);
}

// ---------- R2, R3, R4. Purchase bill ----------

function createBill(input, ctx) {
  const vendor = getContact(ctx, input.contactId);
  const registered = !isBlank(vendor.strn);
  if (!Array.isArray(input.lines) || !input.lines.length) fail('E_VALIDATION', 'A bill needs at least one line', 'lines');
  const e = start(input, ctx, 'BILL', input.docId);
  const ledger = ledgerFor(ctx);

  const prepared = input.lines.map(function (l, i) {
    const field = 'lines[' + i + ']';
    const p = { src: l, kind: l.lineKind, field: field };
    if (l.lineKind === 'STOCK') {
      p.item = getItem(ctx, l.itemId);
      p.brand = Inventory.itemBrand(p.item);
      p.account = sysCode(ctx, Inventory.ACCOUNT_KEY_BY_CATEGORY[p.item.category]);
    } else if (l.lineKind === 'JOB') {
      p.job = getJob(ctx, l.jobId);
      p.late = checkJobTakesCost(p.job);
      if (Validate.COST_COMPONENTS.indexOf(l.costComponent) === -1) fail('E_VALIDATION', 'Choose what the job cost is for', field + '.costComponent');
      p.brand = p.job.brand;
    } else if (l.lineKind === 'EXPENSE') {
      const a = freeChoiceAccount(ctx, l.accountCode, field + '.accountCode');
      p.account = a.code;
      p.brand = checkBrand(l.brand || a.defaultBrand, field + '.brand');
    } else {
      fail('E_VALIDATION', 'Line kind must be STOCK, JOB or EXPENSE', field + '.lineKind');
    }
    if (l.lineKind === 'STOCK' && isBlank(l.qty)) fail('E_VALIDATION', 'Enter a quantity', field + '.qty');
    if (isBlank(l.netPaisa) && (isBlank(l.qty) || isBlank(l.unitCostPaisa))) fail('E_VALIDATION', 'Enter an amount', field + '.netPaisa');
    p.net = isBlank(l.netPaisa) ? Inventory.qtyTimesPaisa(l.qty, l.unitCostPaisa) : nonNegativePaisa(l.netPaisa, field + '.netPaisa');
    p.code = findTaxCode(ctx, l.taxCodeId, input.date, ['PURCHASE_INPUT', 'EXEMPT', 'ZERO']);
    return p;
  });

  const computed = exclusiveTax(prepared.map(function (p) { return p.net; }), prepared.map(function (p) { return p.code; }));
  let overridden = false;
  prepared.forEach(function (p, i) {
    p.tax = computed[i];
    if (!isBlank(p.src.taxPaisa) && p.src.taxPaisa !== computed[i]) {
      p.tax = nonNegativePaisa(p.src.taxPaisa, p.field + '.taxPaisa');
      overridden = true;
    }
  });
  if (overridden && isBlank(input.taxOverrideReason)) {
    fail('E_TAX_OVERRIDE_NO_REASON', 'Give a reason for changing the tax amount', 'taxOverrideReason');
  }

  const inputTaxByBrand = {};
  const grossByBrand = {};
  const docLines = [];
  prepared.forEach(function (p) {
    const claimable = !!(p.code && p.code.claimable && registered);
    const cost = p.net + (claimable ? 0 : p.tax); // non-claimable tax is part of the cost
    if (p.kind === 'STOCK') {
      const move = ledger.receive(p.item.id, p.src.qty, cost, 'PURCHASE');
      addMove(e, move);
      dr(e, p.account, p.brand, cost, { itemId: p.item.id, qty: move.qty, contactId: vendor.id, memo: p.src.description });
    } else if (p.kind === 'JOB') {
      postJobCost(e, ctx, p.job, cost, p.src.costComponent,
        { contactId: vendor.id, qty: isBlank(p.src.qty) ? '' : p.src.qty, memo: p.src.description }, p.late);
    } else {
      dr(e, p.account, p.brand, cost, { contactId: vendor.id, memo: p.src.description });
    }
    if (claimable) addTo(inputTaxByBrand, p.brand, p.tax);
    addTo(grossByBrand, p.brand, p.net + p.tax);
    docLines.push({
      lineKind: p.kind, accountCode: p.account || '', itemId: p.item ? p.item.id : '', qty: isBlank(p.src.qty) ? '' : p.src.qty,
      unitCostPaisa: isBlank(p.src.unitCostPaisa) ? '' : p.src.unitCostPaisa, jobId: p.job ? p.job.id : '',
      costComponent: p.src.costComponent || '', brand: p.brand, taxCodeId: p.code ? p.code.id : '',
      netPaisa: p.net, taxPaisa: p.tax, description: p.src.description || '', lateCost: !!p.late,
    });
  });
  BRANDS.forEach(function (b) {
    if (inputTaxByBrand[b]) dr(e, sysCode(ctx, 'INPUT_TAX'), b, inputTaxByBrand[b], { contactId: vendor.id });
  });
  BRANDS.forEach(function (b) {
    if (grossByBrand[b]) cr(e, sysCode(ctx, 'AP'), b, grossByBrand[b], { contactId: vendor.id });
  });

  const net = prepared.reduce(function (s, p) { return s + p.net; }, 0);
  const tax = prepared.reduce(function (s, p) { return s + p.tax; }, 0);
  if (net + tax <= 0) fail('E_VALIDATION', 'A bill cannot be for zero', 'lines');
  e.doc = {
    id: input.docId || '', date: input.date, contactId: vendor.id, vendorRef: input.vendorRef || '', dueDate: input.dueDate || '',
    status: 'POSTED', netPaisa: net, taxPaisa: tax, grossPaisa: net + tax, paidPaisa: 0, whtPaisa: 0, balancePaisa: net + tax,
    grossByBrand: grossByBrand, taxOverrideReason: overridden ? input.taxOverrideReason : '', lines: docLines,
  };
  return finish(e, ctx, ledger);
}

// Karigar work log (M4.4): a one-line job-cost bill, pieces x rate.
// TODO(decision-D-05): karigars are vendors paid through bills, not payroll.
function karigarWork(input, ctx) {
  return createBill({
    docId: input.docId, date: input.date, contactId: input.contactId, vendorRef: input.vendorRef || '', dueDate: input.dueDate || '',
    memo: input.memo || input.description || '',
    lines: [{
      lineKind: 'JOB', jobId: input.jobId, costComponent: input.costComponent, qty: input.pieces,
      unitCostPaisa: input.ratePaisa, taxCodeId: input.taxCodeId || '', description: input.description || '',
    }],
  }, ctx);
}

// ---------- R5. Bill payment with withholding tax ----------

function vendorWhtCode(ctx, vendor, input) {
  if (input.applyWht === false || input.fromVendorAdvance) return null;
  const id = input.whtTaxCodeId || vendor.whtTaxCodeId;
  const code = findTaxCode(ctx, id, input.date, ['WHT']);
  if (code && code.vendorFilerStatus !== 'ANY' && !isBlank(vendor.filerStatus) && code.vendorFilerStatus !== vendor.filerStatus) {
    fail('E_VALIDATION', 'Tax code ' + code.id + ' is for ' + code.vendorFilerStatus + ' vendors, but ' + vendor.name + ' is ' + vendor.filerStatus, 'whtTaxCodeId');
  }
  return code;
}

// WHT on paying `amount` of a bill (R5): base is the amount paid, or its
// share excluding sales tax (base = round(paid x billNet / billGross)).
// Shared with the page so its preview equals what will be posted.
function whtOnBillPayment(bill, amount, code) {
  if (!code || !code.rateBps) return 0;
  const base = code.whtBase === 'GROSS' ? amount : Money.divRoundHalfEven(BigInt(amount) * BigInt(bill.netPaisa), bill.grossPaisa);
  return Money.applyBps(base, code.rateBps);
}

function payBills(input, ctx) {
  const vendor = getContact(ctx, input.contactId);
  if (!Array.isArray(input.allocations) || !input.allocations.length) fail('E_VALIDATION', 'Choose at least one bill to pay', 'allocations');
  const e = start(input, ctx, 'PAYMENT', input.docId);
  const whtCode = vendorWhtCode(ctx, vendor, input);
  // TODO(decision-D-04): WHT base and rates come from TaxCodes; confirm with the tax advisor.
  const creditCode = input.fromVendorAdvance ? sysCode(ctx, 'VENDOR_ADV') : moneyCode(ctx, input.moneyAccountCode);

  const apByBrand = {};
  const whtByBrand = {};
  const allocWht = [];
  let overridden = false;
  let totalSettled = 0;
  let totalWht = 0;
  input.allocations.forEach(function (a, i) {
    const field = 'allocations[' + i + ']';
    const bill = lookup(ctx.bills, a.billId, 'Bill', field + '.billId');
    if (bill.contactId !== vendor.id) fail('E_VALIDATION', 'Bill ' + bill.id + ' is not from ' + vendor.name, field + '.billId');
    if (bill.status === 'VOID') fail('E_VALIDATION', 'Bill ' + bill.id + ' has been reversed', field + '.billId');
    if (!bill.grossByBrand) fail('E_VALIDATION', 'Bill ' + bill.id + ' is missing its totals by brand', field + '.billId');
    const p = positivePaisa(a.amountPaisa, field + '.amountPaisa');
    const paid = bill.paidPaisa || 0;
    const balance = bill.grossPaisa - paid;
    if (p > balance) fail('E_OVERPAY', 'Bill ' + bill.id + ' only has ' + Money.formatPaisa(balance) + ' left to pay', field + '.amountPaisa');

    // D-17: split by brand so that once the bill is fully paid, each brand's AP clears exactly.
    // TODO(decision-D-17): pro-rata by the bill's gross per brand.
    const before = splitByBrand(paid, bill.grossByBrand);
    const after = splitByBrand(paid + p, bill.grossByBrand);
    let w = whtOnBillPayment(bill, p, whtCode);
    if (!isBlank(a.whtPaisa) && a.whtPaisa !== w) {
      if (isBlank(input.whtOverrideReason)) fail('E_TAX_OVERRIDE_NO_REASON', 'Give a reason for changing the withholding tax', 'whtOverrideReason');
      w = nonNegativePaisa(a.whtPaisa, field + '.whtPaisa');
      if (w > p) fail('E_VALIDATION', 'Withholding tax cannot be more than the amount settled', field + '.whtPaisa');
      overridden = true;
    }
    allocWht.push(w);
    const wSplit = splitByBrand(w, bill.grossByBrand);
    BRANDS.forEach(function (b) {
      addTo(apByBrand, b, (after[b] || 0) - (before[b] || 0));
      addTo(whtByBrand, b, wSplit[b] || 0);
    });
    totalSettled += p;
    totalWht += w;
    e.docUpdates.push({
      docType: 'BILL', id: bill.id,
      fields: { paidPaisa: paid + p, whtPaisa: (bill.whtPaisa || 0) + w, balancePaisa: balance - p },
    });
  });

  BRANDS.forEach(function (b) {
    post(e, sysCode(ctx, 'AP'), b, apByBrand[b] || 0, { contactId: vendor.id });
    post(e, creditCode, b, -((apByBrand[b] || 0) - (whtByBrand[b] || 0)), { contactId: vendor.id });
    post(e, sysCode(ctx, 'WHT_PAYABLE'), b, -(whtByBrand[b] || 0), { contactId: vendor.id });
  });
  e.doc = {
    id: input.docId || '', date: input.date, direction: 'OUT', kind: 'VENDOR_PAYMENT', contactId: vendor.id,
    moneyAccountCode: input.fromVendorAdvance ? '' : String(input.moneyAccountCode), fromVendorAdvance: !!input.fromVendorAdvance,
    amountPaisa: totalSettled - totalWht, whtPaisa: totalWht, whtTaxCodeId: whtCode ? whtCode.id : '', reference: input.reference || '',
    whtOverrideReason: overridden ? input.whtOverrideReason : '',
    allocations: input.allocations.map(function (a, i) { return { docType: 'BILL', docId: a.billId, amountPaisa: a.amountPaisa, whtPaisa: allocWht[i] }; }),
  };
  return finish(e, ctx);
}

// Advance to a vendor or karigar (M4.6), later applied with payBills({fromVendorAdvance: true}).
// TODO(decision-D-04): WHT on vendor advances is not deducted yet.
function payVendorAdvance(input, ctx) {
  const vendor = getContact(ctx, input.contactId);
  const brand = checkBrand(input.brand || 'SHARED');
  const amount = positivePaisa(input.amountPaisa, 'amountPaisa');
  const e = start(input, ctx, 'PAYMENT', input.docId);
  dr(e, sysCode(ctx, 'VENDOR_ADV'), brand, amount, { contactId: vendor.id });
  cr(e, moneyCode(ctx, input.moneyAccountCode), brand, amount, { contactId: vendor.id });
  e.doc = {
    id: input.docId || '', date: input.date, direction: 'OUT', kind: 'VENDOR_ADVANCE', contactId: vendor.id, brand: brand,
    moneyAccountCode: String(input.moneyAccountCode), amountPaisa: amount, reference: input.reference || '', allocations: [],
  };
  return finish(e, ctx);
}

// ---------- R6. Expense paid immediately (and R18 drawings) ----------

function createExpense(input, ctx) {
  if (input.isDrawings) return recordDrawings(input, ctx);
  const contact = isBlank(input.contactId) ? null : getContact(ctx, input.contactId);
  const registered = !!(contact && !isBlank(contact.strn));
  if (!Array.isArray(input.lines) || !input.lines.length) fail('E_VALIDATION', 'An expense needs at least one line', 'lines');
  const e = start(input, ctx, 'EXPENSE', input.docId);
  const money = moneyCode(ctx, input.moneyAccountCode);
  const refs = { contactId: contact ? contact.id : '' };

  const prepared = input.lines.map(function (l, i) {
    const field = 'lines[' + i + ']';
    const a = freeChoiceAccount(ctx, l.accountCode, field + '.accountCode');
    return {
      src: l, field: field, account: a.code, brand: checkBrand(l.brand || a.defaultBrand, field + '.brand'),
      net: nonNegativePaisa(l.netPaisa, field + '.netPaisa'),
      code: findTaxCode(ctx, l.taxCodeId, input.date, ['PURCHASE_INPUT', 'EXEMPT', 'ZERO']),
    };
  });
  const computed = exclusiveTax(prepared.map(function (p) { return p.net; }), prepared.map(function (p) { return p.code; }));
  let overridden = false;
  prepared.forEach(function (p, i) {
    p.tax = computed[i];
    if (!isBlank(p.src.taxPaisa) && p.src.taxPaisa !== computed[i]) { p.tax = nonNegativePaisa(p.src.taxPaisa, p.field + '.taxPaisa'); overridden = true; }
  });
  if (overridden && isBlank(input.taxOverrideReason)) fail('E_TAX_OVERRIDE_NO_REASON', 'Give a reason for changing the tax amount', 'taxOverrideReason');

  const inputTaxByBrand = {};
  const grossByBrand = {};
  prepared.forEach(function (p) {
    const claimable = !!(p.code && p.code.claimable && registered);
    dr(e, p.account, p.brand, p.net + (claimable ? 0 : p.tax), Object.assign({ memo: p.src.description }, refs));
    if (claimable) addTo(inputTaxByBrand, p.brand, p.tax);
    addTo(grossByBrand, p.brand, p.net + p.tax);
  });
  const net = prepared.reduce(function (s, p) { return s + p.net; }, 0);
  const tax = prepared.reduce(function (s, p) { return s + p.tax; }, 0);
  const gross = net + tax;
  if (gross <= 0) fail('E_VALIDATION', 'An expense cannot be for zero', 'lines');

  const whtCode = contact ? vendorWhtCode(ctx, contact, input) : findTaxCode(ctx, input.whtTaxCodeId, input.date, ['WHT']);
  const w = whtCode && whtCode.rateBps > 0 ? Money.applyBps(whtCode.whtBase === 'GROSS' ? gross : net, whtCode.rateBps) : 0;
  const whtByBrand = splitByBrand(w, grossByBrand);
  BRANDS.forEach(function (b) {
    if (inputTaxByBrand[b]) dr(e, sysCode(ctx, 'INPUT_TAX'), b, inputTaxByBrand[b], refs);
  });
  BRANDS.forEach(function (b) {
    post(e, money, b, -((grossByBrand[b] || 0) - (whtByBrand[b] || 0)), refs);
    post(e, sysCode(ctx, 'WHT_PAYABLE'), b, -(whtByBrand[b] || 0), refs);
  });
  e.doc = {
    id: input.docId || '', date: input.date, kind: 'EXPENSE', contactId: refs.contactId, moneyAccountCode: money,
    netPaisa: net, taxPaisa: tax, grossPaisa: gross, whtPaisa: w, whtTaxCodeId: whtCode ? whtCode.id : '', amountPaisa: gross - w,
    taxOverrideReason: overridden ? input.taxOverrideReason : '',
    lines: prepared.map(function (p) {
      return { accountCode: p.account, brand: p.brand, netPaisa: p.net, taxPaisa: p.tax, taxCodeId: p.code ? p.code.id : '', description: p.src.description || '' };
    }),
  };
  return finish(e, ctx);
}

// R18. Owner drawings / family payments: never an expense, never on the P&L.
// TODO(decision-D-12): drawings policy for family members.
function recordDrawings(input, ctx) {
  const person = getContact(ctx, input.contactId);
  if (person.kind !== 'FAMILY') fail('E_VALIDATION', 'Drawings are paid to a family member', 'contactId');
  const amount = !isBlank(input.amountPaisa) ? positivePaisa(input.amountPaisa, 'amountPaisa')
    : positivePaisa((input.lines || []).reduce(function (s, l) { return s + (l.netPaisa || 0); }, 0), 'amountPaisa');
  const e = start(input, ctx, 'PAYMENT', input.docId);
  dr(e, sysCode(ctx, 'OWNER_DRAWINGS'), 'SHARED', amount, { contactId: person.id });
  cr(e, moneyCode(ctx, input.moneyAccountCode), 'SHARED', amount, { contactId: person.id });
  e.doc = {
    id: input.docId || '', date: input.date, direction: 'OUT', kind: 'DRAWINGS', contactId: person.id, brand: 'SHARED',
    moneyAccountCode: String(input.moneyAccountCode), amountPaisa: amount, reference: input.reference || '', allocations: [],
  };
  return finish(e, ctx);
}

// ---------- R7. Issue stock to a job, and return it ----------

function issueStock(input, ctx) {
  const job = getJob(ctx, input.jobId);
  const late = checkJobTakesCost(job);
  if (!Array.isArray(input.lines) || !input.lines.length) fail('E_VALIDATION', 'Choose at least one item to issue', 'lines');
  const e = start(input, ctx, 'STOCK_ISSUE', job.id);
  const ledger = ledgerFor(ctx);
  input.lines.forEach(function (l, i) {
    const item = getItem(ctx, l.itemId);
    const component = Inventory.COMPONENT_BY_CATEGORY[item.category];
    if (!component) fail('E_VALIDATION', item.id + ' is a finished SKU and cannot be issued to a job', 'lines[' + i + '].itemId');
    const move = ledger.issue(item.id, l.qty, 'ISSUE');
    addMove(e, move, { jobId: job.id });
    const value = -move.valuePaisa;
    postJobCost(e, ctx, job, value, component, { itemId: item.id, qty: l.qty }, late);
    cr(e, sysCode(ctx, Inventory.ACCOUNT_KEY_BY_CATEGORY[item.category]), Inventory.itemBrand(item), value, { itemId: item.id, qty: move.qty, jobId: job.id });
  });
  return finish(e, ctx, ledger);
}

// How much of an issue move can still come back: {qtyMilli, valuePaisa}.
function returnableFromIssue(ctx, issue) {
  let qtyMilli = -Inventory.toMilli(issue.qty);
  let value = -issue.valuePaisa;
  (ctx.stockMoves || []).forEach(function (m) {
    if (m.sourceMoveId === issue.id && m.moveType === 'RETURN_TO_STOCK') {
      qtyMilli -= Inventory.toMilli(m.qty);
      value -= m.valuePaisa;
    }
  });
  return { qtyMilli: qtyMilli, valuePaisa: value };
}

// Post the return of qty from an issue move at its original cost.
function postReturnFromIssue(e, ctx, ledger, job, issue, qty) {
  const item = getItem(ctx, issue.itemId);
  const left = returnableFromIssue(ctx, issue);
  const qm = Inventory.toMilli(qty);
  if (qm <= 0) fail('E_VALIDATION', 'Quantity must be more than zero', 'qty');
  if (qm > left.qtyMilli) fail('E_VALIDATION', 'Only ' + Inventory.fromMilli(left.qtyMilli) + ' can be returned from that issue', 'qty');
  const issuedMilli = -Inventory.toMilli(issue.qty);
  const value = qm === left.qtyMilli ? left.valuePaisa
    : Money.divRoundHalfEven(BigInt(-issue.valuePaisa) * BigInt(qm), issuedMilli);
  const move = ledger.receive(item.id, qty, value, 'RETURN_TO_STOCK');
  addMove(e, move, { jobId: job.id, sourceMoveId: issue.id });
  const component = Inventory.COMPONENT_BY_CATEGORY[item.category];
  dr(e, sysCode(ctx, Inventory.ACCOUNT_KEY_BY_CATEGORY[item.category]), Inventory.itemBrand(item), value, { itemId: item.id, qty: move.qty, jobId: job.id });
  cr(e, sysCode(ctx, 'WIP'), job.brand, value, { jobId: job.id, costComponent: component, itemId: item.id, qty: -move.qty });
  return { component: component, value: value };
}

function returnStock(input, ctx) {
  const job = getJob(ctx, input.jobId);
  if (job.status === 'CANCELLED' || job.status === 'DELIVERED' || job.status === 'COMPLETED') {
    fail('E_JOB_CLOSED', 'Job ' + job.id + ' is ' + String(job.status).toLowerCase(), 'jobId');
  }
  const issue = (ctx.stockMoves || []).filter(function (m) { return m.id === input.issueMoveId; })[0];
  if (!issue || issue.moveType !== 'ISSUE' || issue.jobId !== job.id) fail('E_NOT_FOUND', 'Issue ' + input.issueMoveId + ' not found on job ' + job.id, 'issueMoveId');
  const e = start(input, ctx, 'STOCK_RETURN', job.id);
  const ledger = ledgerFor(ctx);
  postReturnFromIssue(e, ctx, ledger, job, issue, input.qty);
  return finish(e, ctx, ledger);
}

// ---------- R8. MTO delivery: invoice, apply advances, release WIP ----------

function deliverJob(input, ctx) {
  const job = getJob(ctx, input.jobId);
  if (job.type !== 'MTO_ORDER') fail('E_VALIDATION', 'Only made-to-order jobs are delivered', 'jobId');
  if (OPEN_MTO_STATUSES.indexOf(job.status) === -1) fail('E_JOB_CLOSED', 'Order ' + job.id + ' is ' + String(job.status).toLowerCase(), 'jobId');
  const settings = ctx.settings || {};
  const quoteLines = (job.lines || []).concat(input.extraLines || []);
  if (!quoteLines.length) fail('E_VALIDATION', 'The order has no lines to invoice', 'lines');
  const e = start(input, ctx, 'INVOICE', input.docId);
  const refs = { contactId: job.contactId, jobId: job.id };

  const revenueByAccount = {};
  const invoiceLines = quoteLines.map(function (l, i) {
    const field = 'lines[' + i + ']';
    const net = Inventory.qtyTimesPaisa(isBlank(l.qty) ? 1 : l.qty, nonNegativePaisa(l.unitPricePaisa, field + '.unitPricePaisa')) -
      nonNegativePaisa(l.discountPaisa || 0, field + '.discountPaisa');
    if (net < 0) fail('E_VALIDATION', 'A discount is bigger than its line', field + '.discountPaisa');
    const acct = getAccount(ctx, l.revenueAccount || job.revenueAccount || settings.defaultMtoRevenueAccount, field + '.revenueAccount');
    if (acct.type !== 'REVENUE') fail('E_VALIDATION', acct.code + ' is not a revenue account', field + '.revenueAccount');
    addTo(revenueByAccount, acct.code, net);
    return {
      description: l.description || '', itemId: l.itemId || '', qty: isBlank(l.qty) ? 1 : l.qty, unitPricePaisa: l.unitPricePaisa,
      discountPaisa: l.discountPaisa || 0, netPaisa: net, revenueAccount: acct.code,
    };
  });
  const n = invoiceLines.reduce(function (s, l) { return s + l.netPaisa; }, 0);
  const code = findTaxCode(ctx, input.taxCodeId || job.taxCodeId, input.date, ['SALES_OUTPUT', 'EXEMPT', 'ZERO']);
  let t = code ? Money.applyBps(n, code.rateBps) : 0;
  let overrideReason = '';
  if (input.taxOverride && !isBlank(input.taxOverride.taxPaisa) && input.taxOverride.taxPaisa !== t) {
    if (isBlank(input.taxOverride.reason)) fail('E_TAX_OVERRIDE_NO_REASON', 'Give a reason for changing the tax amount', 'taxOverride.reason');
    t = nonNegativePaisa(input.taxOverride.taxPaisa, 'taxOverride.taxPaisa');
    overrideReason = input.taxOverride.reason;
  }
  const g = n + t;
  const held = (ctx.jobAdvances || {})[job.id] || 0;
  const applied = Math.max(0, Math.min(held, g));

  dr(e, sysCode(ctx, 'AR'), job.brand, g, refs);
  Object.keys(revenueByAccount).sort().forEach(function (code2) { cr(e, code2, job.brand, revenueByAccount[code2], refs); });
  cr(e, sysCode(ctx, 'OUTPUT_TAX'), job.brand, t, refs);
  dr(e, sysCode(ctx, 'CUSTOMER_ADV'), job.brand, applied, refs);
  cr(e, sysCode(ctx, 'AR'), job.brand, applied, refs);

  const wip = (ctx.jobWip || {})[job.id] || {};
  let cost = 0;
  Object.keys(wip).sort().forEach(function (component) {
    const c = wip[component];
    const comp = component || 'OTHER';
    post(e, cogsCode(ctx, comp), job.brand, c, { jobId: job.id, costComponent: comp });
    post(e, sysCode(ctx, 'WIP'), job.brand, -c, { jobId: job.id, costComponent: component });
    cost += c;
  });

  const margin = n - cost;
  e.doc = {
    id: input.docId || '', date: input.date, contactId: job.contactId, brand: job.brand, jobId: job.id, status: 'POSTED',
    dueDate: input.dueDate || input.date, netPaisa: n, taxPaisa: t, grossPaisa: g, taxCodeId: code ? code.id : '',
    taxOverrideReason: overrideReason, advanceAppliedPaisa: applied, paidPaisa: 0, balancePaisa: g - applied,
    refundDuePaisa: Math.max(0, held - g), costPaisa: cost, marginPaisa: margin,
    marginBps: n === 0 ? null : Money.divRoundHalfEven(BigInt(margin) * BigInt(10000), n), lines: invoiceLines,
  };
  e.docUpdates.push({ docType: 'JOB', id: job.id, fields: { status: 'DELIVERED', deliveredDate: input.date, invoiceId: input.docId || '' } });
  return finish(e, ctx);
}

// ---------- R9. Customer payment against invoices ----------

function receivePayment(input, ctx) {
  const customer = getContact(ctx, input.contactId);
  const amt = resolveAmount(input);
  if (!Array.isArray(input.allocations) || !input.allocations.length) fail('E_VALIDATION', 'Choose the invoice being paid', 'allocations');
  const e = start(input, ctx, 'PAYMENT', input.docId);
  const money = moneyCode(ctx, input.moneyAccountCode);
  const byBrand = {};
  let allocated = 0;
  input.allocations.forEach(function (a, i) {
    const field = 'allocations[' + i + ']';
    const inv = lookup(ctx.invoices, a.invoiceId, 'Invoice', field + '.invoiceId');
    if (inv.contactId !== customer.id) fail('E_VALIDATION', 'Invoice ' + inv.id + ' is not for ' + customer.name, field + '.invoiceId');
    if (inv.status === 'VOID') fail('E_VALIDATION', 'Invoice ' + inv.id + ' has been reversed', field + '.invoiceId');
    const p = positivePaisa(a.amountPaisa, field + '.amountPaisa');
    if (p > inv.balancePaisa) fail('E_OVERPAY', 'Invoice ' + inv.id + ' only has ' + Money.formatPaisa(inv.balancePaisa) + ' left to pay', field + '.amountPaisa');
    const brand = checkBrand(inv.brand);
    if (!byBrand[brand]) byBrand[brand] = [];
    byBrand[brand].push({ inv: inv, amount: p });
    allocated += p;
    e.docUpdates.push({ docType: 'INVOICE', id: inv.id, fields: { paidPaisa: (inv.paidPaisa || 0) + p, balancePaisa: inv.balancePaisa - p } });
  });
  // TODO: "on account" receipts (more than the invoices being paid) are not supported yet.
  if (allocated !== amt.amount) fail('E_VALIDATION', 'Amount received must equal the amounts applied to invoices', 'amountPaisa');
  const brands = BRANDS.filter(function (b) { return byBrand[b]; });
  brands.forEach(function (b) {
    const total = byBrand[b].reduce(function (s, x) { return s + x.amount; }, 0);
    const fx = brands.length === 1 ? amt.fx : { currency: amt.fx.currency, fxRate: amt.fx.fxRate };
    dr(e, money, b, total, Object.assign({ contactId: customer.id }, fx));
    byBrand[b].forEach(function (x) { cr(e, sysCode(ctx, 'AR'), b, x.amount, { contactId: customer.id, jobId: x.inv.jobId || '' }); });
  });
  e.doc = {
    id: input.docId || '', date: input.date, direction: 'IN', kind: 'CUSTOMER_PAYMENT', contactId: customer.id,
    moneyAccountCode: money, amountPaisa: amt.amount, currency: amt.fx.currency || '', fxAmount: amt.fx.fxAmount || '', fxRate: amt.fx.fxRate || '',
    reference: input.reference || '',
    allocations: input.allocations.map(function (a) { return { docType: 'INVOICE', docId: a.invoiceId, amountPaisa: a.amountPaisa }; }),
  };
  return finish(e, ctx);
}

// ---------- R10. RTW batch completion ----------

function completeBatch(input, ctx) {
  const job = getJob(ctx, input.jobId);
  if (job.type !== 'RTW_BATCH') fail('E_VALIDATION', 'Only production batches are completed', 'jobId');
  if (job.status === 'COMPLETED' || job.status === 'CANCELLED') fail('E_JOB_CLOSED', 'Batch ' + job.id + ' is ' + String(job.status).toLowerCase(), 'jobId');
  if (!Array.isArray(input.outputs) || !input.outputs.length) fail('E_VALIDATION', 'Enter the pieces this batch produced', 'outputs');
  const wip = (ctx.jobWip || {})[job.id] || {};
  const total = Object.keys(wip).reduce(function (s, k) { return s + wip[k]; }, 0);
  if (total <= 0) fail('E_VALIDATION', 'Batch ' + job.id + ' has no cost to move into stock', 'jobId');
  const e = start(input, ctx, 'BATCH_COMPLETION', job.id);
  const ledger = ledgerFor(ctx);

  // C_s = C x q_s x w_s / Σ(q x w), exact, residual on the last SKU.
  const weights = input.outputs.map(function (o, i) {
    return Money.parseDecimal(isBlank(o.weight) ? 1 : o.weight, 6, 'outputs[' + i + '].weight');
  });
  const maxPlaces = weights.reduce(function (m, w) { return Math.max(m, w.places); }, 0);
  const products = input.outputs.map(function (o, i) {
    const item = getItem(ctx, o.itemId);
    if (item.category !== 'SKU') fail('E_VALIDATION', item.id + ' is not a finished SKU', 'outputs[' + i + '].itemId');
    const qm = Inventory.toMilli(o.qty);
    if (qm <= 0) fail('E_VALIDATION', 'Quantity must be more than zero', 'outputs[' + i + '].qty');
    if (weights[i].units < BigInt(0)) fail('E_VALIDATION', 'Weight cannot be negative', 'outputs[' + i + '].weight');
    return BigInt(qm) * weights[i].units * BigInt(10) ** BigInt(maxPlaces - weights[i].places);
  });
  const shares = Money.splitProRata(total, products);
  input.outputs.forEach(function (o, i) {
    const move = ledger.receive(o.itemId, o.qty, shares[i], 'BATCH_OUTPUT');
    addMove(e, move, { jobId: job.id });
    dr(e, sysCode(ctx, 'INV_FG'), job.brand, shares[i], { itemId: o.itemId, qty: move.qty, jobId: job.id });
  });
  Object.keys(wip).sort().forEach(function (component) {
    post(e, sysCode(ctx, 'WIP'), job.brand, -wip[component], { jobId: job.id, costComponent: component });
  });
  e.doc = { jobId: job.id, totalCostPaisa: total, outputs: input.outputs.map(function (o, i) { return { itemId: o.itemId, qty: o.qty, costPaisa: shares[i] }; }) };
  e.docUpdates.push({ docType: 'JOB', id: job.id, fields: { status: 'COMPLETED' } });
  return finish(e, ctx, ledger);
}

// ---------- R11, R12. RTW sales, returns and exchanges ----------

function postSaleLines(e, ctx, ledger, input, brand) {
  const settings = ctx.settings || {};
  const channel = input.channel || 'STORE';
  const revenueKey = SALES_KEY_BY_CHANNEL[channel];
  if (!revenueKey) fail('E_VALIDATION', 'Channel must be STORE, ONLINE or EXHIBITION', 'channel');
  if (!Array.isArray(input.lines) || !input.lines.length) fail('E_VALIDATION', 'Add at least one item to the sale', 'lines');
  const inclusive = isTrue(settings.rtwPricesIncludeTax);
  const prepared = input.lines.map(function (l, i) {
    const field = 'lines[' + i + ']';
    const item = getItem(ctx, l.itemId);
    if (item.category !== 'SKU') fail('E_VALIDATION', item.id + ' is not a finished SKU', field + '.itemId');
    if (Inventory.toMilli(l.qty) <= 0) fail('E_VALIDATION', 'Quantity must be more than zero', field + '.qty');
    const before = Inventory.qtyTimesPaisa(l.qty, nonNegativePaisa(l.unitPricePaisa, field + '.unitPricePaisa'));
    const discount = nonNegativePaisa(l.discountPaisa || 0, field + '.discountPaisa');
    if (discount > before) fail('E_VALIDATION', 'A discount is bigger than its line', field + '.discountPaisa');
    return {
      src: l, item: item, amount: before - discount, discount: discount,
      code: findTaxCode(ctx, l.taxCodeId || item.taxCodeId || input.taxCodeId, input.date, ['SALES_OUTPUT', 'EXEMPT', 'ZERO']),
    };
  });
  const amounts = prepared.map(function (p) { return p.amount; });
  const codes = prepared.map(function (p) { return p.code; });
  let nets;
  let taxes;
  if (inclusive) {
    const r = inclusiveTax(amounts, codes);
    nets = r.nets; taxes = r.taxes;
  } else {
    nets = amounts; taxes = exclusiveTax(amounts, codes);
  }
  // D-06: discounts are net in revenue; gross and discount are kept on the document.
  // TODO(decision-D-06): option to post discounts to SALES_RETURNS instead.
  const refs = { contactId: input.contactId || '' };
  const saleLines = prepared.map(function (p, i) {
    const avgBefore = ledger.balance(p.item.id).avgCostMicro;
    const move = ledger.issue(p.item.id, p.src.qty, 'SALE');
    addMove(e, move);
    const cost = -move.valuePaisa;
    dr(e, sysCode(ctx, 'COGS_RTW'), brand, cost, { itemId: p.item.id, qty: p.src.qty });
    cr(e, sysCode(ctx, 'INV_FG'), brand, cost, { itemId: p.item.id, qty: move.qty });
    return {
      itemId: p.item.id, qty: p.src.qty, unitPricePaisa: p.src.unitPricePaisa, discountPaisa: p.discount,
      netPaisa: nets[i], taxPaisa: taxes[i], unitCostMicro: avgBefore, costPaisa: cost,
    };
  });
  const n = nets.reduce(function (s, x) { return s + x; }, 0);
  const t = taxes.reduce(function (s, x) { return s + x; }, 0);
  cr(e, sysCode(ctx, revenueKey), brand, n, refs);
  cr(e, sysCode(ctx, 'OUTPUT_TAX'), brand, t, refs);
  return {
    channel: channel, lines: saleLines, netPaisa: n, taxPaisa: t, grossPaisa: n + t, pricesIncludeTax: inclusive,
    discountPaisa: prepared.reduce(function (s, p) { return s + p.discount; }, 0),
  };
}

function postReturnLines(e, ctx, ledger, input, brand) {
  const orig = lookup(ctx.sales, input.originalSaleId, 'Sale', 'originalSaleId');
  if (orig.sale.kind && orig.sale.kind !== 'SALE' && orig.sale.kind !== 'EXCHANGE') fail('E_VALIDATION', 'Only sales can be returned', 'originalSaleId');
  if (orig.sale.status === 'VOID') fail('E_VALIDATION', 'Sale ' + orig.sale.id + ' has been reversed', 'originalSaleId');
  const lines = input.returnLines || input.lines;
  if (!Array.isArray(lines) || !lines.length) fail('E_VALIDATION', 'Choose what is being returned', 'lines');
  const refs = { contactId: orig.sale.contactId || '' };
  const out = [];
  let n = 0;
  let t = 0;
  lines.forEach(function (r, i) {
    const field = 'lines[' + i + ']';
    const ol = orig.lines.filter(function (x) { return x.id === r.saleLineId; })[0];
    if (!ol) fail('E_NOT_FOUND', 'Line ' + r.saleLineId + ' is not on sale ' + orig.sale.id, field + '.saleLineId');
    const soldMilli = Inventory.toMilli(ol.qty);
    const done = {
      qtyMilli: Inventory.toMilli(ol.returnedQty || 0), net: ol.returnedNetPaisa || 0,
      tax: ol.returnedTaxPaisa || 0, cost: ol.returnedCostPaisa || 0,
    };
    const qm = Inventory.toMilli(r.qty);
    if (qm <= 0) fail('E_VALIDATION', 'Quantity must be more than zero', field + '.qty');
    const leftMilli = soldMilli - done.qtyMilli;
    if (qm > leftMilli) fail('E_VALIDATION', 'Only ' + Inventory.fromMilli(leftMilli) + ' of ' + ol.itemId + ' can be returned', field + '.qty');
    // At the original sale's price and cost (R12); the last piece takes what is left.
    function part(total, already) {
      return qm === leftMilli ? total - already : Money.divRoundHalfEven(BigInt(total) * BigInt(qm), soldMilli);
    }
    const lr = { net: part(ol.netPaisa, done.net), tax: part(ol.taxPaisa, done.tax), cost: part(ol.costPaisa, done.cost) };
    const restock = r.restock !== false;
    dr(e, sysCode(ctx, 'SALES_RETURNS'), brand, lr.net, refs);
    dr(e, sysCode(ctx, 'OUTPUT_TAX'), brand, lr.tax, refs);
    if (restock) {
      const move = ledger.receive(ol.itemId, r.qty, lr.cost, 'SALE_RETURN');
      addMove(e, move, { sourceMoveId: '' });
      dr(e, sysCode(ctx, 'INV_FG'), brand, lr.cost, { itemId: ol.itemId, qty: move.qty });
    } else {
      dr(e, sysCode(ctx, 'SHRINKAGE'), brand, lr.cost, { itemId: ol.itemId, qty: r.qty });
    }
    cr(e, sysCode(ctx, 'COGS_RTW'), brand, lr.cost, { itemId: ol.itemId, qty: r.qty });
    n += lr.net;
    t += lr.tax;
    out.push({ originalLineId: ol.id, itemId: ol.itemId, qty: r.qty, netPaisa: lr.net, taxPaisa: lr.tax, costPaisa: lr.cost, restock: restock });
    e.docUpdates.push({
      docType: 'SALE_LINE', id: ol.id,
      fields: {
        returnedQty: Inventory.fromMilli(done.qtyMilli + qm), returnedNetPaisa: done.net + lr.net,
        returnedTaxPaisa: done.tax + lr.tax, returnedCostPaisa: done.cost + lr.cost,
      },
    });
  });
  return { sale: orig.sale, lines: out, netPaisa: n, taxPaisa: t, grossPaisa: n + t };
}

// Post money in (positive) or out (negative) by payment method.
function postPayments(e, ctx, payments, sign, brand, contactId, field) {
  let total = 0;
  (payments || []).forEach(function (p, i) {
    const code = moneyCode(ctx, p.accountCode, field + '[' + i + '].accountCode');
    const amount = positivePaisa(p.amountPaisa, field + '[' + i + '].amountPaisa');
    post(e, code, brand, sign * amount, { contactId: contactId || '', memo: p.reference || '' });
    total += amount;
  });
  return total;
}

function cleanPayments(payments) {
  return (payments || []).map(function (p) {
    return { method: p.method || '', accountCode: String(p.accountCode), amountPaisa: p.amountPaisa, reference: p.reference || '' };
  });
}

function createSale(input, ctx) {
  const brand = 'MIRAE';
  const e = start(input, ctx, 'SALE', input.docId);
  const ledger = ledgerFor(ctx);
  const s = postSaleLines(e, ctx, ledger, input, brand);
  const paid = postPayments(e, ctx, input.payments, 1, brand, input.contactId, 'payments');
  if (paid !== s.grossPaisa) {
    fail('E_VALIDATION', 'Payments ' + Money.formatPaisa(paid) + ' do not add up to the total ' + Money.formatPaisa(s.grossPaisa), 'payments');
  }
  e.doc = Object.assign({
    id: input.docId || '', date: input.date, kind: 'SALE', status: 'POSTED', brand: brand, store: input.store || '',
    contactId: input.contactId || '', fbrInvoiceNo: input.fbrInvoiceNo || '', originalSaleId: '', payments: cleanPayments(input.payments),
  }, s);
  return finish(e, ctx, ledger);
}

function returnSale(input, ctx) {
  const brand = 'MIRAE';
  const e = start(input, ctx, 'SALE', input.docId);
  const ledger = ledgerFor(ctx);
  const r = postReturnLines(e, ctx, ledger, input, brand);
  const refunded = postPayments(e, ctx, input.refund, -1, brand, r.sale.contactId, 'refund');
  if (refunded !== r.grossPaisa) {
    fail('E_VALIDATION', 'Refund ' + Money.formatPaisa(refunded) + ' must equal the value returned ' + Money.formatPaisa(r.grossPaisa), 'refund');
  }
  e.doc = {
    id: input.docId || '', date: input.date, kind: 'RETURN', status: 'POSTED', brand: brand, store: r.sale.store || '',
    channel: r.sale.channel || 'STORE', contactId: r.sale.contactId || '', originalSaleId: r.sale.id,
    netPaisa: r.netPaisa, taxPaisa: r.taxPaisa, grossPaisa: r.grossPaisa, lines: r.lines, payments: cleanPayments(input.refund),
  };
  return finish(e, ctx, ledger);
}

// Exchange = return + new sale in one entry; only the difference moves money.
function exchangeSale(input, ctx) {
  const brand = 'MIRAE';
  const e = start(input, ctx, 'SALE', input.docId);
  const ledger = ledgerFor(ctx);
  const r = postReturnLines(e, ctx, ledger, { originalSaleId: input.originalSaleId, returnLines: input.returnLines }, brand);
  const s = postSaleLines(e, ctx, ledger, {
    date: input.date, channel: input.channel || r.sale.channel || 'STORE', lines: input.newLines,
    contactId: r.sale.contactId, taxCodeId: input.taxCodeId,
  }, brand);
  const inMoney = postPayments(e, ctx, input.payments, 1, brand, r.sale.contactId, 'payments');
  const outMoney = postPayments(e, ctx, input.refund, -1, brand, r.sale.contactId, 'refund');
  if (inMoney - outMoney !== s.grossPaisa - r.grossPaisa) {
    fail('E_VALIDATION', 'Money in and out must equal the difference ' + Money.formatPaisa(s.grossPaisa - r.grossPaisa), 'payments');
  }
  e.doc = {
    id: input.docId || '', date: input.date, kind: 'EXCHANGE', status: 'POSTED', brand: brand, store: input.store || r.sale.store || '',
    channel: s.channel, contactId: r.sale.contactId || '', originalSaleId: r.sale.id,
    netPaisa: s.netPaisa - r.netPaisa, taxPaisa: s.taxPaisa - r.taxPaisa, grossPaisa: s.grossPaisa - r.grossPaisa,
    returnLines: r.lines, lines: s.lines, payments: cleanPayments(input.payments), refund: cleanPayments(input.refund),
  };
  return finish(e, ctx, ledger);
}

// ---------- R13. Card / wallet settlement ----------

function settleCards(input, ctx) {
  const clearing = getAccount(ctx, input.clearingCode, 'clearingCode');
  if (clearing.moneyKind !== 'CLEARING' || clearing.systemKey === 'STORE_CREDIT') fail('E_VALIDATION', clearing.code + ' is not a card clearing account', 'clearingCode');
  const bank = moneyCode(ctx, input.bankCode, 'bankCode');
  const gross = positivePaisa(input.grossPaisa, 'grossPaisa');
  const fee = nonNegativePaisa(input.feePaisa || 0, 'feePaisa');
  if (fee >= gross) fail('E_VALIDATION', 'The fee must be less than the amount settled', 'feePaisa');
  const e = start(input, ctx, 'PAYMENT', input.docId);
  // TODO(decision-D-21): fees always go to MIRAE, even on UMSHA card receipts.
  dr(e, bank, 'SHARED', gross - fee);
  dr(e, sysCode(ctx, 'CARD_FEES'), 'MIRAE', fee);
  cr(e, clearing.code, 'SHARED', gross);
  e.doc = {
    id: input.docId || '', date: input.date, direction: 'IN', kind: 'SETTLEMENT', moneyAccountCode: bank,
    clearingCode: clearing.code, amountPaisa: gross - fee, feePaisa: fee, grossPaisa: gross, reference: input.reference || '', allocations: [],
  };
  return finish(e, ctx);
}

// ---------- R14. Transfer between money accounts ----------

function transfer(input, ctx) {
  const from = moneyCode(ctx, input.fromCode, 'fromCode');
  const to = moneyCode(ctx, input.toCode, 'toCode');
  if (from === to) fail('E_VALIDATION', 'Choose two different accounts', 'toCode');
  const amount = positivePaisa(input.amountPaisa, 'amountPaisa');
  const e = start(input, ctx, 'PAYMENT', input.docId);
  dr(e, to, 'SHARED', amount);
  cr(e, from, 'SHARED', amount);
  e.doc = {
    id: input.docId || '', date: input.date, direction: 'OUT', kind: 'TRANSFER', moneyAccountCode: from, toAccountCode: to,
    amountPaisa: amount, reference: input.reference || '', allocations: [],
  };
  return finish(e, ctx);
}

// ---------- R15. Stock count ----------

function postStockCount(input, ctx) {
  if (!Array.isArray(input.lines) || !input.lines.length) fail('E_VALIDATION', 'Enter at least one counted item', 'lines');
  const e = start(input, ctx, 'STOCK_COUNT', input.docId);
  const ledger = ledgerFor(ctx);
  const countLines = input.lines.map(function (l, i) {
    const field = 'lines[' + i + ']';
    const item = getItem(ctx, l.itemId);
    const counted = Inventory.toMilli(l.countedQty);
    if (counted < 0) fail('E_VALIDATION', 'Counted quantity cannot be negative', field + '.countedQty');
    const bal = ledger.balance(item.id);
    const system = Inventory.toMilli(bal.qty);
    const diff = counted - system;
    const invCode = sysCode(ctx, Inventory.ACCOUNT_KEY_BY_CATEGORY[item.category]);
    const brand = Inventory.itemBrand(item);
    let value = 0;
    if (diff < 0) {
      const move = ledger.issue(item.id, Inventory.fromMilli(-diff), 'ADJUSTMENT');
      addMove(e, move);
      value = move.valuePaisa;
      dr(e, sysCode(ctx, 'SHRINKAGE'), brand, -value, { itemId: item.id, qty: Inventory.fromMilli(-diff) });
      cr(e, invCode, brand, -value, { itemId: item.id, qty: move.qty });
    } else if (diff > 0) {
      value = Inventory.valueAt(diff, bal.avgCostMicro);
      const move = ledger.receive(item.id, Inventory.fromMilli(diff), value, 'ADJUSTMENT');
      addMove(e, move);
      dr(e, invCode, brand, value, { itemId: item.id, qty: move.qty });
      cr(e, sysCode(ctx, 'SHRINKAGE'), brand, value, { itemId: item.id, qty: -move.qty });
    }
    return { itemId: item.id, systemQty: bal.qty, countedQty: l.countedQty, diffQty: Inventory.fromMilli(diff), valuePaisa: value };
  });
  e.doc = { id: input.docId || '', date: input.date, location: input.location || '', status: 'POSTED', lines: countLines };
  return finish(e, ctx, ledger);
}

// ---------- R16. Daily cash-up ----------

function cashUp(input, ctx) {
  const cash = moneyCode(ctx, input.cashAccountCode, 'cashAccountCode');
  const expected = Money.assertPaisa(input.expectedCashPaisa, 'expectedCashPaisa');
  const counted = nonNegativePaisa(input.countedCashPaisa, 'countedCashPaisa');
  const diff = counted - expected;
  const e = start(input, ctx, 'CASHUP', input.docId);
  post(e, cash, 'MIRAE', diff);
  post(e, sysCode(ctx, 'CASH_OVER_SHORT'), 'MIRAE', -diff);
  e.doc = {
    id: input.docId || '', date: input.date, store: input.store || '', expectedCashPaisa: expected, countedCashPaisa: counted,
    diffPaisa: diff, expectedCardPaisa: input.expectedCardPaisa || 0, notes: input.notes || '',
  };
  return finish(e, ctx);
}

// ---------- R17. MTO order cancellation ----------

function cancelJob(input, ctx) {
  const job = getJob(ctx, input.jobId);
  if (job.status === 'DELIVERED' || job.status === 'CANCELLED' || job.status === 'COMPLETED') {
    fail('E_JOB_CLOSED', 'Job ' + job.id + ' is ' + String(job.status).toLowerCase(), 'jobId');
  }
  const treatment = input.wipTreatment || 'WRITE_OFF';
  if (treatment !== 'RETURN' && treatment !== 'WRITE_OFF') fail('E_VALIDATION', 'Choose RETURN or WRITE_OFF for work in progress', 'wipTreatment');
  const held = Math.max(0, (ctx.jobAdvances || {})[job.id] || 0);
  const refund = nonNegativePaisa(input.refundPaisa || 0, 'refundPaisa');
  if (refund > held) fail('E_OVERPAY', 'Only ' + Money.formatPaisa(held) + ' is held as advance', 'refundPaisa');
  const e = start(input, ctx, 'JOB_CANCELLATION', job.id);
  const ledger = ledgerFor(ctx);
  const refs = { contactId: job.contactId || '', jobId: job.id };

  if (held > 0) {
    dr(e, sysCode(ctx, 'CUSTOMER_ADV'), job.brand, held, refs);
    if (refund > 0) cr(e, moneyCode(ctx, input.moneyAccountCode), job.brand, refund, refs);
    cr(e, sysCode(ctx, 'CANCEL_INCOME'), job.brand, held - refund, refs);
  }

  const wip = Object.assign({}, (ctx.jobWip || {})[job.id] || {});
  let returned = 0;
  if (treatment === 'RETURN') {
    (ctx.stockMoves || []).filter(function (m) { return m.moveType === 'ISSUE' && m.jobId === job.id; }).forEach(function (issue) {
      const left = returnableFromIssue(ctx, issue);
      if (left.qtyMilli <= 0) return;
      const r = postReturnFromIssue(e, ctx, ledger, job, issue, Inventory.fromMilli(left.qtyMilli));
      wip[r.component] = (wip[r.component] || 0) - r.value;
      returned += r.value;
    });
  }
  let writtenOff = 0;
  Object.keys(wip).sort().forEach(function (component) {
    const c = wip[component];
    post(e, cogsCode(ctx, 'OTHER'), job.brand, c, { jobId: job.id, costComponent: component || 'OTHER' });
    post(e, sysCode(ctx, 'WIP'), job.brand, -c, { jobId: job.id, costComponent: component });
    writtenOff += c;
  });
  e.doc = {
    jobId: job.id, advancePaisa: held, refundPaisa: refund, forfeitedPaisa: held - refund,
    returnedToStockPaisa: returned, writtenOffPaisa: writtenOff, wipTreatment: treatment,
  };
  e.docUpdates.push({ docType: 'JOB', id: job.id, fields: { status: 'CANCELLED' } });
  return finish(e, ctx, ledger);
}

// ---------- R20, R21. Tax settlements ----------

function settleSalesTax(input, ctx) {
  const out = nonNegativePaisa(input.outputPaisa, 'outputPaisa');
  const inp = nonNegativePaisa(input.inputPaisa, 'inputPaisa');
  const bank = moneyCode(ctx, input.bankCode, 'bankCode');
  const e = start(input, ctx, 'PAYMENT', input.docId);
  dr(e, sysCode(ctx, 'OUTPUT_TAX'), 'SHARED', out);
  cr(e, sysCode(ctx, 'INPUT_TAX'), 'SHARED', inp);
  post(e, bank, 'SHARED', -(out - inp));
  e.doc = {
    id: input.docId || '', date: input.date, direction: 'OUT', kind: 'TAX_PAYMENT', moneyAccountCode: bank,
    amountPaisa: out - inp, outputPaisa: out, inputPaisa: inp, reference: input.reference || '', allocations: [],
  };
  return finish(e, ctx);
}

function depositWht(input, ctx) {
  const amount = positivePaisa(input.amountPaisa, 'amountPaisa');
  const bank = moneyCode(ctx, input.bankCode, 'bankCode');
  const e = start(input, ctx, 'PAYMENT', input.docId);
  dr(e, sysCode(ctx, 'WHT_PAYABLE'), 'SHARED', amount);
  cr(e, bank, 'SHARED', amount);
  e.doc = {
    id: input.docId || '', date: input.date, direction: 'OUT', kind: 'TAX_PAYMENT', moneyAccountCode: bank,
    amountPaisa: amount, reference: input.reference || '', allocations: [],
  };
  return finish(e, ctx);
}

// ---------- R22. Reversal ----------

function reverseEntry(input, ctx) {
  const orig = lookup(ctx.journals, input.jeId, 'Journal entry', 'jeId');
  const j = orig.journal;
  if (!isBlank(j.reversesJeId)) fail('E_VALIDATION', input.jeId + ' is itself a reversal and cannot be reversed', 'jeId');
  if (!isBlank(j.reversedByJeId)) fail('E_VALIDATION', input.jeId + ' has already been reversed by ' + j.reversedByJeId, 'jeId');
  if (isBlank(input.reason)) fail('E_VALIDATION', 'Give a reason for the reversal', 'reason');
  if (j.docType === 'BILL' && ctx.bills && ctx.bills[j.docId] && ctx.bills[j.docId].paidPaisa > 0) {
    fail('E_VALIDATION', 'Bill ' + j.docId + ' has payments. Reverse the payments first.', 'jeId');
  }
  if (j.docType === 'INVOICE' && ctx.invoices && ctx.invoices[j.docId] && ctx.invoices[j.docId].paidPaisa > 0) {
    fail('E_VALIDATION', 'Invoice ' + j.docId + ' has payments. Reverse the payments first.', 'jeId');
  }
  const e = start(input, ctx, j.docType, j.docId, 'Reversal of ' + input.jeId + ': ' + input.reason);
  e.journal.reversesJeId = input.jeId;
  e.journal.isManual = !!j.isManual;
  e.journal.isClosing = !!j.isClosing;
  orig.lines.forEach(function (l) {
    post(e, l.accountCode, l.brand, (l.creditPaisa || 0) - (l.debitPaisa || 0), {
      contactId: l.contactId, jobId: l.jobId, itemId: l.itemId, costComponent: l.costComponent,
      qty: typeof l.qty === 'number' ? -l.qty : l.qty, currency: l.currency, fxAmount: l.fxAmount, fxRate: l.fxRate,
      lateCost: isTrue(l.lateCost), memo: l.memo,
    });
  });

  // Stock comes back at its original cost; averages are recomputed.
  const ledger = ledgerFor(ctx);
  (orig.stockMoves || []).slice().reverse().forEach(function (m) {
    const qm = Inventory.toMilli(m.qty);
    if (qm > 0) {
      const r = ledger.removeAtCost(m.itemId, m.qty, m.valuePaisa);
      addMove(e, r.move, { jobId: m.jobId || '', sourceMoveId: m.id || '' });
      if (r.residualPaisa !== 0) {
        // Stock emptied but some value was left over: clear it to shrinkage.
        const item = getItem(ctx, m.itemId);
        addMove(e, r.residualMove, { sourceMoveId: m.id || '' });
        post(e, sysCode(ctx, 'SHRINKAGE'), Inventory.itemBrand(item), r.residualPaisa, { itemId: m.itemId, memo: 'Cost difference on reversal' });
        post(e, sysCode(ctx, Inventory.ACCOUNT_KEY_BY_CATEGORY[item.category]), Inventory.itemBrand(item), -r.residualPaisa, { itemId: m.itemId, qty: 0, memo: 'Cost difference on reversal' });
      }
    } else if (qm < 0) {
      const move = ledger.receive(m.itemId, Inventory.fromMilli(-qm), -m.valuePaisa, 'REVERSAL');
      addMove(e, move, { jobId: m.jobId || '', sourceMoveId: m.id || '' });
    } else if (m.valuePaisa !== 0) {
      fail('E_VALIDATION', 'Entry ' + input.jeId + ' contains a cost adjustment that cannot be reversed', 'jeId');
    }
  });

  e.docUpdates.push({ docType: 'JOURNAL', id: input.jeId, fields: { reversedByJeId: NEW_JE_ID } });
  if (['PAYMENT', 'BILL', 'EXPENSE', 'INVOICE', 'SALE', 'STOCK_COUNT', 'CASHUP'].indexOf(j.docType) >= 0 && !isBlank(j.docId)) {
    e.docUpdates.push({ docType: j.docType, id: j.docId, fields: { status: 'VOID' } });
  }
  // Payments posted by this entry are void, and what they paid off bills and
  // invoices is owed again. ctx.paymentsByJe: {jeId: [{payment, allocations}]}.
  ((ctx.paymentsByJe || {})[input.jeId] || []).forEach(function (pa) {
    if (!(j.docType === 'PAYMENT' && pa.payment.id === j.docId)) {
      e.docUpdates.push({ docType: 'PAYMENT', id: pa.payment.id, fields: { status: 'VOID' } });
    }
    (pa.allocations || []).forEach(function (a) {
      if (a.docType === 'BILL') {
        const bill = lookup(ctx.bills, a.docId, 'Bill', 'jeId');
        if (bill.id === j.docId) return; // the bill itself is being voided (expense)
        e.docUpdates.push({ docType: 'BILL', id: bill.id, fields: {
          paidPaisa: (bill.paidPaisa || 0) - a.amountPaisa, whtPaisa: (bill.whtPaisa || 0) - (a.whtPaisa || 0), balancePaisa: (bill.balancePaisa || 0) + a.amountPaisa,
        } });
      } else if (a.docType === 'INVOICE') {
        const inv = lookup(ctx.invoices, a.docId, 'Invoice', 'jeId');
        e.docUpdates.push({ docType: 'INVOICE', id: inv.id, fields: { paidPaisa: (inv.paidPaisa || 0) - a.amountPaisa, balancePaisa: (inv.balancePaisa || 0) + a.amountPaisa } });
      }
    });
  });
  if (j.docType === 'INVOICE' && orig.lines.length && orig.lines[0].jobId) {
    e.docUpdates.push({ docType: 'JOB', id: orig.lines[0].jobId, fields: { status: 'READY', deliveredDate: '', invoiceId: '' } });
  }
  if (j.docType === 'BATCH_COMPLETION' || j.docType === 'JOB_CANCELLATION') {
    e.docUpdates.push({ docType: 'JOB', id: j.docId, fields: { status: 'OPEN' } });
  }
  e.doc = { reversesJeId: input.jeId, reason: input.reason };
  return finish(e, ctx, ledger);
}

// ---------- R23. Year-end close ----------

// The first day of the fiscal year that ends on `date` (which must be its last day).
function fiscalYearStartFor(date, startMonth) {
  Validate.checkDate(date);
  const m = Number(startMonth || 7);
  const y = Number(date.slice(0, 4));
  const next = new Date(Date.UTC(y, Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1));
  if (next.getUTCMonth() + 1 !== m || next.getUTCDate() !== 1) {
    fail('E_VALIDATION', date + ' is not the last day of a fiscal year', 'date');
  }
  const startYear = next.getUTCFullYear() - 1;
  return startYear + '-' + String(m).padStart(2, '0') + '-01';
}

// input: {date: last day of the fiscal year, lines: every JournalLine up to that date}.
function closeYear(input, ctx) {
  const from = fiscalYearStartFor(input.date, (ctx.settings || {}).fiscalYearStartMonth);
  const balances = {};
  (input.lines || []).forEach(function (l) {
    if (l.date < from || l.date > input.date) return;
    const a = ctx.accountsByCode[l.accountCode];
    if (!a || Validate.PNL_TYPES.indexOf(a.type) === -1) return;
    addTo(balances, a.code + '|' + l.brand, Validate.lineAmount(l));
  });
  const e = start(input, ctx, 'CLOSING', 'FY-' + input.date.slice(0, 4), 'Year-end close to ' + input.date);
  e.journal.isClosing = true;
  let net = 0;
  Object.keys(balances).sort().forEach(function (k) {
    const parts = k.split('|');
    post(e, parts[0], parts[1], -balances[k], { memo: 'Year-end close' });
    net += balances[k];
  });
  if (!e.lines.length) fail('E_VALIDATION', 'Nothing to close: the profit and loss accounts are already at zero', 'date');
  post(e, sysCode(ctx, 'RETAINED_EARNINGS'), 'SHARED', net, { memo: 'Year-end close' });
  e.doc = { fiscalYearStart: from, fiscalYearEnd: input.date, netProfitPaisa: -net };
  return finish(e, ctx);
}

// ---------- Manual journal and opening stock ----------

// Finance/Owner only (role checked by the server). Stock accounts are off
// limits: stock moves only through documents so the GL always equals stock.
function manualJournal(input, ctx) {
  if (!Array.isArray(input.lines) || input.lines.length < 2) fail('E_VALIDATION', 'A journal needs at least two lines', 'lines');
  if (isBlank(input.memo)) fail('E_VALIDATION', 'Say what this journal is for', 'memo');
  const e = start(input, ctx, input.docType === 'OPENING' ? 'OPENING' : 'MANUAL', input.docId || '', input.memo);
  e.journal.isManual = true;
  input.lines.forEach(function (l, i) {
    const field = 'lines[' + i + ']';
    const a = getAccount(ctx, l.accountCode, field + '.accountCode');
    if (Validate.INVENTORY_KEYS.indexOf(a.systemKey) >= 0) {
      fail('E_VALIDATION', a.name + ' changes only through stock documents (purchases, issues, counts)', field + '.accountCode');
    }
    const d = nonNegativePaisa(l.debitPaisa || 0, field + '.debitPaisa');
    const c = nonNegativePaisa(l.creditPaisa || 0, field + '.creditPaisa');
    if ((d > 0) === (c > 0)) fail('E_NEG_AMOUNT', 'Line ' + (i + 1) + ' needs either a debit or a credit', field);
    post(e, a.code, l.brand, d - c, { contactId: l.contactId, jobId: l.jobId, costComponent: l.costComponent, memo: l.memo });
  });
  e.doc = { memo: input.memo };
  return finish(e, ctx);
}

// Opening stock at go-live: Dr inventory / Cr retained earnings.
// TODO(decision-D-01): opening balances; the opening TB journal must leave stock out.
function openingStock(input, ctx) {
  if (!Array.isArray(input.lines) || !input.lines.length) fail('E_VALIDATION', 'Enter at least one item', 'lines');
  const e = start(input, ctx, 'OPENING', input.docId || 'OPENING-STOCK', 'Opening stock');
  const ledger = ledgerFor(ctx);
  let total = 0;
  input.lines.forEach(function (l, i) {
    const item = getItem(ctx, l.itemId);
    const value = nonNegativePaisa(l.valuePaisa, 'lines[' + i + '].valuePaisa');
    const move = ledger.receive(item.id, l.qty, value, 'OPENING');
    addMove(e, move);
    dr(e, sysCode(ctx, Inventory.ACCOUNT_KEY_BY_CATEGORY[item.category]), Inventory.itemBrand(item), value, { itemId: item.id, qty: move.qty });
    total += value;
  });
  cr(e, sysCode(ctx, 'RETAINED_EARNINGS'), 'SHARED', total, { memo: 'Opening stock' });
  e.doc = { lines: input.lines };
  return finish(e, ctx, ledger);
}

if (typeof module !== 'undefined') module.exports = {
  NEW_JE_ID,
  findTaxCode,
  whtOnBillPayment,
  exclusiveTax,
  inclusiveTax,
  splitByBrand,
  fiscalYearStartFor,
  receiveAdvance,
  createBill,
  karigarWork,
  payBills,
  payVendorAdvance,
  createExpense,
  recordDrawings,
  issueStock,
  returnStock,
  deliverJob,
  receivePayment,
  completeBatch,
  createSale,
  returnSale,
  exchangeSale,
  settleCards,
  transfer,
  postStockCount,
  cashUp,
  cancelJob,
  settleSalesTax,
  depositWht,
  reverseEntry,
  closeYear,
  manualJournal,
  openingStock,
};
