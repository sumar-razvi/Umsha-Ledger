// core/kpis.js: dashboard KPIs (module M10, docs/10-dashboard-kpis.md).
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.
//
// Everything here is derived from the ledger and documents; no KPI is typed
// in. Ledger figures come from MonthlySummary rows (one per month, account,
// brand and closing flag) or, for periods that do not start and end on month
// boundaries, from the journal lines themselves. Both have the same shape:
// {accountCode, brand, debitPaisa, creditPaisa, isClosing} plus `month` or
// `date`, so every KPI works on either.
//
// Tiles: {id, kpi, label, value, unit, compare, delta, deltaPct, rag, spark[], link, note}
//   unit: 'paisa' | 'bps' (a percentage, 10000 = 100%) | 'ratio' (bps, 10000 = 1.00x)
//         | 'count' | 'days'. value null means "n/a" (never a divide-by-zero).
// Charts: {id, title, type: 'bar'|'stacked'|'line'|'doughnut', labels[], series[{label, data[]}], unit}
// Tables: {id, title, columns[{key, label, unit?}], rows[], link?}
// Alerts: {level: 'red'|'amber', text, link}

const Money = require('./money.js');
const Validate = require('./validate.js');
const Dates = require('./dates.js');

const TABS = ['OVERVIEW', 'CASH', 'UMSHA', 'MIRAE', 'OPERATIONS', 'CUSTOMERS', 'CONTROLS'];
const TAB_LABEL = { OVERVIEW: 'Overview', CASH: 'Cash', UMSHA: 'UMSHA (MTO)', MIRAE: 'Mirae (RTW)', OPERATIONS: 'Operations', CUSTOMERS: 'Customers', CONTROLS: 'Controls' };
const PERIODS = ['TODAY', 'WTD', 'MTD', 'QTD', 'YTD', 'L12M', 'CUSTOM'];
const COMPARES = ['PREVIOUS', 'LAST_YEAR', 'TARGET', 'NONE'];
const OPEN_JOB = ['OPEN', 'IN_PRODUCTION', 'READY'];

// The Sheet tabs each dashboard tab reads (the server loads only these).
// Every tab also gets Accounts, Settings, KpiTargets and MonthlySummary.
const TAB_DATA = {
  OVERVIEW: ['Jobs', 'TaxCodes', 'DailySales', 'Invoices', 'Bills', 'Payments', 'PaymentAllocations', 'Periods', 'BankRecs', 'Items', 'ItemBalances'],
  CASH: ['Jobs', 'TaxCodes', 'Invoices', 'Bills', 'Payments', 'PaymentAllocations', 'DailySales'],
  UMSHA: ['Jobs', 'Contacts', 'TaxCodes', 'Invoices', 'Payments', 'PaymentAllocations'],
  MIRAE: ['DailySales', 'Sales', 'SaleLines', 'SalePayments', 'Items', 'ItemBalances', 'StockMoves', 'CashUps', 'Jobs'],
  OPERATIONS: ['Bills', 'BillLines', 'Contacts', 'Items', 'ItemBalances', 'StockMoves'],
  CUSTOMERS: ['Contacts', 'Invoices', 'Sales'],
  CONTROLS: ['Periods', 'BankRecs', 'Bills', 'Attachments', 'Journal', 'Payments', 'AuditLog'],
};
// Tabs that also need the journal lines carrying a jobId (cost per job), as data.jobLines.
const NEEDS_JOB_LINES = ['UMSHA'];

// Seeded KpiTargets keys (docs/10). Thresholds are in the KPI's own unit.
const TARGET_KEYS = ['minCash', 'cashRunwayDays', 'advanceCoverage', 'minAdvancePct', 'maxReturnPct', 'maxConcentrationPct',
  'drawingsLimitMonthly', 'revenueTarget', 'bankRecMaxDays', 'onTimePct', 'grossMarginPct'];

// ---------- dates ----------

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function monthOf(iso) { return String(iso).slice(0, 7); }
function monthEnd(iso) { const y = +iso.slice(0, 4); const m = +iso.slice(5, 7); return ymd(y, m, daysInMonth(y, m)); }
function dayNo(iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000; }
function daysBetween(a, b) { return dayNo(b) - dayNo(a); }

// Move a date by whole months, keeping the day (clamped to the month's end).
function addMonths(iso, n) {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12 + 1;
  return ymd(yy, mm, Math.min(+iso.slice(8, 10), daysInMonth(yy, mm)));
}

// ['2026-08', '2026-09', ...] from the month of `from` to the month of `to`.
function monthsBetween(from, to) {
  const out = [];
  let m = monthOf(from) + '-01';
  while (monthOf(m) <= monthOf(to)) { out.push(monthOf(m)); m = addMonths(m, 1); }
  return out;
}

// The last `n` months ending with the month of `iso`.
function lastMonths(iso, n) {
  return monthsBetween(addMonths(monthOf(iso) + '-01', -(n - 1)), iso);
}

function fiscalYearStart(iso, fyStartMonth) {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  const sm = fyStartMonth || 7;
  return ymd(m >= sm ? y : y - 1, sm, 1);
}

// {from, to, period} for a period name on `today` (Asia/Karachi date).
function periodRange(period, today, opts) {
  const o = opts || {};
  const p = period || 'MTD';
  if (PERIODS.indexOf(p) === -1) Validate.fail('E_VALIDATION', 'Unknown period ' + p, 'period');
  const t = Validate.checkDate(today, 'today');
  if (p === 'TODAY') return { period: p, from: t, to: t };
  if (p === 'WTD') { // weeks start on Monday
    const dow = (new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10))).getUTCDay() + 6) % 7;
    return { period: p, from: Dates.addDays(t, -dow), to: t };
  }
  if (p === 'MTD') return { period: p, from: monthOf(t) + '-01', to: t };
  if (p === 'QTD') {
    const fy = fiscalYearStart(t, o.fyStartMonth);
    const q = Math.floor(((+t.slice(0, 4) - +fy.slice(0, 4)) * 12 + (+t.slice(5, 7) - +fy.slice(5, 7))) / 3);
    return { period: p, from: addMonths(fy, q * 3), to: t };
  }
  if (p === 'YTD') return { period: p, from: fiscalYearStart(t, o.fyStartMonth), to: t };
  if (p === 'L12M') return { period: p, from: addMonths(monthOf(t) + '-01', -11), to: t };
  const from = Validate.checkDate(o.from, 'from');
  const to = Validate.checkDate(o.to, 'to');
  if (from > to) Validate.fail('E_VALIDATION', 'The start date is after the end date', 'from');
  return { period: p, from: from, to: to };
}

// The comparison range, or null for TARGET / NONE.
function compareRange(range, compareTo) {
  const c = compareTo || 'PREVIOUS';
  if (COMPARES.indexOf(c) === -1) Validate.fail('E_VALIDATION', 'Unknown comparison ' + c, 'compareTo');
  if (c === 'TARGET' || c === 'NONE') return null;
  if (c === 'LAST_YEAR') return { from: addMonths(range.from, -12), to: addMonths(range.to, -12) };
  const shift = { MTD: 1, QTD: 3, YTD: 12, L12M: 12 }[range.period];
  if (shift) return { from: addMonths(range.from, -shift), to: addMonths(range.to, -shift) };
  if (range.period === 'WTD') return { from: Dates.addDays(range.from, -7), to: Dates.addDays(range.to, -7) };
  const len = daysBetween(range.from, range.to) + 1;
  return { from: Dates.addDays(range.from, -len), to: Dates.addDays(range.from, -1) };
}

// True when MonthlySummary covers the range exactly: it starts on the 1st
// and ends on a month end (or today, inside the current month).
function monthAligned(range, today) {
  return range.from.slice(8) === '01' && (range.to === monthEnd(range.to) || range.to === today);
}

// ---------- MonthlySummary (rebuildable cache) ----------

function summaryKey(r) {
  return r.month + '|' + r.accountCode + '|' + r.brand + '|' + (Validate.isTrue(r.isClosing) ? 'C' : '');
}

// Aggregate journal lines (with date and isClosing) into summary rows.
function summarizeLines(lines) {
  const by = {};
  lines.forEach(function (l) {
    const row = { month: monthOf(l.date), accountCode: String(l.accountCode), brand: l.brand, isClosing: Validate.isTrue(l.isClosing) };
    const k = summaryKey(row);
    if (!by[k]) by[k] = Object.assign(row, { debitPaisa: 0, creditPaisa: 0, lineCount: 0 });
    by[k].debitPaisa += l.debitPaisa || 0;
    by[k].creditPaisa += l.creditPaisa || 0;
    by[k].lineCount += 1;
  });
  return Object.keys(by).sort().map(function (k) { return by[k]; });
}

// Add delta rows into existing rows. Returns what to write:
// {updates: [{row, fields}], appends: [row]} (existing rows are not changed here).
function mergeSummary(existing, delta) {
  const idx = {};
  existing.forEach(function (r) { idx[summaryKey(r)] = r; });
  const out = { updates: [], appends: [] };
  delta.forEach(function (d) {
    const r = idx[summaryKey(d)];
    if (r) {
      out.updates.push({ row: r, fields: { debitPaisa: (r.debitPaisa || 0) + d.debitPaisa, creditPaisa: (r.creditPaisa || 0) + d.creditPaisa, lineCount: (r.lineCount || 0) + d.lineCount } });
    } else {
      out.appends.push(d);
    }
  });
  return out;
}

// Rows that differ between a stored cache and a rebuild: [{key, stored, rebuilt}].
function cacheDrift(stored, rebuilt, keyFn, fields) {
  const a = {};
  const b = {};
  stored.forEach(function (r) { a[keyFn(r)] = r; });
  rebuilt.forEach(function (r) { b[keyFn(r)] = r; });
  const keys = Object.keys(a).concat(Object.keys(b).filter(function (k) { return !(k in a); })).sort();
  const out = [];
  keys.forEach(function (k) {
    const x = a[k] || {};
    const y = b[k] || {};
    const zero = fields.every(function (f) { return !(x[f] || 0) && !(y[f] || 0); });
    if (zero) return;
    if (fields.some(function (f) { return (x[f] || 0) !== (y[f] || 0); })) {
      const pick = function (o) { const p = {}; fields.forEach(function (f) { p[f] = o[f] || 0; }); return p; };
      out.push({ key: k, stored: pick(x), rebuilt: pick(y) });
    }
  });
  return out;
}

function summaryDrift(stored, rebuilt) {
  return cacheDrift(stored, rebuilt, summaryKey, ['debitPaisa', 'creditPaisa', 'lineCount']);
}

// ---------- DailySales (rebuildable cache) ----------

const DAILY_FIELDS = ['netPaisa', 'taxPaisa', 'costPaisa', 'discountPaisa', 'transactions', 'units', 'returnsNetPaisa', 'cardPaisa'];

function dailyKey(r) { return r.date + '|' + r.store + '|' + r.channel; }

