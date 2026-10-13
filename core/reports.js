// core/reports.js: reports as pure functions over arrays of JournalLines and
// StockMoves. Balances are always derived from the lines, never stored.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.
//
// `acc` below is the account index from Validate.indexAccounts():
//   {accountsByCode, accountsBySystemKey}
// Lines need: date, accountCode, brand, debitPaisa, creditPaisa and, where
// relevant, contactId, jobId, itemId, costComponent. The server joins
// Journal.isClosing onto each line as `isClosing` so the P&L can leave
// year-end closing entries out.

const Money = require('./money.js');
const Validate = require('./validate.js');
const Inventory = require('./inventory.js');

const BRANDS = Validate.BRANDS;
const COLUMNS = ['UMSHA', 'MIRAE', 'SHARED', 'TOTAL'];

function net(line) {
  return (line.debitPaisa || 0) - (line.creditPaisa || 0);
}

function inRange(date, opts) {
  return (!opts.from || date >= opts.from) && (!opts.to || date <= opts.to) && (!opts.asOf || date <= opts.asOf);
}

function codeFor(acc, key) {
  const a = acc.accountsBySystemKey[key];
  return a ? a.code : null;
}

function emptyColumns() {
  return { UMSHA: 0, MIRAE: 0, SHARED: 0, TOTAL: 0 };
}

