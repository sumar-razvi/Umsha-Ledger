// Summaries.gs: the dashboard caches MonthlySummary and DailySales (M10).
// Both are rebuildable from the ledger and Sales. Every write folds its own
// journal lines and sales into them inside the same lock (Api.handle), and
// the nightly job rebuilds them in full and logs any drift.

var Summaries = {
  // Called by Api.handle just before commit, with the transaction's rows.
  apply: function (tx) {
    Summaries.applyMonthly_(tx);
    Summaries.applyDaily_(tx);
  },

  applyMonthly_: function (tx) {
    var lines = tx.appends.JournalLines || [];
    if (!lines.length) return;
    var closing = {};
    (tx.appends.Journal || []).forEach(function (j) { closing[j.id] = Validate.isTrue(j.isClosing); });
    var delta = Kpis.summarizeLines(lines.map(function (l) { return Object.assign({}, l, { isClosing: !!closing[l.jeId] }); }));
    var merged = Kpis.mergeSummary(Db.read('MonthlySummary'), delta);
    merged.updates.forEach(function (u) {
      tx.updateWhere('MonthlySummary', function (row) { return row === u.row; }, u.fields);
    });
    tx.append('MonthlySummary', merged.appends);
  },

  // Fold this transaction's sales into DailySales: new sales add their
  // rows; a sale voided here (reversal) takes its rows away again.
  applyDaily_: function (tx) {
    var newSales = tx.appends.Sales || [];
    var voided = (tx.updates.Sales || []).filter(function (u) { return u.id && u.fields.status === 'VOID'; }).map(function (u) { return u.id; });
    if (!newSales.length && !voided.length) return;
    var codes = Summaries.clearingCodes_();
    var delta = Kpis.dailySalesRows(newSales, tx.appends.SaleLines || [], tx.appends.SalePayments || [], codes);
    if (voided.length) {
      var gone = {};
      voided.forEach(function (id) { gone[id] = true; });
      var sales = Db.read('Sales').filter(function (x) { return gone[x.id] && x.status !== 'VOID'; });
      var minus = Kpis.dailySalesRows(sales, Db.read('SaleLines').filter(function (l) { return gone[l.saleId]; }), Db.read('SalePayments').filter(function (x) { return gone[x.saleId]; }), codes);
      minus.forEach(function (r) { Kpis.DAILY_FIELDS.forEach(function (f) { r[f] = -r[f]; }); });
      delta = delta.concat(minus);
    }
    var byKey = {};
    delta.forEach(function (d) {
      var k = Kpis.dailyKey(d);
      if (!byKey[k]) { byKey[k] = { date: d.date, store: d.store, channel: d.channel }; Kpis.DAILY_FIELDS.forEach(function (f) { byKey[k][f] = 0; }); }
      Kpis.DAILY_FIELDS.forEach(function (f) { byKey[k][f] += d[f]; });
    });
    Db.read('DailySales').forEach(function (row) {
      var d = byKey[Kpis.dailyKey(row)];
      if (!d) return;
      var fields = {};
      Kpis.DAILY_FIELDS.forEach(function (f) { fields[f] = (row[f] || 0) + d[f]; });
      tx.updateWhere('DailySales', function (r) { return r === row; }, fields);
      delete byKey[Kpis.dailyKey(row)];
    });
    tx.append('DailySales', Object.keys(byKey).sort().map(function (k) { return byKey[k]; }));
  },

  clearingCodes_: function () {
    return Db.read('Accounts').filter(function (a) { return a.isMoney && a.moneyKind === 'CLEARING' && a.systemKey !== 'STORE_CREDIT'; }).map(function (a) { return a.code; });
  },

  // Full rebuild from the ledger and Sales: {monthly, daily} rows.
  build: function () {
    var closing = {};
    Db.readColumns('Journal', ['id', 'isClosing']).forEach(function (j) { closing[j.id] = j.isClosing; });
    var lines = Db.readColumns('JournalLines', ['jeId', 'date', 'accountCode', 'brand', 'debitPaisa', 'creditPaisa']).map(function (l) {
      l.isClosing = !!closing[l.jeId];
      return l;
    });
    return {
      monthly: Kpis.summarizeLines(lines),
      daily: Kpis.dailySalesRows(Db.read('Sales'), Db.read('SaleLines'), Db.read('SalePayments'), Summaries.clearingCodes_()),
    };
  },

  // Compare the stored caches with a rebuild, then replace them.
  // Returns {monthlyDrift[], dailyDrift[], monthlyRows, dailyRows}.
  rebuild: function () {
    var built = Summaries.build();
    var out = {
      monthlyDrift: Kpis.summaryDrift(Db.read('MonthlySummary'), built.monthly),
      dailyDrift: Kpis.dailySalesDrift(Db.read('DailySales'), built.daily),
      monthlyRows: built.monthly.length,
      dailyRows: built.daily.length,
    };
    Db.rewrite('MonthlySummary', built.monthly);
    Db.rewrite('DailySales', built.daily);
    return out;
  },
};