// One row per date, store and channel from posted Sales and SaleLines.
// netPaisa/taxPaisa/discountPaisa/units: goods sold (before returns);
// returnsNetPaisa: net value taken back; costPaisa: cost of goods sold less
// cost of goods returned; transactions: SALE documents; cardPaisa: money
// taken into card/wallet clearing accounts (refunds negative).
function dailySalesRows(sales, saleLines, salePayments, clearingCodes) {
  const live = {};
  sales.forEach(function (s) { if (s.status !== 'VOID') live[s.id] = s; });
  const by = {};
  function row(s) {
    const r = { date: s.date, store: s.store || '', channel: s.channel || 'STORE' };
    const k = dailyKey(r);
    if (!by[k]) { by[k] = r; DAILY_FIELDS.forEach(function (f) { r[f] = 0; }); }
    return by[k];
  }
  Object.keys(live).forEach(function (id) { const s = live[id]; const r = row(s); if (s.kind === 'SALE') r.transactions += 1; });
  saleLines.forEach(function (l) {
    const s = live[l.saleId];
    if (!s) return;
    const r = row(s);
    if ((l.netPaisa || 0) >= 0 && Number(l.qty) > 0) {
      r.netPaisa += l.netPaisa || 0;
      r.taxPaisa += l.taxPaisa || 0;
      r.discountPaisa += l.discountPaisa || 0;
      r.units += Number(l.qty) || 0;
    } else {
      r.returnsNetPaisa += -(l.netPaisa || 0);
    }
    r.costPaisa += l.costPaisa || 0;
  });
  const clearing = {};
  (clearingCodes || []).forEach(function (c) { clearing[String(c)] = true; });
  (salePayments || []).forEach(function (p) {
    const s = live[p.saleId];
    if (!s || !clearing[String(p.accountCode)]) return;
    row(s).cardPaisa += p.amountPaisa || 0;
  });
  return Object.keys(by).sort().map(function (k) { return by[k]; });
}

function dailySalesDrift(stored, rebuilt) {
  return cacheDrift(stored, rebuilt, dailyKey, DAILY_FIELDS);
}

// ---------- small helpers ----------

function sum(arr, fn) { let t = 0; arr.forEach(function (x) { t += fn ? fn(x) : x; }); return t; }
function inRange(d, r) { return !!d && d >= r.from && d <= r.to; }
function ratioBps(num, den) {
  if (!den || den <= 0 || num === null || num === undefined) return null;
  return Money.divRoundHalfEven(BigInt(Math.round(num)) * 10000n, BigInt(Math.round(den)));
}
function avg(num, den) { return den ? Math.round(num / den) : null; }
function isVoid(d) { return d.status === 'VOID'; }
function byDesc(f) { return function (a, b) { return (b[f] || 0) - (a[f] || 0); }; }

// ---------- the ledger (summary rows or lines) ----------

function Ledger(data, today) {
  const acc = data.acc;
  const monthly = (data.monthly || []).map(function (r) { return Object.assign({}, r, { date: r.month + '-01' }); });
  const lines = data.lines || null;
  function rowsFor(range) {
    if (lines && !monthAligned(range, today)) return lines.filter(function (l) { return inRange(l.date, range); });
    const months = {};
    monthsBetween(range.from, range.to).forEach(function (m) { months[m] = true; });
    return monthly.filter(function (r) { return months[r.month]; });
  }
  function rowsUpTo(asOf) {
    if (lines) return lines.filter(function (l) { return l.date <= asOf; });
    const m = monthOf(asOf);
    return monthly.filter(function (r) { return r.month <= m; });
  }
  function typeOf(code) { const a = acc.accountsByCode[code]; return a ? a.type : ''; }
  function brandOk(row, brand) { return !brand || brand === 'ALL' || row.brand === brand; }

  // P&L figures (positive = good for revenue/other, positive = cost for the rest).
  function pnl(range, brand) {
    const out = { revenue: 0, returns: 0, cogs: 0, opex: 0, other: 0, tax: 0, byCode: {} };
    rowsFor(range).forEach(function (r) {
      if (Validate.isTrue(r.isClosing) || !brandOk(r, brand)) return;
      const n = (r.debitPaisa || 0) - (r.creditPaisa || 0);
      const t = typeOf(r.accountCode);
      if (t === 'REVENUE') out.revenue -= n;
      else if (t === 'COGS') out.cogs += n;
      else if (t === 'EXPENSE') out.opex += n;
      else if (t === 'OTHER') out.other -= n;
      else if (t === 'TAX') out.tax += n;
      else return;
      out.byCode[r.accountCode] = (out.byCode[r.accountCode] || 0) + n;
    });
    out.grossProfit = out.revenue - out.cogs;
    out.netProfit = out.grossProfit - out.opex + out.other - out.tax;
    return out;
  }
  // Net debit balance of the accounts matching `pick` at the end of asOf.
  function balance(asOf, pick, brand) {
    let t = 0;
    rowsUpTo(asOf).forEach(function (r) {
      const a = acc.accountsByCode[r.accountCode];
      if (a && pick(a) && brandOk(r, brand)) t += (r.debitPaisa || 0) - (r.creditPaisa || 0);
    });
    return t;
  }
  // Debits and credits on matching accounts in a range.
  function movement(range, pick, brand) {
    const out = { debit: 0, credit: 0 };
    rowsFor(range).forEach(function (r) {
      const a = acc.accountsByCode[r.accountCode];
      if (!a || !pick(a) || !brandOk(r, brand) || Validate.isTrue(r.isClosing)) return;
      out.debit += r.debitPaisa || 0;
      out.credit += r.creditPaisa || 0;
    });
    out.net = out.debit - out.credit;
    return out;
  }
  // Same, by calendar month, always from the summary when it has the month.
  function monthlyPnl(months, brand) {
    return months.map(function (m) { return pnl({ from: m + '-01', to: monthEnd(m + '-01') }, brand); });
  }
  return { pnl: pnl, balance: balance, movement: movement, monthlyPnl: monthlyPnl, rowsFor: rowsFor };
}

// ---------- targets and RAG ----------

function targetFor(targets, kpi, brand, month) {
  const rows = (targets || []).filter(function (t) {
    return t.kpi === kpi && (!t.brand || t.brand === 'ALL' || !brand || brand === 'ALL' || t.brand === brand);
  });
  const exactBrand = rows.filter(function (t) { return t.brand === brand; });
  const pool = exactBrand.length ? exactBrand : rows;
  return pool.filter(function (t) { return t.period === month; })[0] || pool.filter(function (t) { return !t.period || t.period === 'ANY'; })[0] || null;
}

function num(v) { return v === '' || v === null || v === undefined ? null : Number(v); }

// 'red' | 'amber' | 'green' | null
function ragOf(value, t) {
  if (value === null || value === undefined || !t) return null;
  const red = num(t.redAt);
  const amber = num(t.amberAt);
  if (red === null && amber === null) return null;
  if (t.direction === 'LOWER_BETTER') {
    if (red !== null && value > red) return 'red';
    if (amber !== null && value > amber) return 'amber';
    return 'green';
  }
  if (red !== null && value < red) return 'red';
  if (amber !== null && value < amber) return 'amber';
  return 'green';
}

// ---------- the dashboard ----------

// data: {acc, settings, targets, monthly, lines?, jobLines?, ...tabs by name in camelCase}
// opts: {tab, today, period, from, to, brand, compareTo, role, store}
function dashboard(data, opts) {
  const o = opts || {};
  const tab = o.tab || 'OVERVIEW';
  if (TABS.indexOf(tab) === -1) Validate.fail('E_VALIDATION', 'Unknown dashboard tab ' + tab, 'tab');
  const today = Validate.checkDate(o.today, 'today');
  const settings = data.settings || {};
  const fy = Number(settings.fiscalYearStartMonth) || 7;
  const range = periodRange(o.period || 'MTD', today, { fyStartMonth: fy, from: o.from, to: o.to });
  const cmpName = o.compareTo || 'PREVIOUS';
  const cmp = compareRange(range, cmpName);
  const brand = o.brand && o.brand !== 'ALL' ? o.brand : 'ALL';
  if (['ALL', 'UMSHA', 'MIRAE'].indexOf(brand) === -1) Validate.fail('E_VALIDATION', 'Brand must be ALL, UMSHA or MIRAE', 'brand');
  const ctx = {
    data: data, acc: data.acc, settings: settings, today: today, range: range, cmp: cmp, compareTo: cmpName, brand: brand,
    role: o.role || 'OWNER', store: o.store || '', ledger: Ledger(data, today), targets: data.targets || [],
    month: monthOf(range.to), spark: lastMonths(range.to, 12),
  };
  const out = { tab: tab, period: range.period, from: range.from, to: range.to, compareTo: cmpName, compare: cmp, brand: brand, tiles: [], charts: [], tables: [], alerts: [], notes: [] };
  BUILDERS[tab](ctx, out);
  if (tab === 'OVERVIEW') out.alerts = alerts(ctx);
  return out;
}

// A tile whose value is fn(range) for the period and the comparison.
function tile(ctx, spec) {
  const value = spec.value !== undefined ? spec.value : spec.fn(ctx.range);
  const t = { id: spec.id, kpi: spec.kpi || spec.id, label: spec.label, value: value, unit: spec.unit, compare: null, delta: null, deltaPct: null, rag: null, spark: spec.spark || [], link: spec.link || '', note: spec.note || '' };
  if (spec.compareValue !== undefined) t.compare = spec.compareValue;
  else if (ctx.cmp && spec.fn && !spec.noCompare) t.compare = spec.fn(ctx.cmp);
  if (ctx.compareTo === 'TARGET' && spec.target) t.compare = targetValue(ctx, spec.target, spec.targetBrand || ctx.brand);
  if (value !== null && t.compare !== null && t.compare !== undefined) {
    t.delta = value - t.compare;
    t.deltaPct = t.compare ? ratioBps(t.delta, Math.abs(t.compare)) : null;
  }
  if (spec.rag !== undefined) t.rag = spec.rag;
  else if (spec.target) t.rag = ragOf(value, targetFor(ctx.targets, spec.target, spec.targetBrand || ctx.brand, ctx.month));
  return t;
}

// The target to compare with. Revenue targets are monthly and per brand:
// they are added up over the months of the period (and over both brands for ALL).
function targetValue(ctx, kpi, brand) {
  if (kpi !== 'revenueTarget') {
    const tg = targetFor(ctx.targets, kpi, brand, ctx.month);
    return tg && num(tg.target) ? num(tg.target) : null;
  }
  let total = 0;
  (brand === 'ALL' ? ['UMSHA', 'MIRAE'] : [brand]).forEach(function (b) {
    monthsBetween(ctx.range.from, ctx.range.to).forEach(function (m) {
      const tg = (ctx.targets || []).filter(function (t) { return t.kpi === kpi && t.brand === b && t.period === m; })[0] ||
        (ctx.targets || []).filter(function (t) { return t.kpi === kpi && t.brand === b && (!t.period || t.period === 'ANY'); })[0];
      total += tg ? num(tg.target) || 0 : 0;
    });
  });
  return total || null;
}

function link(path, range) {
  return range ? path + (path.indexOf('?') >= 0 ? '&' : '?') + 'from=' + range.from + '&to=' + range.to : path;
}

// ----- shared KPI functions -----

function moneyAcct(a) { return a.isMoney && a.systemKey !== 'STORE_CREDIT'; }
function clearingAcct(a) { return a.isMoney && a.moneyKind === 'CLEARING' && a.systemKey !== 'STORE_CREDIT'; }
function sysPick(key) { return function (a) { return a.systemKey === key; }; }
function codeOf(ctx, key) { const a = ctx.acc.accountsBySystemKey[key]; return a ? a.code : null; }