function byAccountCode(a, b) {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

// Net debit-minus-credit per account (and optionally per brand).
function accountBalances(lines, opts) {
  const o = opts || {};
  const out = {};
  lines.forEach(function (l) {
    if (!inRange(l.date, o)) return;
    if (o.excludeClosing && Validate.isTrue(l.isClosing)) return;
    const key = o.byBrand ? l.accountCode + '|' + l.brand : l.accountCode;
    out[key] = (out[key] || 0) + net(l);
  });
  return out;
}

// ---------- Trial balance ----------

function trialBalance(lines, acc, opts) {
  const bal = accountBalances(lines, { asOf: (opts || {}).asOf });
  const rows = Object.keys(bal).filter(function (c) { return bal[c] !== 0; }).map(function (code) {
    const a = acc.accountsByCode[code] || { code: code, name: '(unknown account)', type: '' };
    const n = bal[code];
    return { code: code, name: a.name, type: a.type, debitPaisa: n > 0 ? n : 0, creditPaisa: n < 0 ? -n : 0 };
  }).sort(byAccountCode);
  const totalDebitPaisa = rows.reduce(function (s, r) { return s + r.debitPaisa; }, 0);
  const totalCreditPaisa = rows.reduce(function (s, r) { return s + r.creditPaisa; }, 0);
  return { rows: rows, totalDebitPaisa: totalDebitPaisa, totalCreditPaisa: totalCreditPaisa, balanced: totalDebitPaisa === totalCreditPaisa };
}

// ---------- Profit and loss by brand ----------

const PNL_SECTIONS = [
  { key: 'revenue', types: ['REVENUE'], sign: -1 },
  { key: 'cogs', types: ['COGS'], sign: 1 },
  { key: 'expenses', types: ['EXPENSE'], sign: 1 },
  { key: 'other', types: ['OTHER'], sign: -1 }, // other income positive
  { key: 'tax', types: ['TAX'], sign: 1 },
];

// opts: {from, to, allocate: 'NONE'|'REVENUE'|'FIXED', umshaPctBps}
// Allocation is presentation only: each SHARED line is split between UMSHA
// and MIRAE (residual to MIRAE) and the SHARED column becomes zero.
// TODO(decision-D-07): default allocation key is REVENUE.
function profitAndLoss(lines, acc, opts) {
  const o = opts || {};
  const bal = accountBalances(lines, { from: o.from, to: o.to, byBrand: true, excludeClosing: true });
  const sections = {};
  PNL_SECTIONS.forEach(function (s) { sections[s.key] = { rows: [], total: emptyColumns() }; });
  const rowsByCode = {};
  Object.keys(bal).forEach(function (k) {
    const parts = k.split('|');
    const a = acc.accountsByCode[parts[0]];
    if (!a) return;
    const section = PNL_SECTIONS.filter(function (s) { return s.types.indexOf(a.type) >= 0; })[0];
    if (!section) return;
    if (!rowsByCode[a.code]) {
      rowsByCode[a.code] = { code: a.code, name: a.name, type: a.type, section: section.key, amounts: emptyColumns() };
    }
    rowsByCode[a.code].amounts[parts[1]] += section.sign * bal[k];
  });

  const warnings = [];
  const allocate = o.allocate || 'NONE';
  let weights = null;
  if (allocate === 'REVENUE') {
    const rev = { UMSHA: 0, MIRAE: 0 };
    Object.keys(rowsByCode).forEach(function (c) {
      const r = rowsByCode[c];
      if (r.section === 'revenue') { rev.UMSHA += r.amounts.UMSHA; rev.MIRAE += r.amounts.MIRAE; }
    });
    weights = [Math.max(0, rev.UMSHA), Math.max(0, rev.MIRAE)];
    if (weights[0] + weights[1] === 0) {
      weights = null;
      warnings.push('No brand revenue in the period, so shared costs are not allocated');
    }
  } else if (allocate === 'FIXED') {
    const pct = Number(o.umshaPctBps);
    if (!Number.isInteger(pct) || pct < 0 || pct > 10000) Validate.fail('E_VALIDATION', 'UMSHA share must be 0 to 10000 basis points', 'umshaPctBps');
    weights = [pct, 10000 - pct];
  } else if (allocate !== 'NONE') {
    Validate.fail('E_VALIDATION', 'Allocation must be NONE, REVENUE or FIXED', 'allocate');
  }

  Object.keys(rowsByCode).sort().forEach(function (code) {
    const r = rowsByCode[code];
    if (weights && r.amounts.SHARED !== 0) {
      const split = Money.splitProRata(r.amounts.SHARED, weights);
      r.amounts.UMSHA += split[0];
      r.amounts.MIRAE += split[1];
      r.amounts.SHARED = 0;
    }
    r.amounts.TOTAL = r.amounts.UMSHA + r.amounts.MIRAE + r.amounts.SHARED;
    if (BRANDS.every(function (b) { return r.amounts[b] === 0; })) return;
    sections[r.section].rows.push(r);
    COLUMNS.forEach(function (c) { sections[r.section].total[c] += r.amounts[c]; });
  });

  const summary = {};
  ['netRevenue', 'grossProfit', 'operatingProfit', 'profitBeforeTax', 'netProfit', 'grossMarginBps'].forEach(function (k) { summary[k] = {}; });
  COLUMNS.forEach(function (c) {
    const rev = sections.revenue.total[c];
    const gp = rev - sections.cogs.total[c];
    const op = gp - sections.expenses.total[c];
    const pbt = op + sections.other.total[c];
    summary.netRevenue[c] = rev;
    summary.grossProfit[c] = gp;
    summary.operatingProfit[c] = op;
    summary.profitBeforeTax[c] = pbt;
    summary.netProfit[c] = pbt - sections.tax.total[c];
    summary.grossMarginBps[c] = rev > 0 ? Money.divRoundHalfEven(BigInt(gp) * BigInt(10000), rev) : null;
  });
  return { from: o.from || '', to: o.to || '', allocate: allocate, sections: sections, summary: summary, warnings: warnings };
}

// ---------- Balance sheet ----------

function balanceSheet(lines, acc, opts) {
  const bal = accountBalances(lines, { asOf: (opts || {}).asOf });
  const out = { assets: [], liabilities: [], equity: [], totals: { assets: 0, liabilities: 0, equity: 0 } };
  let earnings = 0;
  Object.keys(bal).sort().forEach(function (code) {
    const a = acc.accountsByCode[code];
    if (!a) return;
    const n = bal[code];
    if (Validate.PNL_TYPES.indexOf(a.type) >= 0) { earnings -= n; return; }
    if (n === 0) return;
    if (a.type === 'ASSET') { out.assets.push({ code: code, name: a.name, amountPaisa: n }); out.totals.assets += n; }
    if (a.type === 'LIABILITY') { out.liabilities.push({ code: code, name: a.name, amountPaisa: -n }); out.totals.liabilities -= n; }
    if (a.type === 'EQUITY') { out.equity.push({ code: code, name: a.name, amountPaisa: -n }); out.totals.equity -= n; }
  });
  if (earnings !== 0) {
    out.equity.push({ code: '', name: 'Profit not yet closed to retained earnings', amountPaisa: earnings });
    out.totals.equity += earnings;
  }
  out.balanced = out.totals.assets === out.totals.liabilities + out.totals.equity;
  return out;
}

// ---------- Account ledger ----------

// Every line on one account in [from, to] with a running balance, in the
// account's natural sign (debit-normal accounts count debits up).
// opts: {accountCode, from, to, brand}
function accountLedger(lines, acc, opts) {
  const o = opts || {};
  const a = acc.accountsByCode[String(o.accountCode)];
  if (!a) Validate.fail('E_NOT_FOUND', 'Account ' + o.accountCode + ' not found', 'accountCode');
  const sign = a.normalBalance === 'CREDIT' ? -1 : 1;
  let opening = 0;
  const rows = [];
  lines.forEach(function (l) {
    if (l.accountCode !== a.code || (o.brand && l.brand !== o.brand)) return;
    if (o.from && l.date < o.from) { opening += sign * net(l); return; }
    if (o.to && l.date > o.to) return;
    rows.push(l);
  });
  rows.sort(function (x, y) {
    if (x.date !== y.date) return x.date < y.date ? -1 : 1;
    return String(x.id || '') < String(y.id || '') ? -1 : String(x.id || '') > String(y.id || '') ? 1 : 0;
  });
  let balance = opening;
  const out = rows.map(function (l) {
    balance += sign * net(l);
    return Object.assign({}, l, { balancePaisa: balance });
  });
  return { account: { code: a.code, name: a.name, type: a.type, normalBalance: a.normalBalance }, from: o.from || '', to: o.to || '', openingPaisa: opening, rows: out, closingPaisa: balance };
}

// ---------- Sub-ledgers ----------

function sumBy(lines, accountCode, keyField, sign, opts) {
  const out = {};
  if (!accountCode) return out;
  lines.forEach(function (l) {
    if (l.accountCode !== accountCode || !inRange(l.date, opts || {})) return;
    const k = l[keyField] || '';
    out[k] = (out[k] || 0) + sign * net(l);
  });
  Object.keys(out).forEach(function (k) { if (out[k] === 0) delete out[k]; });
  return out;
}

// {contactId: {owesPaisa, advanceHeldPaisa}}
function customerBalances(lines, acc, opts) {
  const owes = sumBy(lines, codeFor(acc, 'AR'), 'contactId', 1, opts);
  const adv = sumBy(lines, codeFor(acc, 'CUSTOMER_ADV'), 'contactId', -1, opts);
  const out = {};
  Object.keys(owes).concat(Object.keys(adv)).forEach(function (c) {
    out[c] = { owesPaisa: owes[c] || 0, advanceHeldPaisa: adv[c] || 0 };
  });
  return out;
}

// {contactId: paisa we owe}
function vendorBalances(lines, acc, opts) {
  return sumBy(lines, codeFor(acc, 'AP'), 'contactId', -1, opts);
}

// {jobId: paisa of customer advance held}
function jobAdvances(lines, acc, opts) {
  return sumBy(lines, codeFor(acc, 'CUSTOMER_ADV'), 'jobId', -1, opts);
}

// {jobId: {costComponent: paisa}} of WIP still on each job.
function jobWip(lines, acc, opts) {
  const wip = codeFor(acc, 'WIP');
  const out = {};
  lines.forEach(function (l) {
    if (l.accountCode !== wip || !inRange(l.date, opts || {})) return;
    if (!out[l.jobId]) out[l.jobId] = {};
    const c = l.costComponent || '';
    out[l.jobId][c] = (out[l.jobId][c] || 0) + net(l);
  });
  Object.keys(out).forEach(function (j) {
    Object.keys(out[j]).forEach(function (c) { if (out[j][c] === 0) delete out[j][c]; });
    if (!Object.keys(out[j]).length) delete out[j];
  });
  return out;
}

// ---------- Jobs ----------

// Cost of one job: still in WIP and released to COGS, by component, plus
// what a batch moved into finished-goods stock.
function jobCostSheet(lines, acc, jobId) {
  const wipCode = codeFor(acc, 'WIP');
  const fgCode = codeFor(acc, 'INV_FG');
  const byComponent = {};
  let inWip = 0;
  let released = 0;
  let movedToStock = 0;
  lines.forEach(function (l) {
    if (l.jobId !== jobId) return;
    const a = acc.accountsByCode[l.accountCode];
    if (!a) return;
    const n = net(l);
    if (l.accountCode === wipCode) inWip += n;
    else if (a.type === 'COGS') released += n;
    else if (l.accountCode === fgCode) { movedToStock += n; return; } else return;
    const c = l.costComponent || 'OTHER';
    byComponent[c] = (byComponent[c] || 0) + n;
  });
  Object.keys(byComponent).forEach(function (c) { if (byComponent[c] === 0) delete byComponent[c]; });
  return { jobId: jobId, byComponent: byComponent, inWipPaisa: inWip, releasedPaisa: released, movedToStockPaisa: movedToStock, totalPaisa: inWip + released + movedToStock };
}

// Delivered MTO jobs in [from, to]: revenue, cost (including late costs), margin.
// jobs: {jobId: Jobs row}
function jobProfitability(lines, acc, jobs, opts) {
  const o = opts || {};
  const perJob = {};
  lines.forEach(function (l) {
    if (!l.jobId || Validate.isTrue(l.isClosing)) return;
    const a = acc.accountsByCode[l.accountCode];
    if (!a) return;
    if (!perJob[l.jobId]) perJob[l.jobId] = { revenue: 0, cost: 0 };
    if (a.type === 'REVENUE' && a.systemKey !== 'CANCEL_INCOME') perJob[l.jobId].revenue -= net(l);
    if (a.type === 'COGS') perJob[l.jobId].cost += net(l);
  });
  return Object.keys(jobs).sort().map(function (id) { return jobs[id]; }).filter(function (j) {
    return j.type === 'MTO_ORDER' && j.status === 'DELIVERED' && inRange(j.deliveredDate, { from: o.from, to: o.to });
  }).map(function (j) {
    const p = perJob[j.id] || { revenue: 0, cost: 0 };
    const margin = p.revenue - p.cost;
    return {
      jobId: j.id, contactId: j.contactId || '', title: j.title || '', deliveredDate: j.deliveredDate,
      revenuePaisa: p.revenue, costPaisa: p.cost, marginPaisa: margin,
      marginBps: p.revenue > 0 ? Money.divRoundHalfEven(BigInt(margin) * BigInt(10000), p.revenue) : null,
    };
  });
}

// ---------- Stock valuation ----------

// stockMoves in posting order; items: {itemId: Items row}.
function stockValuation(stockMoves, items, opts) {
  const moves = stockMoves.filter(function (m) { return inRange(m.date, opts || {}); });
  const balances = Inventory.rebuildItemBalances(moves);
  const byAccountKey = {};
  let total = 0;
  const rows = Object.keys(balances).sort().map(function (id) {
    const b = balances[id];
    const item = items[id] || {};
    const key = Inventory.ACCOUNT_KEY_BY_CATEGORY[item.category] || '';
    byAccountKey[key] = (byAccountKey[key] || 0) + b.valuePaisa;
    total += b.valuePaisa;
    return { itemId: id, name: item.name || '', category: item.category || '', qty: b.qty, avgCostMicro: b.avgCostMicro, valuePaisa: b.valuePaisa };
  });
  return { rows: rows, byAccountKey: byAccountKey, totalPaisa: total };
}

// Inventory GL against the stock valuation, account by account (M5.7).
// Returns {asOf, rows: [{systemKey, code, name, glPaisa, stockPaisa, differencePaisa}], reconciled}.
function inventoryReconciliation(lines, stockMoves, acc, items, opts) {
  const o = opts || {};
  const bal = accountBalances(lines, { asOf: o.asOf });
  const val = stockValuation(stockMoves, items, { asOf: o.asOf });
  const rows = Validate.INVENTORY_KEYS.map(function (k) {
    const a = acc.accountsBySystemKey[k];
    const gl = a ? bal[a.code] || 0 : 0;
    const stock = val.byAccountKey[k] || 0;
    return { systemKey: k, code: a ? a.code : '', name: a ? a.name : k, glPaisa: gl, stockPaisa: stock, differencePaisa: gl - stock };
  });
  return { asOf: o.asOf || '', rows: rows, items: val.rows, reconciled: rows.every(function (r) { return r.differencePaisa === 0; }) };
}

// ---------- Mirae SKU and collection margin (M8.5) ----------

// sales: Sales rows; saleLines: SaleLines rows (returns negative);
// items: {itemId: Items row}. opts: {from, to, collection}.
function skuMargin(sales, saleLines, items, opts) {
  const o = opts || {};
  const inRangeSale = {};
  sales.forEach(function (x) { if (x.status !== 'VOID' && inRange(x.date, o)) inRangeSale[x.id] = x; });
  const bySku = {};
  saleLines.forEach(function (l) {
    if (!inRangeSale[l.saleId]) return;
    const it = items[l.itemId] || {};
    if (o.collection && it.collection !== o.collection) return;
    const r = bySku[l.itemId] || (bySku[l.itemId] = { itemId: l.itemId, name: it.name || l.itemId, collection: it.collection || '', unitsMilli: 0, netPaisa: 0, costPaisa: 0 });
    r.unitsMilli += Inventory.toMilli(l.qty);
    r.netPaisa += l.netPaisa || 0;
    r.costPaisa += l.costPaisa || 0;
  });
  const rows = Object.keys(bySku).sort().map(function (k) {
    const r = bySku[k];
    const margin = r.netPaisa - r.costPaisa;
    return { itemId: r.itemId, name: r.name, collection: r.collection, units: Inventory.fromMilli(r.unitsMilli), netPaisa: r.netPaisa, costPaisa: r.costPaisa, marginPaisa: margin,
      marginBps: r.netPaisa > 0 ? Money.divRoundHalfEven(BigInt(margin) * BigInt(10000), r.netPaisa) : null };
  });
  const byCollection = {};
  rows.forEach(function (r) {
    const c = byCollection[r.collection] || (byCollection[r.collection] = { collection: r.collection, netPaisa: 0, costPaisa: 0 });
    c.netPaisa += r.netPaisa; c.costPaisa += r.costPaisa;
  });
  return {
    rows: rows,
    collections: Object.keys(byCollection).sort().map(function (k) {
      const c = byCollection[k];
      const m = c.netPaisa - c.costPaisa;
      return { collection: c.collection, netPaisa: c.netPaisa, costPaisa: c.costPaisa, marginPaisa: m, marginBps: c.netPaisa > 0 ? Money.divRoundHalfEven(BigInt(m) * BigInt(10000), c.netPaisa) : null };
    }),
  };
}

// ---------- Cash position (M8.6) ----------

// Money account balances, advances held, and what is due in/out within `days`.
// invoices / bills: open documents with dueDate and balancePaisa.
function cashPosition(lines, acc, invoices, bills, opts) {
  const o = opts || {};
  const asOf = Validate.checkDate(o.asOf, 'asOf');
  const horizon = (function () {
    const d = new Date(Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 1, Number(asOf.slice(8, 10)) + (o.days || 7)));
    return d.toISOString().slice(0, 10);
  })();
  const bal = accountBalances(lines, { asOf: asOf });
  const accounts = Object.keys(acc.accountsByCode).map(function (c) { return acc.accountsByCode[c]; })
    .filter(function (a) { return a.isMoney && a.systemKey !== 'STORE_CREDIT' && a.isActive; })
    .map(function (a) { return { code: a.code, name: a.name, moneyKind: a.moneyKind, balancePaisa: bal[a.code] || 0 }; });
  function due(docs) {
    const open = docs.filter(function (d) { return d.status !== 'VOID' && d.balancePaisa > 0 && d.date <= asOf; });
    return {
      overduePaisa: open.filter(function (d) { return (d.dueDate || d.date) < asOf; }).reduce(function (t, d) { return t + d.balancePaisa; }, 0),
      dueSoonPaisa: open.filter(function (d) { const dd = d.dueDate || d.date; return dd >= asOf && dd <= horizon; }).reduce(function (t, d) { return t + d.balancePaisa; }, 0),
      totalPaisa: open.reduce(function (t, d) { return t + d.balancePaisa; }, 0),
    };
  }
  const advCode = codeFor(acc, 'CUSTOMER_ADV');
  return {
    asOf: asOf, until: horizon, accounts: accounts,
    cashPaisa: accounts.reduce(function (t, a) { return t + a.balancePaisa; }, 0),
    advancesHeldPaisa: advCode && bal[advCode] ? -bal[advCode] : 0,
    receivable: due(invoices), payable: due(bills),
  };
}