// Loading what a dashboard tab needs, and caching the result for 5 minutes.
var Dashboard = {
  CACHE_SECONDS: 300,

  get: function (p, env) {
    var tab = p.tab || 'OVERVIEW';
    var user = env.user;
    var opts = { tab: tab, today: env.today, period: p.period || 'MTD', from: p.from, to: p.to, brand: p.brand || 'ALL', compareTo: p.compareTo || 'PREVIOUS', role: user.role, store: user.role === 'STORE' ? user.store : '' };
    var cache = CacheService.getScriptCache();
    var key = 'dash:' + Cache.version() + ':' + [user.role, opts.store, tab, opts.period, opts.from || '', opts.to || '', opts.brand, opts.compareTo, opts.today].join('|');
    var hit = cache.get(key);
    if (hit) {
      var cached = JSON.parse(hit);
      cached.cached = true;
      return cached;
    }
    var result = Kpis.filterForRole(Kpis.dashboard(Dashboard.load_(tab, opts), opts), user);
    result.asOf = Dates.karachiTimestamp();
    var json = JSON.stringify(result);
    if (json.length < 90000) cache.put(key, json, Dashboard.CACHE_SECONDS);
    return result;
  },

  load_: function (tab, opts) {
    var data = {
      acc: Validate.indexAccounts(Db.read('Accounts')),
      settings: Db.settings(),
      targets: Db.read('KpiTargets'),
      monthly: Db.read('MonthlySummary'),
    };
    // Store staff never see cost figures, so their Mirae tab skips the stock and cost tabs.
    var tabs = opts.role === 'STORE' ? ['DailySales', 'Sales', 'SalePayments', 'CashUps'] : Kpis.TAB_DATA[tab];
    tabs.forEach(function (name) {
      data[name.charAt(0).toLowerCase() + name.slice(1)] = Db.read(name);
    });
    // Periods that do not follow month boundaries need the lines themselves.
    var range = Kpis.periodRange(opts.period, opts.today, { fyStartMonth: Number(data.settings.fiscalYearStartMonth) || 7, from: opts.from, to: opts.to });
    var cmp = Kpis.compareRange(range, opts.compareTo);
    var needLines = !Kpis.monthAligned(range, opts.today) || (cmp && !Kpis.monthAligned(cmp, opts.today));
    var needJobs = Kpis.NEEDS_JOB_LINES.indexOf(tab) >= 0;
    if (needLines || needJobs) {
      var closing = {};
      Db.readColumns('Journal', ['id', 'isClosing']).forEach(function (j) { closing[j.id] = j.isClosing; });
      var cols = ['jeId', 'date', 'accountCode', 'brand', 'debitPaisa', 'creditPaisa'].concat(needJobs ? ['contactId', 'jobId'] : []);
      var all = Db.readColumns('JournalLines', cols);
      all.forEach(function (l) { l.isClosing = !!closing[l.jeId]; });
      if (needLines) data.lines = all;
      if (needJobs) data.jobLines = all.filter(function (l) { return l.jobId && !l.isClosing; });
    }
    return data;
  },
};