function cashOnHand(ctx, asOf) { return ctx.ledger.balance(asOf, moneyAcct); }
function advancesHeld(ctx, asOf) { return -ctx.ledger.balance(asOf, sysPick('CUSTOMER_ADV')); }
function advanceCoverage(ctx, asOf) { return ratioBps(cashOnHand(ctx, asOf), advancesHeld(ctx, asOf)); }

function revenueSpark(ctx, brand, field) {
  return ctx.ledger.monthlyPnl(ctx.spark, brand).map(function (p) { return p[field]; });
}

function gmBps(p) { return p.revenue > 0 ? ratioBps(p.grossProfit, p.revenue) : null; }

// Money flowing between our own money accounts (not real in/out): transfers
// and card settlements (net to bank), from Payments.
function internalMoves(ctx, range) {
  return sum((ctx.data.payments || []).filter(function (p) {
    return !isVoid(p) && inRange(p.date, range) && (p.kind === 'TRANSFER' || p.kind === 'SETTLEMENT');
  }), function (p) { return p.amountPaisa || 0; });
}

// Average daily cash going out over the 3 full months before `asOf`'s month.
function dailyOutflow(ctx, asOf) {
  const end = Dates.addDays(monthOf(asOf) + '-01', -1);
  const r = { from: addMonths(monthOf(asOf) + '-01', -3), to: end };
  const out = ctx.ledger.movement(r, moneyAcct).credit - internalMoves(ctx, r);
  const days = daysBetween(r.from, r.to) + 1;
  return out > 0 ? Math.round(out / days) : 0;
}

function runwayDays(ctx, asOf) {
  const d = dailyOutflow(ctx, asOf);
  return d > 0 ? Math.floor(cashOnHand(ctx, asOf) / d) : null;
}

// Open documents due within `days` of asOf, and overdue.
function dueSplit(docs, asOf, days) {
  const until = Dates.addDays(asOf, days);
  const open = docs.filter(function (d) { return !isVoid(d) && (d.balancePaisa || 0) > 0 && d.date <= asOf; });
  return {
    overdue: sum(open.filter(function (d) { return (d.dueDate || d.date) < asOf; }), function (d) { return d.balancePaisa; }),
    dueSoon: sum(open.filter(function (d) { const x = d.dueDate || d.date; return x >= asOf && x <= until; }), function (d) { return d.balancePaisa; }),
    total: sum(open, function (d) { return d.balancePaisa; }),
    count: open.length,
  };
}

// Card/wallet clearing: unsettled balance and the age of the oldest
// unsettled takings (oldest first out: the latest takings are what is left).
function clearingAge(ctx, asOf) {
  const bal = ctx.ledger.balance(asOf, clearingAcct);
  if (bal <= 0) return { balance: bal, oldestDays: null };
  const codes = {};
  Object.keys(ctx.acc.accountsByCode).forEach(function (c) { if (clearingAcct(ctx.acc.accountsByCode[c])) codes[c] = true; });
  const takings = [];
  (ctx.data.dailySales || []).forEach(function (r) { if (r.cardPaisa && r.date <= asOf) takings.push({ date: r.date, amount: r.cardPaisa }); });
  (ctx.data.payments || []).forEach(function (p) {
    if (!isVoid(p) && p.direction === 'IN' && codes[p.moneyAccountCode] && p.date <= asOf) takings.push({ date: p.date, amount: p.amountPaisa });
  });
  takings.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  let left = bal;
  let oldest = null;
  for (let i = 0; i < takings.length && left > 0; i++) { left -= takings[i].amount; oldest = takings[i].date; }
  return { balance: bal, oldestDays: oldest ? daysBetween(oldest, asOf) : null };
}

// ----- jobs -----

function mtoJobs(ctx) { return (ctx.data.jobs || []).filter(function (j) { return j.type === 'MTO_ORDER'; }); }

function taxRate(ctx, job) {
  const codes = (ctx.data.taxCodes || []).filter(function (t) {
    return t.id === job.taxCodeId && (!t.effectiveFrom || t.effectiveFrom <= (job.bookedDate || ctx.today)) && (!t.effectiveTo || t.effectiveTo >= (job.bookedDate || ctx.today));
  });
  return codes.length ? Number(codes[codes.length - 1].rateBps) || 0 : 0;
}

function orderGross(ctx, job) {
  const net = job.quotedPricePaisa || 0;
  return net + Money.applyBps(net, taxRate(ctx, job));
}

// Advances received per job (allocations of customer advance payments).
function advancesByJob(ctx) {
  const pays = {};
  (ctx.data.payments || []).forEach(function (p) { if (!isVoid(p) && p.kind === 'CUSTOMER_ADVANCE') pays[p.id] = p; });
  const out = {};
  (ctx.data.paymentAllocations || []).forEach(function (a) {
    const p = pays[a.paymentId];
    if (!p || a.docType !== 'JOB') return;
    (out[a.docId] = out[a.docId] || []).push({ date: p.date, amount: a.amountPaisa });
  });
  return out;
}

// Revenue and cost per job from job-level ledger lines.
function jobPnl(ctx) {
  if (ctx._jobPnl) return ctx._jobPnl;
  const per = {};
  (ctx.data.jobLines || []).forEach(function (l) {
    if (!l.jobId || Validate.isTrue(l.isClosing)) return;
    const a = ctx.acc.accountsByCode[l.accountCode];
    if (!a) return;
    const p = per[l.jobId] || (per[l.jobId] = { revenue: 0, cost: 0, wip: 0 });
    const n = (l.debitPaisa || 0) - (l.creditPaisa || 0);
    if (a.type === 'REVENUE' && a.systemKey !== 'CANCEL_INCOME') p.revenue -= n;
    if (a.type === 'COGS') p.cost += n;
    if (a.systemKey === 'WIP') p.wip += n;
  });
  ctx._jobPnl = per;
  return per;
}

function delivered(ctx, r) {
  return mtoJobs(ctx).filter(function (j) { return j.status === 'DELIVERED' && inRange(j.deliveredDate, r); });
}

function avgJobMargin(ctx, r) {
  const per = jobPnl(ctx);
  const jobs = delivered(ctx, r);
  const rev = sum(jobs, function (j) { return (per[j.id] || {}).revenue || 0; });
  const cost = sum(jobs, function (j) { return (per[j.id] || {}).cost || 0; });
  return rev > 0 ? ratioBps(rev - cost, rev) : null;
}

function invoicedNet(ctx, r) {
  return sum((ctx.data.invoices || []).filter(function (i) { return !isVoid(i) && inRange(i.date, r); }), function (i) { return i.netPaisa || 0; });
}

// ----- Mirae -----

function dailyRows(ctx, r) {
  return (ctx.data.dailySales || []).filter(function (d) { return inRange(d.date, r) && (!ctx.store || d.store === ctx.store); });
}
function salesNet(ctx, r) { return sum(dailyRows(ctx, r), function (d) { return d.netPaisa - d.returnsNetPaisa; }); }
function transactions(ctx, r) { return sum(dailyRows(ctx, r), function (d) { return d.transactions; }); }
function atv(ctx, r) { return avg(sum(dailyRows(ctx, r), function (d) { return d.netPaisa; }), transactions(ctx, r)); }
function upt(ctx, r) { const t = transactions(ctx, r); return t ? Math.round(sum(dailyRows(ctx, r), function (d) { return d.units; }) * 100 / t) : null; }
function returnRate(ctx, r) { const rows = dailyRows(ctx, r); return ratioBps(sum(rows, function (d) { return d.returnsNetPaisa; }), sum(rows, function (d) { return d.netPaisa; })); }
function discountRate(ctx, r) { const rows = dailyRows(ctx, r); const disc = sum(rows, function (d) { return d.discountPaisa; }); return ratioBps(disc, sum(rows, function (d) { return d.netPaisa; }) + disc); }

// ---------- tabs ----------

const BUILDERS = {};

BUILDERS.OVERVIEW = function (ctx, out) {
  const L = ctx.ledger;
  const b = ctx.brand;
  const asOf = ctx.range.to;
  out.tiles.push(tile(ctx, { id: 'A1', kpi: 'cashOnHand', label: 'Cash on hand', unit: 'paisa', fn: function (r) { return cashOnHand(ctx, r.to); }, target: 'minCash', link: '#/reports/cash',
    spark: ctx.spark.map(function (m) { return cashOnHand(ctx, monthEnd(m + '-01')); }) }));
  out.tiles.push(tile(ctx, { id: 'A4', kpi: 'advanceCoverage', label: 'Cash ÷ advances held', unit: 'ratio', fn: function (r) { return advanceCoverage(ctx, r.to); }, target: 'advanceCoverage', link: '#/reports/cash',
    note: advancesHeld(ctx, asOf) > 0 ? '' : 'No advances held' }));
  out.tiles.push(tile(ctx, { id: 'B1', kpi: 'netRevenue', label: 'Net revenue' + (b === 'ALL' ? '' : ' · ' + b), unit: 'paisa', fn: function (r) { return L.pnl(r, b).revenue; }, target: 'revenueTarget', link: link('#/reports/pnl', ctx.range), spark: revenueSpark(ctx, b, 'revenue') }));
  out.tiles.push(tile(ctx, { id: 'B2', kpi: 'grossMarginPct', label: 'Gross margin', unit: 'bps', fn: function (r) { return gmBps(L.pnl(r, b)); }, target: 'grossMarginPct', link: link('#/reports/pnl', ctx.range),
    spark: ctx.ledger.monthlyPnl(ctx.spark, b).map(gmBps) }));
  out.tiles.push(tile(ctx, { id: 'B4', kpi: 'netProfit', label: 'Net profit' + (b === 'ALL' ? '' : ' · ' + b + ' (before shared costs)'), unit: 'paisa', fn: function (r) { return L.pnl(r, b).netProfit; }, link: link('#/reports/pnl', ctx.range), spark: revenueSpark(ctx, b, 'netProfit') }));
  const open = mtoJobs(ctx).filter(function (j) { return OPEN_JOB.indexOf(j.status) >= 0; });
  out.tiles.push(tile(ctx, { id: 'C1', kpi: 'orderBook', label: 'Order book (' + open.length + ' open)', unit: 'paisa', value: sum(open, function (j) { return j.quotedPricePaisa || 0; }), link: '#/orders' }));
  out.tiles.push(tile(ctx, { id: 'D1', kpi: 'mirae.sales', label: 'Mirae sales (net)', unit: 'paisa', fn: function (r) { return salesNet(ctx, r); }, link: '#/store',
    spark: ctx.spark.map(function (m) { return salesNet(ctx, { from: m + '-01', to: monthEnd(m + '-01') }); }) }));
  const ap = dueSplit(ctx.data.bills || [], ctx.today, 7);
  out.tiles.push(tile(ctx, { id: 'A7', kpi: 'payablesOverdue', label: 'Bills overdue', unit: 'paisa', value: ap.overdue, rag: ap.overdue > 0 ? 'red' : 'green', link: '#/reports/ap', note: 'Due in 7 days: ' + Money.formatPaisa(ap.dueSoon) }));
  out.tiles.push(tile(ctx, { id: 'B3', kpi: 'opexPct', label: 'Running costs ÷ revenue', unit: 'bps', fn: function (r) { const p = L.pnl(r, b); return p.revenue > 0 ? ratioBps(p.opex, p.revenue) : null; }, link: link('#/reports/pnl', ctx.range),
    spark: ctx.ledger.monthlyPnl(ctx.spark, b).map(function (p) { return p.revenue > 0 ? ratioBps(p.opex, p.revenue) : null; }) }));
  const be = breakEven(ctx);
  const mtdRev = L.pnl(periodRange('MTD', ctx.today), 'ALL').revenue;
  out.tiles.push(tile(ctx, { id: 'B6', kpi: 'breakEven', label: 'Break-even monthly revenue', unit: 'paisa', value: be, link: link('#/reports/pnl', ctx.range),
    note: be ? 'This month so far: ' + (ratioBps(mtdRev, be) / 100).toFixed(0) + '%' : 'Needs 3 full months with a gross profit' }));
  const months = lastMonths(ctx.range.to, 12);
  const contrib = contribution(ctx, ctx.range);
  out.charts.push({ id: 'B5', title: 'Brand contribution after shared costs (' + contrib.key.toLowerCase() + ')', type: 'bar', unit: 'paisa', labels: ['UMSHA', 'Mirae'], series: [
    { label: 'Gross profit', data: [contrib.UMSHA.gp, contrib.MIRAE.gp] },
    { label: 'Own running costs', data: [-contrib.UMSHA.own, -contrib.MIRAE.own] },
    { label: 'Share of shared costs', data: [-contrib.UMSHA.shared, -contrib.MIRAE.shared] },
    { label: 'Contribution', data: [contrib.UMSHA.net, contrib.MIRAE.net] },
  ] });
  const mix = [['COGS_FABRIC', 'Fabric'], ['COGS_TRIMS', 'Trims'], ['COGS_EMBROIDERY', 'Embroidery'], ['COGS_STITCHING', 'Stitching'], ['COGS_OUTSOURCED', 'Outsourced'], ['COGS_RTW', 'Mirae goods sold']];
  const mp = L.monthlyPnl(months, 'ALL');
  out.charts.push({ id: 'B8', title: 'Cost mix as a share of revenue', type: 'stacked', unit: 'bps', labels: months, series: mix.map(function (m) {
    const code = codeOf(ctx, m[0]);
    return { label: m[1], data: mp.map(function (p) { return p.revenue > 0 && code ? ratioBps(p.byCode[code] || 0, p.revenue) : null; }) };
  }) });
  out.charts.push({ id: 'B1-trend', title: 'Net revenue by brand, last 12 months', type: 'stacked', unit: 'paisa', labels: months,
    series: ['UMSHA', 'MIRAE'].map(function (br) { return { label: br === 'UMSHA' ? 'UMSHA' : 'Mirae', data: L.monthlyPnl(months, br).map(function (p) { return p.revenue; }) }; }) });
};