// ---------- Tax (M7.3, M7.4) ----------

// Sales tax for a period from the ledger: output tax charged, input tax
// claimed, net payable. Entries in excludeJeIds (the settlements themselves)
// are left out so a settled period still shows what arose in it.
function salesTaxSummary(lines, acc, opts) {
  const o = opts || {};
  const out = codeFor(acc, 'OUTPUT_TAX');
  const inp = codeFor(acc, 'INPUT_TAX');
  const skip = o.excludeJeIds || {};
  let output = 0;
  let input = 0;
  const byBrand = {};
  lines.forEach(function (l) {
    if (!inRange(l.date, o) || skip[l.jeId]) return;
    if (l.accountCode === out) { output -= net(l); byBrand[l.brand] = (byBrand[l.brand] || 0) - net(l); }
    if (l.accountCode === inp) input += net(l);
  });
  return { from: o.from || '', to: o.to || '', outputPaisa: output, inputPaisa: input, netPayablePaisa: output - input, outputByBrand: byBrand };
}

// Withholding tax deducted, payment by payment, for the accountant's filing.
// payments: Payments rows; allocations: PaymentAllocations rows; contacts: {id: row}.
function whtRegister(payments, allocations, contacts, opts) {
  const o = opts || {};
  const byPayment = {};
  allocations.forEach(function (a) { (byPayment[a.paymentId] = byPayment[a.paymentId] || []).push(a); });
  const rows = [];
  payments.forEach(function (p) {
    if (p.status === 'VOID' || !p.whtPaisa || !inRange(p.date, o)) return;
    const v = contacts[p.contactId] || {};
    const settled = (byPayment[p.id] || []).reduce(function (t, a) { return t + (a.amountPaisa || 0); }, 0);
    rows.push({ date: p.date, paymentId: p.id, contactId: p.contactId, vendor: v.name || '', cnic: v.cnic || '', ntn: v.ntn || '', filerStatus: v.filerStatus || '',
      whtTaxCodeId: p.whtTaxCodeId || '', grossPaisa: settled || p.amountPaisa + p.whtPaisa, whtPaisa: p.whtPaisa, netPaidPaisa: p.amountPaisa });
  });
  rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.paymentId < b.paymentId ? -1 : 1); });
  return { rows: rows, totalWhtPaisa: rows.reduce(function (t, r) { return t + r.whtPaisa; }, 0) };
}

