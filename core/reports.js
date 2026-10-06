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
    summary.grossMarginBps[c] = rev > 0 ? Money.divRoundHalfEven(BigInt(gp) * 10000n, rev) : null;
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
      marginBps: p.revenue > 0 ? Money.divRoundHalfEven(BigInt(margin) * 10000n, p.revenue) : null,
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
  ageing,
  integrityChecks,
};