// B6: average monthly fixed running costs ÷ gross margin, both over the
// last 3 full months. Card fees and cash over/short count as variable.
// TODO(decision-D-23): which running costs are fixed.
function breakEven(ctx) {
  const r = { from: addMonths(monthOf(ctx.today) + '-01', -3), to: Dates.addDays(monthOf(ctx.today) + '-01', -1) };
  const p = ctx.ledger.pnl(r, 'ALL');
  const variable = ['CARD_FEES', 'CASH_OVER_SHORT'].reduce(function (t, k) { const c = codeOf(ctx, k); return t + (c ? p.byCode[c] || 0 : 0); }, 0);
  const gm = gmBps(p);
  if (!gm || gm <= 0) return null;
  return Money.divRoundHalfEven(BigInt(Math.round((p.opex - variable) / 3)) * 10000n, BigInt(gm));
}

// B5: each brand's gross profit less its own running costs and its share of
// SHARED costs (Settings.allocationKey: REVENUE, FIXED or NONE).
function contribution(ctx, range) {
  const key = String(ctx.settings.allocationKey || 'REVENUE').toUpperCase();
  const u = ctx.ledger.pnl(range, 'UMSHA');
  const m = ctx.ledger.pnl(range, 'MIRAE');
  const sh = ctx.ledger.pnl(range, 'SHARED');
  const sharedCost = sh.cogs + sh.opex - sh.other + sh.tax - sh.revenue;
  let weights = null;
  if (key === 'FIXED') { const pct = Number(ctx.settings.allocationUmshaPctBps) || 0; weights = [pct, 10000 - pct]; }
  else if (key === 'REVENUE') weights = [Math.max(0, u.revenue), Math.max(0, m.revenue)];
  const split = weights && weights[0] + weights[1] > 0 && sharedCost ? Money.splitProRata(sharedCost, weights) : [0, 0];
  const one = function (p, s) { const own = p.opex - p.other + p.tax; return { gp: p.grossProfit, own: own, shared: s, net: p.grossProfit - own - s }; };
  return { key: weights ? key : 'NONE', UMSHA: one(u, split[0]), MIRAE: one(m, split[1]) };
}

BUILDERS.CASH = function (ctx, out) {
  const L = ctx.ledger;
  const asOf = ctx.range.to;
  out.tiles.push(tile(ctx, { id: 'A1', kpi: 'cashOnHand', label: 'Cash on hand', unit: 'paisa', fn: function (r) { return cashOnHand(ctx, r.to); }, target: 'minCash', link: '#/reports/cash',
    spark: ctx.spark.map(function (m) { return cashOnHand(ctx, monthEnd(m + '-01')); }) }));
  out.tiles.push(tile(ctx, { id: 'A2', kpi: 'netCashFlow', label: 'Net cash flow', unit: 'paisa', fn: function (r) { return L.movement(r, moneyAcct).net; }, link: '#/banking',
    spark: ctx.spark.map(function (m) { return L.movement({ from: m + '-01', to: monthEnd(m + '-01') }, moneyAcct).net; }) }));
  out.tiles.push(tile(ctx, { id: 'A3', kpi: 'cashRunwayDays', label: 'Cash runway', unit: 'days', fn: function (r) { return runwayDays(ctx, r.to); }, target: 'cashRunwayDays', link: '#/reports/cash', note: 'At the average spend of the last 3 full months' }));
  out.tiles.push(tile(ctx, { id: 'A4', kpi: 'advanceCoverage', label: 'Cash ÷ advances held', unit: 'ratio', fn: function (r) { return advanceCoverage(ctx, r.to); }, target: 'advanceCoverage', link: '#/reports/cash',
    note: 'Advances held ' + Money.formatPaisa(Math.max(0, advancesHeld(ctx, asOf))) }));
  const ca = clearingAge(ctx, asOf);
  out.tiles.push(tile(ctx, { id: 'A6', kpi: 'clearing', label: 'Card & wallet not yet in bank', unit: 'paisa', value: ca.balance, rag: ca.oldestDays !== null && ca.oldestDays > 3 ? 'amber' : ca.balance > 0 ? 'green' : null, link: '#/store', note: ca.oldestDays !== null ? 'Oldest ' + ca.oldestDays + ' days' : '' }));
  const ap = dueSplit(ctx.data.bills || [], ctx.today, 7);
  const ar = dueSplit(ctx.data.invoices || [], ctx.today, 7);
  out.tiles.push(tile(ctx, { id: 'A7', kpi: 'payablesDue', label: 'Bills due in 7 days', unit: 'paisa', value: ap.dueSoon, link: '#/reports/ap' }));
  out.tiles.push(tile(ctx, { id: 'A7b', kpi: 'payablesOverdue', label: 'Bills overdue', unit: 'paisa', value: ap.overdue, rag: ap.overdue > 0 ? 'red' : 'green', link: '#/reports/ap' }));
  out.tiles.push(tile(ctx, { id: 'A8', kpi: 'receivablesDue', label: 'Customers owe, due in 7 days', unit: 'paisa', value: ar.dueSoon, link: '#/reports/ar' }));
  out.tiles.push(tile(ctx, { id: 'A8b', kpi: 'receivablesOverdue', label: 'Customers owe, overdue', unit: 'paisa', value: ar.overdue, link: '#/reports/ar' }));
  const months = lastMonths(asOf, 12);
  out.charts.push({ id: 'A2-bars', title: 'Net cash flow by month', type: 'bar', unit: 'paisa', labels: months,
    series: [{ label: 'Net cash flow', data: months.map(function (m) { return L.movement({ from: m + '-01', to: monthEnd(m + '-01') }, moneyAcct).net; }) }] });
  const f = forecast(ctx, ctx.today, 60);
  out.charts.push({ id: 'A5', title: 'Cash forecast, next 60 days', type: 'line', unit: 'paisa', labels: f.days, series: [{ label: 'Projected cash', data: f.balance }] });
  out.tiles.push(tile(ctx, { id: 'A5', kpi: 'forecastLow', label: 'Lowest projected cash (60 days)', unit: 'paisa', value: f.low, rag: f.low < 0 ? 'red' : 'green', link: '#/reports/cash', note: f.low < 0 ? 'Goes below zero on ' + f.lowDate : '' }));
};

// A5: today's cash plus balances due on orders promised in the window, open
// invoices and unsettled card takings by due date, less bills due and the
// average monthly running costs spread over each day.
function forecast(ctx, from, days) {
  const cash = cashOnHand(ctx, from);
  const flows = {};
  function add(d, amt) { const k = d < from ? from : d; flows[k] = (flows[k] || 0) + amt; }
  const until = Dates.addDays(from, days);
  const adv = advancesByJob(ctx);
  mtoJobs(ctx).forEach(function (j) {
    if (OPEN_JOB.indexOf(j.status) === -1 || !j.promisedDate || j.promisedDate > until) return;
    const held = sum(adv[j.id] || [], function (a) { return a.amount; });
    const due = orderGross(ctx, j) - held;
    if (due > 0) add(j.promisedDate, due);
  });
  (ctx.data.invoices || []).forEach(function (i) { if (!isVoid(i) && i.balancePaisa > 0) add(i.dueDate || i.date, i.balancePaisa); });
  (ctx.data.bills || []).forEach(function (b) { if (!isVoid(b) && b.balancePaisa > 0) add(b.dueDate || b.date, -b.balancePaisa); });
  const clr = ctx.ledger.balance(from, clearingAcct);
  if (clr > 0) add(Dates.addDays(from, 3), clr);
  // Average monthly opex over the last 3 full months, spread per day.
  const r = { from: addMonths(monthOf(from) + '-01', -3), to: Dates.addDays(monthOf(from) + '-01', -1) };
  const perDay = Math.round(ctx.ledger.pnl(r, 'ALL').opex / (daysBetween(r.from, r.to) + 1));
  const out = { days: [], balance: [], low: cash, lowDate: from };
  let bal = cash;
  for (let i = 0; i <= days; i++) {
    const d = Dates.addDays(from, i);
    bal += (flows[d] || 0) - (i ? perDay : 0);
    out.days.push(d);
    out.balance.push(bal);
    if (bal < out.low) { out.low = bal; out.lowDate = d; }
  }
  return out;
}