// ---------- Month close (M9.1) ----------

// What should be true before a month is locked. Each check is
// {key, label, ok, blocking, detail}. Blocking checks must pass; the others
// are warnings the Owner can acknowledge.
// data: {lines, stockMoves, acc, items, sales, cashUps, stockCounts, periods, bankRecs}
function closeChecklist(periodId, data) {
  const m = /^(\d{4})-(\d{2})$/.exec(periodId);
  if (!m) Validate.fail('E_VALIDATION', 'Period must be YYYY-MM', 'periodId');
  const from = periodId + '-01';
  const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10);
  const checks = [];
  const integrity = integrityChecks(data.lines, data.stockMoves, data.acc, data.items, { asOf: to });
  const tb = integrity[0];
  checks.push({ key: 'TB', label: 'Trial balance balances', ok: tb.ok, blocking: true, detail: tb.ok ? '' : 'Debits ' + tb.glPaisa + ' vs credits ' + tb.subledgerPaisa });
  const bad = integrity.slice(1).filter(function (c) { return !c.ok; });
  checks.push({ key: 'CONTROL', label: 'Control accounts and stock agree with their records', ok: !bad.length, blocking: true, detail: bad.map(function (c) { return c.name; }).join('; ') });
  const daysWithSales = {};
  (data.sales || []).forEach(function (x) { if (x.status !== 'VOID' && x.date >= from && x.date <= to) daysWithSales[x.date + '|' + (x.store || '')] = true; });
  const cashedUp = {};
  (data.cashUps || []).forEach(function (c) { cashedUp[c.date + '|' + (c.store || '')] = true; });
  const missing = Object.keys(daysWithSales).filter(function (k) { return !cashedUp[k]; }).sort();
  checks.push({ key: 'CASHUP', label: 'Cash-up done for every trading day', ok: !missing.length, blocking: false, detail: missing.map(function (k) { return k.replace('|', ' '); }).join(', ') });
  const counted = (data.stockCounts || []).some(function (c) { return c.status === 'POSTED' && c.date >= from && c.date <= to; });
  checks.push({ key: 'COUNT', label: 'Stock counted this month', ok: counted, blocking: false, detail: counted ? '' : 'No stock count dated in ' + periodId });
  const reconciled = (data.bankRecs || []).some(function (r) { return r.status === 'RECONCILED' && r.statementDate >= to; });
  checks.push({ key: 'BANK', label: 'Bank accounts reconciled to month end', ok: reconciled, blocking: false, detail: reconciled ? '' : 'No reconciliation to ' + to + ' or later' });
  const prev = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 2, 1)).toISOString().slice(0, 7);
  const anyLines = data.lines.some(function (l) { return l.date < from; });
  const prevClosed = (data.periods || []).some(function (p) { return p.id === prev && p.status === 'CLOSED'; });
  checks.push({ key: 'PREVIOUS', label: 'Previous month is closed', ok: prevClosed || !anyLines, blocking: false, detail: prevClosed || !anyLines ? '' : prev + ' is still open' });
  return { periodId: periodId, from: from, to: to, checks: checks, canClose: checks.every(function (c) { return c.ok || !c.blocking; }), warnings: checks.filter(function (c) { return !c.ok && !c.blocking; }).length };
}