BUILDERS.UMSHA = function (ctx, out) {
  const jobs = mtoJobs(ctx);
  const per = jobPnl(ctx);
  const open = jobs.filter(function (j) { return OPEN_JOB.indexOf(j.status) >= 0; });
  const r = ctx.range;
  out.tiles.push(tile(ctx, { id: 'C1', kpi: 'orderBook', label: 'Order book (' + open.length + ' open)', unit: 'paisa', value: sum(open, function (j) { return j.quotedPricePaisa || 0; }), link: '#/orders' }));
  out.tiles.push(tile(ctx, { id: 'C2', kpi: 'bookings', label: 'Booked in period', unit: 'paisa', fn: function (x) { return sum(jobs.filter(function (j) { return inRange(j.bookedDate, x) && j.status !== 'CANCELLED'; }), function (j) { return j.quotedPricePaisa || 0; }); }, link: '#/orders' }));
  out.tiles.push(tile(ctx, { id: 'C3', kpi: 'avgOrderValue', label: 'Average order value', unit: 'paisa', fn: function (x) { return avg(invoicedNet(ctx, x), delivered(ctx, x).length); }, link: link('#/reports/jobs', r) }));
  out.tiles.push(tile(ctx, { id: 'C4', kpi: 'avgJobMargin', label: 'Average job margin', unit: 'bps', fn: function (x) { return avgJobMargin(ctx, x); }, link: link('#/reports/jobs', r) }));
  const del = delivered(ctx, r);
  const budgeted = del.filter(function (j) { return j.budgetCostPaisa; });
  const over = budgeted.filter(function (j) { return ((per[j.id] || {}).cost || 0) > j.budgetCostPaisa; });
  out.tiles.push(tile(ctx, { id: 'C5', kpi: 'overrunRate', label: 'Jobs over budget', unit: 'bps', fn: function (x) {
    const d = delivered(ctx, x).filter(function (j) { return j.budgetCostPaisa; });
    return ratioBps(d.filter(function (j) { return ((per[j.id] || {}).cost || 0) > j.budgetCostPaisa; }).length, d.length);
  }, link: link('#/reports/jobs', r), note: budgeted.length ? over.length + ' of ' + budgeted.length + ' with a budget' : 'No delivered jobs with a budget' }));
  out.tiles.push(tile(ctx, { id: 'C6', kpi: 'onTimePct', label: 'Delivered on time', unit: 'bps', fn: function (x) {
    const d = delivered(ctx, x).filter(function (j) { return j.promisedDate; });
    return ratioBps(d.filter(function (j) { return j.deliveredDate <= j.promisedDate; }).length, d.length);
  }, target: 'onTimePct', link: link('#/reports/jobs', r) }));
  out.tiles.push(tile(ctx, { id: 'C7', kpi: 'leadTime', label: 'Average lead time', unit: 'days', fn: function (x) {
    const d = delivered(ctx, x).filter(function (j) { return j.bookedDate; });
    return avg(sum(d, function (j) { return daysBetween(j.bookedDate, j.deliveredDate); }), d.length);
  }, link: link('#/reports/jobs', r) }));
  const overdue = open.filter(function (j) { return j.promisedDate && j.promisedDate < ctx.today; });
  out.tiles.push(tile(ctx, { id: 'C8', kpi: 'overdueOrders', label: 'Orders overdue', unit: 'count', value: overdue.length, rag: overdue.length ? 'red' : 'green', link: '#/orders' }));
  const adv = advancesByJob(ctx);
  out.tiles.push(tile(ctx, { id: 'C9', kpi: 'advanceAtBooking', label: 'First advance ÷ order value', unit: 'bps', fn: function (x) {
    const js = jobs.filter(function (j) { return inRange(j.bookedDate, x) && (adv[j.id] || []).length && orderGross(ctx, j) > 0; });
    if (!js.length) return null;
    return Math.round(sum(js, function (j) {
      const first = (adv[j.id] || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; })[0];
      return ratioBps(first.amount, orderGross(ctx, j));
    }) / js.length);
  }, target: 'minAdvancePct', targetBrand: 'UMSHA', link: '#/orders' }));
  const wipOpen = open.map(function (j) { return { job: j, wip: (per[j.id] || {}).wip || 0, age: j.bookedDate ? daysBetween(j.bookedDate, ctx.today) : 0 }; });
  const old = wipOpen.filter(function (w) { return w.age > 60; });
  out.tiles.push(tile(ctx, { id: 'C10', kpi: 'wip', label: 'Work in progress', unit: 'paisa', value: ctx.ledger.balance(ctx.today, sysPick('WIP'), 'UMSHA'), link: '#/reports/jobs',
    rag: old.some(function (w) { return w.age > 90 && w.wip > 0; }) ? 'amber' : null, note: 'Open over 60 days: ' + Money.formatPaisa(sum(old, function (w) { return w.wip; })) }));
  const deliveredInv = {};
  jobs.forEach(function (j) { if (j.invoiceId) deliveredInv[j.invoiceId] = true; });
  const arMto = sum((ctx.data.invoices || []).filter(function (i) { return !isVoid(i) && deliveredInv[i.id] && i.balancePaisa > 0; }), function (i) { return i.balancePaisa; });
  const credit90 = invoicedNet(ctx, { from: Dates.addDays(ctx.today, -89), to: ctx.today });
  out.tiles.push(tile(ctx, { id: 'C11', kpi: 'arAfterDelivery', label: 'Balance owed after delivery', unit: 'paisa', value: arMto, link: '#/reports/ar',
    note: credit90 > 0 ? 'Days to collect (DSO): ' + Math.round(arMto * 90 / credit90) : '' }));
  out.tiles.push(tile(ctx, { id: 'C12', kpi: 'cancellationRate', label: 'Cancelled', unit: 'bps', fn: function (x) {
    const booked = jobs.filter(function (j) { return inRange(j.bookedDate, x); });
    return ratioBps(booked.filter(function (j) { return j.status === 'CANCELLED'; }).length, booked.length);
  }, link: '#/orders' }));
  const months = lastMonths(r.to, 12);
  out.charts.push({ id: 'C2-bars', title: 'Booked vs delivered (net value)', type: 'bar', unit: 'paisa', labels: months, series: [
    { label: 'Booked', data: months.map(function (m) { const x = { from: m + '-01', to: monthEnd(m + '-01') }; return sum(jobs.filter(function (j) { return inRange(j.bookedDate, x) && j.status !== 'CANCELLED'; }), function (j) { return j.quotedPricePaisa || 0; }); }) },
    { label: 'Delivered', data: months.map(function (m) { return invoicedNet(ctx, { from: m + '-01', to: monthEnd(m + '-01') }); }) },
  ] });
  const bands = [0, 0, 0, 0];
  del.forEach(function (j) {
    const p = per[j.id] || { revenue: 0, cost: 0 };
    const m = p.revenue > 0 ? ratioBps(p.revenue - p.cost, p.revenue) : null;
    if (m === null) return;
    bands[m < 3000 ? 0 : m < 5000 ? 1 : m < 7000 ? 2 : 3] += 1;
  });
  out.charts.push({ id: 'C4-hist', title: 'Job margins, delivered in period', type: 'bar', unit: 'count', labels: ['Under 30%', '30–50%', '50–70%', 'Over 70%'], series: [{ label: 'Jobs', data: bands }] });
  const aged = [0, 0, 0, 0];
  wipOpen.forEach(function (w) { aged[w.age <= 30 ? 0 : w.age <= 60 ? 1 : w.age <= 90 ? 2 : 3] += w.wip; });
  out.charts.push({ id: 'C10-aged', title: 'Work in progress by age of order', type: 'bar', unit: 'paisa', labels: ['0–30 days', '31–60', '61–90', 'Over 90'], series: [{ label: 'WIP', data: aged }] });
  const stages = ['OPEN', 'IN_PRODUCTION', 'READY'];
  out.charts.push({ id: 'C13', title: 'Open orders by stage', type: 'bar', unit: 'count', labels: ['Booked', 'In production', 'Ready'], series: [{ label: 'Orders', data: stages.map(function (s) { return open.filter(function (j) { return j.status === s; }).length; }) }] });
  const names = contactNames(ctx);
  out.tables.push({ id: 'C8-list', title: 'Overdue orders', link: '#/orders', columns: [{ key: 'id', label: 'Order' }, { key: 'customer', label: 'Customer' }, { key: 'promisedDate', label: 'Promised', unit: 'date' }, { key: 'daysLate', label: 'Days late', unit: 'count' }],
    rows: overdue.sort(function (a, b) { return a.promisedDate < b.promisedDate ? -1 : 1; }).map(function (j) { return { id: j.id, customer: names[j.contactId] || '', promisedDate: j.promisedDate, daysLate: daysBetween(j.promisedDate, ctx.today), link: '#/orders/' + j.id }; }) });
  out.tables.push({ id: 'C5-worst', title: 'Biggest cost overruns', link: link('#/reports/jobs', r), columns: [{ key: 'id', label: 'Order' }, { key: 'budget', label: 'Budget', unit: 'paisa' }, { key: 'cost', label: 'Actual cost', unit: 'paisa' }, { key: 'overPct', label: 'Over', unit: 'bps' }],
    rows: over.map(function (j) { const c = (per[j.id] || {}).cost || 0; return { id: j.id, budget: j.budgetCostPaisa, cost: c, overPct: ratioBps(c - j.budgetCostPaisa, j.budgetCostPaisa), link: '#/orders/' + j.id }; }).sort(byDesc('overPct')).slice(0, 5) });
};

function contactNames(ctx) {
  const out = {};
  (ctx.data.contacts || []).forEach(function (c) { out[c.id] = c.name; });
  return out;
}

BUILDERS.MIRAE = function (ctx, out) {
  const store = ctx.role === 'STORE';
  const r = ctx.range;
  const L = ctx.ledger;
  const t = ctx.today;
  const wtd = periodRange('WTD', t);
  const mtd = periodRange('MTD', t);
  out.tiles.push(tile(ctx, { id: 'D1', kpi: 'mirae.sales', label: 'Sales (net) in period', unit: 'paisa', fn: function (x) { return salesNet(ctx, x); }, target: store ? undefined : 'revenueTarget', targetBrand: 'MIRAE', link: '#/today',
    spark: ctx.spark.map(function (m) { return salesNet(ctx, { from: m + '-01', to: monthEnd(m + '-01') }); }) }));
  out.tiles.push(tile(ctx, { id: 'D1-today', kpi: 'mirae.today', label: 'Today', unit: 'paisa', value: salesNet(ctx, { from: t, to: t }), link: '#/today' }));
  out.tiles.push(tile(ctx, { id: 'D1-wtd', kpi: 'mirae.wtd', label: 'This week', unit: 'paisa', value: salesNet(ctx, wtd), link: '#/today' }));
  out.tiles.push(tile(ctx, { id: 'D1-mtd', kpi: 'mirae.mtd', label: 'This month', unit: 'paisa', value: salesNet(ctx, mtd), link: '#/today' }));
  out.tiles.push(tile(ctx, { id: 'D2', kpi: 'transactions', label: 'Transactions', unit: 'count', fn: function (x) { return transactions(ctx, x); }, link: '#/today' }));
  out.tiles.push(tile(ctx, { id: 'D3', kpi: 'atv', label: 'Average sale', unit: 'paisa', fn: function (x) { return atv(ctx, x); }, link: '#/today' }));
  out.tiles.push(tile(ctx, { id: 'D4', kpi: 'upt', label: 'Pieces per sale', unit: 'hundredths', fn: function (x) { return upt(ctx, x); }, link: '#/today' }));
  out.tiles.push(tile(ctx, { id: 'D9', kpi: 'returnRate', label: 'Returns', unit: 'bps', fn: function (x) { return returnRate(ctx, x); }, target: 'maxReturnPct', targetBrand: 'MIRAE', link: '#/returns' }));
  out.tiles.push(tile(ctx, { id: 'D10', kpi: 'discountRate', label: 'Discounts given', unit: 'bps', fn: function (x) { return discountRate(ctx, x); }, link: '#/today' }));
  const cashups = (ctx.data.cashUps || []).filter(function (c) { return inRange(c.date, r) && (!ctx.store || c.store === ctx.store); });
  out.tiles.push(tile(ctx, { id: 'D14', kpi: 'cashupVariance', label: 'Cash over / short', unit: 'paisa', value: sum(cashups, function (c) { return c.diffPaisa || 0; }), link: '#/cashup',
    rag: cashups.some(function (c) { return c.diffPaisa; }) ? 'amber' : null, note: cashups.filter(function (c) { return c.diffPaisa; }).length + ' of ' + cashups.length + ' days with a difference' }));
  // Payment mix and channels (own store only for Store staff).
  const sales = (ctx.data.sales || []).filter(function (s) { return !isVoid(s) && inRange(s.date, r) && (!ctx.store || s.store === ctx.store); });
  const saleIds = {};
  sales.forEach(function (s) { saleIds[s.id] = true; });
  const mix = {};
  (ctx.data.salePayments || []).forEach(function (p) { if (saleIds[p.saleId]) mix[p.method || 'OTHER'] = (mix[p.method || 'OTHER'] || 0) + (p.amountPaisa || 0); });
  const methods = Object.keys(mix).sort();
  out.charts.push({ id: 'D11', title: 'How customers paid', type: 'doughnut', unit: 'paisa', labels: methods.map(titleCase), series: [{ label: 'Paid', data: methods.map(function (m) { return mix[m]; }) }] });
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(Dates.addDays(t, -i));
  const channels = ['STORE', 'ONLINE', 'EXHIBITION'];
  out.charts.push({ id: 'D1-daily', title: 'Sales by day and channel, last 14 days', type: 'stacked', unit: 'paisa', labels: days,
    series: channels.map(function (c) { return { label: titleCase(c), data: days.map(function (d) { return sum(dailyRows(ctx, { from: d, to: d }).filter(function (x) { return x.channel === c; }), function (x) { return x.netPaisa - x.returnsNetPaisa; }); }) }; }) });
  if (store) { out.notes.push('Showing store ' + ctx.store + ' only.'); return; }

  // Cost-based KPIs: Owner and Finance only.
  const items = {};
  (ctx.data.items || []).forEach(function (i) { items[i.id] = i; });
  const bal = {};
  (ctx.data.itemBalances || []).forEach(function (b) { bal[b.itemId] = b; });
  const fg = sum(Object.keys(bal).filter(function (id) { return items[id] && items[id].category === 'SKU'; }), function (id) { return bal[id].valuePaisa || 0; });
  const r90 = { from: Dates.addDays(t, -89), to: t };
  const cogs90 = sum(dailyRows(ctx, r90), function (d) { return d.costPaisa; });
  out.tiles.push(tile(ctx, { id: 'D7', kpi: 'fgValue', label: 'Stock at cost', unit: 'paisa', value: fg, link: '#/inventory/valuation', note: cogs90 > 0 ? 'Cover ' + Math.round(fg * 90 / cogs90) + ' days' : 'No sales in 90 days' }));
  const lastSale = {};
  const saleById = {};
  (ctx.data.sales || []).forEach(function (s) { if (!isVoid(s)) saleById[s.id] = s; });
  (ctx.data.saleLines || []).forEach(function (l) { const s = saleById[l.saleId]; if (s && Number(l.qty) > 0 && (!lastSale[l.itemId] || s.date > lastSale[l.itemId])) lastSale[l.itemId] = s.date; });
  const firstIn = {};
  (ctx.data.stockMoves || []).forEach(function (m) { if (Number(m.qty) > 0 && (!firstIn[m.itemId] || m.date < firstIn[m.itemId])) firstIn[m.itemId] = m.date; });
  const agedList = Object.keys(bal).filter(function (id) {
    if (!items[id] || items[id].category !== 'SKU' || !(Number(bal[id].qty) > 0)) return false;
    const since = lastSale[id] || firstIn[id];
    return since && daysBetween(since, t) >= 90;
  });
  out.tiles.push(tile(ctx, { id: 'D8', kpi: 'agedStock', label: 'No sale in 90+ days', unit: 'paisa', value: sum(agedList, function (id) { return bal[id].valuePaisa || 0; }), link: '#/inventory', note: agedList.length + ' SKUs' }));
  const sh = codeOf(ctx, 'SHRINKAGE');
  out.tiles.push(tile(ctx, { id: 'D13', kpi: 'shrinkage', label: 'Shrinkage ÷ sales', unit: 'bps', fn: function (x) {
    const loss = L.movement(x, function (a) { return a.code === sh; }, 'MIRAE').net;
    return ratioBps(loss, salesNet(ctx, x));
  }, link: sh ? link('#/ledger/' + sh, r) : '' }));
  // Margin and sell-through from SaleLines and batch output.
  const perSku = {};
  (ctx.data.saleLines || []).forEach(function (l) {
    const s = saleById[l.saleId];
    if (!s || !inRange(s.date, r)) return;
    const p = perSku[l.itemId] || (perSku[l.itemId] = { net: 0, cost: 0, units: 0 });
    p.net += l.netPaisa || 0;
    p.cost += l.costPaisa || 0;
    p.units += Number(l.qty) || 0;
  });
  const skuRows = Object.keys(perSku).map(function (id) {
    const p = perSku[id];
    return { id: id, name: (items[id] || {}).name || id, collection: (items[id] || {}).collection || '', units: p.units, net: p.net, marginBps: p.net > 0 ? ratioBps(p.net - p.cost, p.net) : null, link: '#/inventory/items/' + id };
  }).filter(function (x) { return x.net > 0; }).sort(byDesc('marginBps'));
  const skuCols = [{ key: 'name', label: 'SKU' }, { key: 'collection', label: 'Collection' }, { key: 'units', label: 'Units', unit: 'count' }, { key: 'net', label: 'Sales', unit: 'paisa' }, { key: 'marginBps', label: 'Margin', unit: 'bps' }];
  out.tables.push({ id: 'D6-top', title: 'Best margins (top 10 SKUs)', link: link('#/reports/sku', r), columns: skuCols, rows: skuRows.slice(0, 10) });
  out.tables.push({ id: 'D6-bottom', title: 'Lowest margins (bottom 10 SKUs)', link: link('#/reports/sku', r), columns: skuCols, rows: skuRows.slice(-10).reverse() });
  const produced = {};
  (ctx.data.stockMoves || []).forEach(function (m) { if (m.moveType === 'BATCH_OUTPUT') { const c = (items[m.itemId] || {}).collection || '(none)'; produced[c] = (produced[c] || 0) + Number(m.qty); } });
  const soldAll = {};
  (ctx.data.saleLines || []).forEach(function (l) { if (saleById[l.saleId]) { const c = (items[l.itemId] || {}).collection || '(none)'; soldAll[c] = (soldAll[c] || 0) + (Number(l.qty) || 0); } });
  const cols = Object.keys(produced).sort();
  out.charts.push({ id: 'D5', title: 'Sell-through by collection (sold ÷ made)', type: 'bar', unit: 'bps', labels: cols, series: [{ label: 'Sell-through', data: cols.map(function (c) { return ratioBps(soldAll[c] || 0, produced[c]); }) }] });
};

function titleCase(s) { s = String(s || ''); return s.charAt(0) + s.slice(1).toLowerCase(); }