// ---------- Ageing ----------

function daysBetween(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

const AGE_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'];

// docs: open invoices or bills [{id, contactId, date, dueDate, balancePaisa}].
// Buckets by days past due at asOf.
function ageing(docs, opts) {
  const asOf = Validate.checkDate((opts || {}).asOf, 'asOf');
  const byContact = {};
  const totals = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 };
  docs.forEach(function (d) {
    if (!d.balancePaisa || d.date > asOf || d.status === 'VOID') return;
    const late = daysBetween(d.dueDate || d.date, asOf);
    const bucket = late <= 0 ? 'current' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'd90plus';
    if (!byContact[d.contactId]) byContact[d.contactId] = { contactId: d.contactId, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 };
    byContact[d.contactId][bucket] += d.balancePaisa;
    byContact[d.contactId].total += d.balancePaisa;
    totals[bucket] += d.balancePaisa;
    totals.total += d.balancePaisa;
  });
  return { asOf: asOf, rows: Object.keys(byContact).sort().map(function (c) { return byContact[c]; }), totals: totals };
}

// ---------- Integrity (invariant 7) ----------

// Control accounts against their sub-ledgers, and inventory GL against stock.
// Returns [{name, ok, glPaisa, subledgerPaisa}].
function integrityChecks(lines, stockMoves, acc, items, opts) {
  const o = opts || {};
  const bal = accountBalances(lines, { asOf: o.asOf });
  const tb = trialBalance(lines, acc, { asOf: o.asOf });
  function gl(key) { const c = codeFor(acc, key); return c ? bal[c] || 0 : 0; }
  function total(map) { return Object.keys(map).reduce(function (s, k) { return s + map[k]; }, 0); }
  const checks = [{ name: 'Trial balance', ok: tb.balanced, glPaisa: tb.totalDebitPaisa, subledgerPaisa: tb.totalCreditPaisa }];
  const customers = customerBalances(lines, acc, { asOf: o.asOf });
  checks.push({ name: 'AR = customer balances', glPaisa: gl('AR'), subledgerPaisa: Object.keys(customers).reduce(function (s, c) { return s + customers[c].owesPaisa; }, 0) });
  checks.push({ name: 'Customer advances = advances held', glPaisa: -gl('CUSTOMER_ADV'), subledgerPaisa: Object.keys(customers).reduce(function (s, c) { return s + customers[c].advanceHeldPaisa; }, 0) });
  checks.push({ name: 'AP = vendor balances', glPaisa: -gl('AP'), subledgerPaisa: total(vendorBalances(lines, acc, { asOf: o.asOf })) });
  const wip = jobWip(lines, acc, { asOf: o.asOf });
  checks.push({ name: 'WIP = open job costs', glPaisa: gl('WIP'), subledgerPaisa: Object.keys(wip).reduce(function (s, j) { return s + total(wip[j]); }, 0) });
  const val = stockValuation(stockMoves, items, { asOf: o.asOf });
  Validate.INVENTORY_KEYS.forEach(function (k) {
    checks.push({ name: k + ' = stock valuation', glPaisa: gl(k), subledgerPaisa: val.byAccountKey[k] || 0 });
  });
  checks.forEach(function (c) { if (c.ok === undefined) c.ok = c.glPaisa === c.subledgerPaisa; });
  return checks;
}

if (typeof module !== 'undefined') module.exports = {
  COLUMNS,
  AGE_BUCKETS,
  accountBalances,
  accountLedger,
  trialBalance,
  profitAndLoss,
  balanceSheet,
  customerBalances,
  vendorBalances,
  jobAdvances,
  jobWip,
  jobCostSheet,
  jobProfitability,
  stockValuation,
  inventoryReconciliation,
  skuMargin,
  cashPosition,
  salesTaxSummary,
  whtRegister,
  closeChecklist,
  ageing,
  integrityChecks,
};