BUILDERS.OPERATIONS = function (ctx, out) {
  const r = ctx.range;
  const t = ctx.today;
  const bills = {};
  (ctx.data.bills || []).forEach(function (b) { if (!isVoid(b)) bills[b.id] = b; });
  const names = contactNames(ctx);
  const lines = (ctx.data.billLines || []).filter(function (l) { return bills[l.billId]; });
  function karigar(x) {
    return sum(lines.filter(function (l) { return (l.costComponent === 'EMBROIDERY' || l.costComponent === 'STITCHING') && inRange(bills[l.billId].date, x); }), function (l) { return l.netPaisa || 0; });
  }
  out.tiles.push(tile(ctx, { id: 'E1', kpi: 'karigarSpend', label: 'Karigar spend', unit: 'paisa', fn: karigar, link: '#/karigars' }));
  const byK = {};
  lines.forEach(function (l) { if ((l.costComponent === 'EMBROIDERY' || l.costComponent === 'STITCHING') && inRange(bills[l.billId].date, r)) { const c = bills[l.billId].contactId; byK[c] = (byK[c] || 0) + (l.netPaisa || 0); } });
  const topK = Object.keys(byK).sort(function (a, b) { return byK[b] - byK[a]; }).slice(0, 10);
  out.charts.push({ id: 'E1-top', title: 'Top karigars by spend', type: 'bar', unit: 'paisa', labels: topK.map(function (c) { return names[c] || c; }), series: [{ label: 'Spend', data: topK.map(function (c) { return byK[c]; }) }] });
  // E2: rate per piece by component, last 90 days vs the 90 before.
  function rates(x) {
    const by = {};
    lines.forEach(function (l) {
      if (!l.costComponent || !(Number(l.qty) > 0) || !inRange(bills[l.billId].date, x)) return;
      const k = by[l.costComponent] || (by[l.costComponent] = { amt: 0, qty: 0 });
      k.amt += l.netPaisa || 0;
      k.qty += Number(l.qty);
    });
    return by;
  }
  const now = rates({ from: Dates.addDays(t, -89), to: t });
  const before = rates({ from: Dates.addDays(t, -179), to: Dates.addDays(t, -90) });
  out.tables.push({ id: 'E2', title: 'Average rate per piece, last 90 days', link: '#/karigars', columns: [{ key: 'component', label: 'Work' }, { key: 'rate', label: 'Rate', unit: 'paisa' }, { key: 'prior', label: 'Previous 90 days', unit: 'paisa' }, { key: 'changePct', label: 'Change', unit: 'bps' }],
    rows: Object.keys(now).sort().map(function (c) {
      const rate = Math.round(now[c].amt / now[c].qty);
      const prior = before[c] && before[c].qty ? Math.round(before[c].amt / before[c].qty) : null;
      return { component: titleCase(c), rate: rate, prior: prior, changePct: prior ? ratioBps(rate - prior, prior) : null };
    }) });
  // E3, E4: materials.
  const items = {};
  (ctx.data.items || []).forEach(function (i) { items[i.id] = i; });
  const balances = ctx.data.itemBalances || [];
  const isMat = function (id) { return items[id] && (items[id].category === 'FABRIC' || items[id].category === 'TRIM'); };
  const matValue = sum(balances.filter(function (b) { return isMat(b.itemId); }), function (b) { return b.valuePaisa || 0; });
  const r90 = { from: Dates.addDays(t, -89), to: t };
  const issued90 = -sum((ctx.data.stockMoves || []).filter(function (m) { return isMat(m.itemId) && inRange(m.date, r90) && (m.moveType === 'ISSUE' || m.moveType === 'RETURN_TO_STOCK'); }), function (m) { return m.valuePaisa || 0; });
  out.tiles.push(tile(ctx, { id: 'E3', kpi: 'materialValue', label: 'Fabric and trims in stock', unit: 'paisa', value: matValue, link: '#/inventory/valuation', note: issued90 > 0 ? 'Cover ' + Math.round(matValue * 90 / issued90) + ' days' : 'Nothing issued in 90 days' }));
  const low = balances.filter(function (b) { const i = items[b.itemId]; return i && i.reorderLevel !== '' && i.reorderLevel !== null && i.reorderLevel !== undefined && Number(b.qty) < Number(i.reorderLevel); });
  Object.keys(items).forEach(function (id) { const i = items[id]; if (i.reorderLevel && Number(i.reorderLevel) > 0 && !balances.some(function (b) { return b.itemId === id; })) low.push({ itemId: id, qty: 0 }); });
  out.tiles.push(tile(ctx, { id: 'E4', kpi: 'lowStock', label: 'Below reorder level', unit: 'count', value: low.length, rag: low.length ? 'amber' : 'green', link: '#/inventory' }));
  out.tables.push({ id: 'E4-list', title: 'Below reorder level', link: '#/inventory', columns: [{ key: 'name', label: 'Item' }, { key: 'qty', label: 'In stock', unit: 'qty' }, { key: 'reorderLevel', label: 'Reorder at', unit: 'qty' }],
    rows: low.map(function (b) { const i = items[b.itemId]; return { name: i.name, qty: Number(b.qty) || 0, reorderLevel: Number(i.reorderLevel), link: '#/inventory/items/' + i.id }; }) });
  // E5: purchases by supplier.
  const bySup = {};
  Object.keys(bills).forEach(function (id) { const b = bills[id]; if (inRange(b.date, r)) bySup[b.contactId] = (bySup[b.contactId] || 0) + (b.netPaisa || 0); });
  const topS = Object.keys(bySup).sort(function (a, b) { return bySup[b] - bySup[a]; }).slice(0, 10);
  out.charts.push({ id: 'E5', title: 'Purchases by supplier', type: 'bar', unit: 'paisa', labels: topS.map(function (c) { return names[c] || c; }), series: [{ label: 'Bills (net)', data: topS.map(function (c) { return bySup[c]; }) }] });
  // E6: days payable outstanding.
  const ap = -ctx.ledger.balance(t, sysPick('AP'));
  const purch90 = sum(Object.keys(bills).map(function (id) { return bills[id]; }).filter(function (b) { return inRange(b.date, r90); }), function (b) { return b.grossPaisa || 0; });
  out.tiles.push(tile(ctx, { id: 'E6', kpi: 'dpo', label: 'Days to pay suppliers', unit: 'days', value: purch90 > 0 ? Math.round(ap * 90 / purch90) : null, link: '#/reports/ap' }));
  // E7: average purchase cost per unit for the top 5 fabrics, by month.
  const months = lastMonths(t, 12);
  const fab = {};
  lines.forEach(function (l) { if (l.itemId && items[l.itemId] && items[l.itemId].category === 'FABRIC') fab[l.itemId] = (fab[l.itemId] || 0) + (l.netPaisa || 0); });
  const top5 = Object.keys(fab).sort(function (a, b) { return fab[b] - fab[a]; }).slice(0, 5);
  out.charts.push({ id: 'E7', title: 'Fabric price per unit, top 5 fabrics', type: 'line', unit: 'paisa', labels: months, series: top5.map(function (id) {
    return { label: items[id].name, data: months.map(function (m) {
      const ls = lines.filter(function (l) { return l.itemId === id && monthOf(bills[l.billId].date) === m && Number(l.qty) > 0; });
      const q = sum(ls, function (l) { return Number(l.qty); });
      return q ? Math.round(sum(ls, function (l) { return l.netPaisa || 0; }) / q) : null;
    }) };
  }) });
};

// Purchases per customer: MTO invoices and Mirae sales (net of returns).
function purchases(ctx) {
  const out = [];
  (ctx.data.invoices || []).forEach(function (i) { if (!isVoid(i) && i.contactId) out.push({ contactId: i.contactId, date: i.date, net: i.netPaisa || 0, brand: 'UMSHA' }); });
  (ctx.data.sales || []).forEach(function (s) {
    if (isVoid(s) || !s.contactId) return;
    const net = s.kind === 'RETURN' ? -(s.netPaisa || 0) : s.netPaisa || 0;
    out.push({ contactId: s.contactId, date: s.date, net: net, brand: 'MIRAE', counts: s.kind === 'SALE' });
  });
  return out;
}

BUILDERS.CUSTOMERS = function (ctx, out) {
  const r = ctx.range;
  const t = ctx.today;
  const all = purchases(ctx);
  // Match customers on phone so one person with two records counts once.
  const contacts = {};
  (ctx.data.contacts || []).forEach(function (c) { contacts[c.id] = c; });
  const person = function (id) { const c = contacts[id]; return c && c.phone ? 'P' + c.phone : 'C' + id; };
  const counted = all.filter(function (p) { return p.counts !== false; });
  function active(x) { const s = {}; counted.forEach(function (p) { if (inRange(p.date, x)) s[person(p.contactId)] = true; }); return Object.keys(s); }
  out.tiles.push(tile(ctx, { id: 'F1', kpi: 'activeCustomers', label: 'Customers who bought', unit: 'count', fn: function (x) { return active(x).length; }, link: '#/customers' }));
  const first = {};
  counted.forEach(function (p) { const k = person(p.contactId); if (!first[k] || p.date < first[k]) first[k] = p.date; });
  const months = lastMonths(r.to, 12);
  out.charts.push({ id: 'F2', title: 'New and returning customers', type: 'stacked', unit: 'count', labels: months, series: [
    { label: 'New', data: months.map(function (m) { return active({ from: m + '-01', to: monthEnd(m + '-01') }).filter(function (k) { return monthOf(first[k]) === m; }).length; }) },
    { label: 'Returning', data: months.map(function (m) { return active({ from: m + '-01', to: monthEnd(m + '-01') }).filter(function (k) { return monthOf(first[k]) < m; }).length; }) },
  ] });
  const y = { from: Dates.addDays(t, -364), to: t };
  const counts = {};
  counted.forEach(function (p) { if (inRange(p.date, y)) { const k = person(p.contactId); counts[k] = (counts[k] || 0) + 1; } });
  const act12 = Object.keys(counts);
  out.tiles.push(tile(ctx, { id: 'F3', kpi: 'repeatRate', label: 'Bought twice or more (12 months)', unit: 'bps', value: ratioBps(act12.filter(function (k) { return counts[k] >= 2; }).length, act12.length), link: '#/customers' }));
  const rev12 = {};
  all.forEach(function (p) { if (inRange(p.date, y)) rev12[person(p.contactId)] = (rev12[person(p.contactId)] || 0) + p.net; });
  const total12 = sum(Object.keys(rev12), function (k) { return rev12[k]; });
  const top10 = Object.keys(rev12).sort(function (a, b) { return rev12[b] - rev12[a]; }).slice(0, 10);
  out.tiles.push(tile(ctx, { id: 'F5', kpi: 'concentration', label: 'Top 10 customers’ share (12 months)', unit: 'bps', value: total12 > 0 ? ratioBps(sum(top10, function (k) { return rev12[k]; }), total12) : null, target: 'maxConcentrationPct', link: '#/customers' }));
  const brands = {};
  all.forEach(function (p) { const k = person(p.contactId); (brands[k] = brands[k] || {})[p.brand] = true; });
  out.tiles.push(tile(ctx, { id: 'F6', kpi: 'crossBrand', label: 'Bought from both UMSHA and Mirae', unit: 'count', value: Object.keys(brands).filter(function (k) { return brands[k].UMSHA && brands[k].MIRAE; }).length, link: '#/customers' }));
  if (ctx.role === 'OWNER') {
    const life = {};
    const anyId = {};
    all.forEach(function (p) { const k = person(p.contactId); life[k] = (life[k] || 0) + p.net; anyId[k] = p.contactId; });
    out.tables.push({ id: 'F4', title: 'Top customers (all time)', link: '#/customers', columns: [{ key: 'name', label: 'Customer' }, { key: 'phone', label: 'Mobile' }, { key: 'net', label: 'Bought (net)', unit: 'paisa' }],
      rows: Object.keys(life).sort(function (a, b) { return life[b] - life[a]; }).slice(0, 10).map(function (k) { const c = contacts[anyId[k]] || {}; return { name: c.name || anyId[k], phone: c.phone || '', net: life[k], link: '#/customers/' + anyId[k] }; }) });
  }
};

BUILDERS.CONTROLS = function (ctx, out) {
  const r = ctx.range;
  const t = ctx.today;
  const L = ctx.ledger;
  const outTax = codeOf(ctx, 'OUTPUT_TAX');
  const inTax = codeOf(ctx, 'INPUT_TAX');
  out.tiles.push(tile(ctx, { id: 'G1', kpi: 'salesTaxPosition', label: 'Sales tax owed (output − input)', unit: 'paisa', value: -L.balance(t, function (a) { return a.code === outTax || a.code === inTax; }), link: link('#/reports/sales-tax', r) }));
  const wht = -L.balance(t, sysPick('WHT_PAYABLE'));
  const whtPays = (ctx.data.payments || []).filter(function (p) { return !isVoid(p) && p.whtPaisa > 0; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  let left = wht;
  let oldest = null;
  for (let i = 0; i < whtPays.length && left > 0; i++) { left -= whtPays[i].whtPaisa; oldest = whtPays[i].date; }
  out.tiles.push(tile(ctx, { id: 'G2', kpi: 'whtUndeposited', label: 'Withholding tax not yet deposited', unit: 'paisa', value: wht, link: '#/reports/wht', rag: oldest && daysBetween(oldest, t) > 30 ? 'amber' : null, note: oldest && wht > 0 ? 'Oldest ' + daysBetween(oldest, t) + ' days' : '' }));
  bankRecTiles(ctx).forEach(function (x) { out.tiles.push(x); });
  const lc = lastClosed(ctx);
  const behind = lc ? monthsBehind(lc, t) : null;
  out.tiles.push(tile(ctx, { id: 'G4', kpi: 'lastClosed', label: 'Last closed month', unit: 'text', value: lc || 'None', rag: behind === null || behind > 1 ? 'red' : 'green', link: '#/settings' }));
  const atts = {};
  (ctx.data.attachments || []).forEach(function (a) { atts[a.docType + '|' + a.docId] = true; });
  const billsNoAtt = (ctx.data.bills || []).filter(function (b) { return !isVoid(b) && inRange(b.date, r) && !atts['BILL|' + b.id] && !(Array.isArray(b.attachmentIds) && b.attachmentIds.length); });
  const journals = (ctx.data.journal || []).filter(function (j) { return inRange(j.date, r); });
  out.tables.push({ id: 'G5', title: 'Document hygiene in period', columns: [{ key: 'what', label: 'Check' }, { key: 'count', label: 'Count', unit: 'count' }], rows: [
    { what: 'Bills without a photo or PDF', count: billsNoAtt.length, link: '#/purchases' },
    { what: 'Withholding tax changed by hand', count: (ctx.data.auditLog || []).filter(function (a) { return inRange(String(a.ts).slice(0, 10), r) && /override/i.test(a.summary || ''); }).length, link: '#/reports/audit' },
    { what: 'Manual journals', count: journals.filter(function (j) { return Validate.isTrue(j.isManual); }).length, link: '#/journals' },
    { what: 'Reversals', count: journals.filter(function (j) { return j.reversesJeId; }).length, link: '#/journals' },
  ] });
  if (ctx.role === 'OWNER') {
    const draw = codeOf(ctx, 'OWNER_DRAWINGS');
    const mtd = periodRange('MTD', t);
    const ytd = periodRange('YTD', t, { fyStartMonth: Number(ctx.settings.fiscalYearStartMonth) || 7 });
    const dm = draw ? L.movement(mtd, function (a) { return a.code === draw; }).net : 0;
    out.tiles.push(tile(ctx, { id: 'G6', kpi: 'drawings', label: 'Owner drawings this month', unit: 'paisa', value: dm, target: 'drawingsLimitMonthly', link: draw ? '#/ledger/' + draw : '',
      note: 'This year ' + Money.formatPaisa(draw ? L.movement(ytd, function (a) { return a.code === draw; }).net : 0) }));
  }
  // TODO(decision-D-24): refused postings are not logged, so only reopened months are counted.
  const reopen = (ctx.data.auditLog || []).filter(function (a) { return a.action === 'periods.reopen' && inRange(String(a.ts).slice(0, 10), r); }).length;
  out.tiles.push(tile(ctx, { id: 'G7', kpi: 'auditFlags', label: 'Months reopened', unit: 'count', value: reopen, rag: reopen ? 'amber' : 'green', link: '#/reports/audit',
    note: 'Blocked postings (e.g. negative stock) are refused before saving and are not logged.' }));
};

function bankAccounts(ctx) {
  return Object.keys(ctx.acc.accountsByCode).map(function (c) { return ctx.acc.accountsByCode[c]; })
    .filter(function (a) { return a.isMoney && a.moneyKind === 'BANK' && a.isActive !== false; });
}

function bankRecTiles(ctx) {
  const max = targetFor(ctx.targets, 'bankRecMaxDays', 'ALL', ctx.month);
  const limit = max && num(max.redAt) !== null ? num(max.redAt) : 35;
  return bankAccounts(ctx).map(function (a) {
    const last = (ctx.data.bankRecs || []).filter(function (x) { return x.accountCode === a.code && x.status === 'RECONCILED'; })
      .map(function (x) { return x.statementDate; }).sort().pop();
    const days = last ? daysBetween(last, ctx.today) : null;
    return tile(ctx, { id: 'G3-' + a.code, kpi: 'bankRec', label: a.name + ': days since reconciled', unit: 'days', value: days, rag: days === null || days > limit ? 'red' : 'green', link: '#/banking', note: last ? 'To ' + last : 'Never reconciled' });
  });
}

function lastClosed(ctx) {
  return (ctx.data.periods || []).filter(function (p) { return p.status === 'CLOSED'; }).map(function (p) { return p.id; }).sort().pop() || null;
}

function monthsBehind(periodId, today) {
  return (+today.slice(0, 4) - +periodId.slice(0, 4)) * 12 + (+today.slice(5, 7) - +periodId.slice(5, 7));
}

// ---------- alerts (Overview) ----------

function alerts(ctx) {
  const out = [];
  const t = ctx.today;
  const cov = advanceCoverage(ctx, t);
  if (cov !== null && cov < 10000) out.push({ level: 'red', text: 'Cash is less than customer advances held (' + (cov / 10000).toFixed(2) + '×): deposits are paying for other things', link: '#/reports/cash' });
  const fc = forecast(ctx, t, 30);
  if (fc.low < 0) out.push({ level: 'red', text: 'Cash is projected to go below zero on ' + fc.lowDate, link: '#/reports/cash' });
  const open = mtoJobs(ctx).filter(function (j) { return OPEN_JOB.indexOf(j.status) >= 0; });
  const overdue = open.filter(function (j) { return j.promisedDate && j.promisedDate < t; });
  if (overdue.length) out.push({ level: 'red', text: overdue.length + ' order' + (overdue.length > 1 ? 's are' : ' is') + ' past the promised date', link: '#/orders' });
  const old = open.filter(function (j) { return j.bookedDate && daysBetween(j.bookedDate, t) > 90; });
  if (old.length) out.push({ level: 'amber', text: old.length + ' order' + (old.length > 1 ? 's have' : ' has') + ' been in work for over 90 days', link: '#/orders' });
  const ca = clearingAge(ctx, t);
  if (ca.oldestDays !== null && ca.oldestDays > 3) out.push({ level: 'amber', text: 'Card takings from ' + ca.oldestDays + ' days ago are not yet in the bank', link: '#/store' });
  const ap = dueSplit(ctx.data.bills || [], t, 7);
  if (ap.overdue > 0) out.push({ level: 'red', text: 'Bills overdue: ' + Money.formatPaisa(ap.overdue), link: '#/reports/ap' });
  bankRecTiles(ctx).forEach(function (x) { if (x.rag === 'red') out.push({ level: 'amber', text: x.label.replace(': days since reconciled', '') + ' not reconciled ' + (x.value === null ? 'yet' : 'for ' + x.value + ' days'), link: '#/banking' }); });
  const lc = lastClosed(ctx);
  if (!lc || monthsBehind(lc, t) > 1) out.push({ level: 'amber', text: lc ? 'Last closed month is ' + lc : 'No month has been closed yet', link: '#/settings' });
  const items = {};
  (ctx.data.items || []).forEach(function (i) { items[i.id] = i; });
  const low = (ctx.data.itemBalances || []).filter(function (b) { const i = items[b.itemId]; return i && Number(i.reorderLevel) > 0 && Number(b.qty) < Number(i.reorderLevel); });
  if (low.length) out.push({ level: 'amber', text: low.length + ' item' + (low.length > 1 ? 's are' : ' is') + ' below the reorder level', link: '#/inventory' });
  const rr = returnRate(ctx, ctx.range);
  const rt = targetFor(ctx.targets, 'maxReturnPct', 'MIRAE', ctx.month);
  if (rr !== null && ragOf(rr, rt) && ragOf(rr, rt) !== 'green') out.push({ level: 'amber', text: 'Mirae returns are ' + (rr / 100).toFixed(1) + '% of sales', link: '#/returns' });
  const draw = codeOf(ctx, 'OWNER_DRAWINGS');
  const dl = targetFor(ctx.targets, 'drawingsLimitMonthly', 'ALL', ctx.month);
  if (ctx.role === 'OWNER' && draw && dl && num(dl.target) > 0) {
    const dm = ctx.ledger.movement(periodRange('MTD', t), function (a) { return a.code === draw; }).net;
    if (dm > num(dl.target)) out.push({ level: 'amber', text: 'Drawings this month are above the limit', link: '#/ledger/' + draw });
  }
  out.sort(function (a, b) { return (a.level === 'red' ? 0 : 1) - (b.level === 'red' ? 0 : 1); });
  return out.slice(0, 8);
}

// ---------- role filtering ----------

// Remove anything a role must not see. Store staff see the Mirae tab for
// their own store only, without cost or margin figures (the builders already
// leave those out; this is the guard).
function filterForRole(result, user) {
  if (!user || user.role !== 'STORE') return result;
  const bad = /cost|margin|cogs|shrink|stock at|aged/i;
  result.tiles = result.tiles.filter(function (t) { return !bad.test(t.label) && !bad.test(t.kpi); });
  result.charts = result.charts.filter(function (c) { return !bad.test(c.title); });
  result.tables = [];
  result.alerts = [];
  return result;
}

// ---------- KpiTargets ----------

// A KpiTargets row from the Owner's input. Numbers are whole units of the
// KPI (paisa, bps, days); blank thresholds mean "no colour".
function prepareTarget(input, existingRows) {
  const p = input || {};
  const kpi = String(p.kpi || '');
  if (TARGET_KEYS.indexOf(kpi) === -1) Validate.fail('E_VALIDATION', 'Unknown KPI ' + kpi, 'kpi');
  const brand = p.brand || 'ALL';
  if (['ALL', 'UMSHA', 'MIRAE'].indexOf(brand) === -1) Validate.fail('E_VALIDATION', 'Brand must be ALL, UMSHA or MIRAE', 'brand');
  const period = p.period || 'ANY';
  if (period !== 'ANY' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) Validate.fail('E_VALIDATION', 'Period must be ANY or a month like 2026-10', 'period');
  const direction = p.direction || 'HIGHER_BETTER';
  if (['HIGHER_BETTER', 'LOWER_BETTER'].indexOf(direction) === -1) Validate.fail('E_VALIDATION', 'Direction must be HIGHER_BETTER or LOWER_BETTER', 'direction');
  const whole = function (v, field) {
    if (v === '' || v === null || v === undefined) return '';
    if (!Number.isSafeInteger(Number(v))) Validate.fail('E_VALIDATION', 'Enter a whole number', field);
    return Number(v);
  };
  const rows = existingRows || [];
  const same = rows.filter(function (r) { return r.kpi === kpi && (r.brand || 'ALL') === brand && (r.period || 'ANY') === period && r.id !== p.id; });
  if (same.length) Validate.fail('E_VALIDATION', 'There is already a target for ' + kpi + ' / ' + brand + ' / ' + period + ' (' + same[0].id + ')', 'kpi');
  let id = p.id ? String(p.id) : '';
  if (id && !rows.some(function (r) { return r.id === id; })) Validate.fail('E_NOT_FOUND', 'Target ' + id + ' not found', 'id');
  if (!id) {
    const max = rows.reduce(function (m, r) { const n = Number(String(r.id).replace(/^KT-/, '')); return Number.isFinite(n) && n > m ? n : m; }, 0);
    id = 'KT-' + String(max + 1).padStart(3, '0');
  }
  return { id: id, kpi: kpi, brand: brand, period: period, target: whole(p.target, 'target') === '' ? 0 : whole(p.target, 'target'), amberAt: whole(p.amberAt, 'amberAt'), redAt: whole(p.redAt, 'redAt'), direction: direction, notes: String(p.notes || '') };
}

if (typeof module !== 'undefined') module.exports = {
  TABS, TAB_LABEL, PERIODS, COMPARES, TAB_DATA, NEEDS_JOB_LINES, TARGET_KEYS, DAILY_FIELDS,
  addMonths, monthsBetween, lastMonths, monthEnd, fiscalYearStart, periodRange, compareRange, monthAligned,
  summaryKey, summarizeLines, mergeSummary, summaryDrift, dailyKey, dailySalesRows, dailySalesDrift,
  targetFor, ragOf, dashboard, filterForRole, forecast, prepareTarget,
};
