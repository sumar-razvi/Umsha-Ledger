// Setup.gs: creates every tab in docs/04 with its header row and loads the
// seed data (Seed.gs, generated from /seed). Safe to run again: it only adds
// what is missing (tabs, columns, seed rows) and never changes or removes data.
//
// First run: open the Apps Script editor and run setupRun(). That also makes
// the account running it (the company account) the first Owner. Later runs
// can come from the app (action setup.run, Owner only).

// Editor entry point.
function setupRun() {
  return Lock.run(function () {
    Db.reset();
    var tx = Db.begin();
    var result = Setup.run(tx);
    var now = new Date();
    tx.append('AuditLog', [{
      id: tx.nextDocId('AUD', Dates.karachiDate(now)), ts: Dates.karachiTimestamp(now), userEmail: Setup.ownerEmail_(),
      action: 'setup.run', docType: 'SETUP', docId: '', requestId: '', summary: Setup.summary_(result), before: '', after: result,
    }]);
    Db.commit(tx);
    Logger.log(Setup.summary_(result));
    return result;
  });
}

var Setup = {
  run: function (tx) {
    var ss = Db.spreadsheet();
    var created = [];
    var columnsAdded = [];
    Schema.TAB_ORDER.forEach(function (tab) {
      var sh = ss.getSheetByName(tab);
      if (!sh) {
        sh = ss.insertSheet(tab);
        created.push(tab);
      }
      var added = Setup.ensureHeader_(sh, Schema.TABS[tab].columns);
      if (added.length && created.indexOf(tab) === -1) columnsAdded.push(tab + ': ' + added.join(', '));
      Setup.formatColumns_(sh);
    });
    Db.reset();

    var seeded = 0;
    seeded += Setup.seedAccounts_(tx);
    seeded += Setup.seedMissing_(tx, 'TaxCodes', SEED.tax_codes, function (r) { return r.id + '|' + r.effectiveFrom; });
    seeded += Setup.seedMissing_(tx, 'Settings', SEED.settings, function (r) { return r.key; });
    seeded += Setup.seedMissing_(tx, 'KpiTargets', SEED.kpi_targets, function (r) { return r.id; });
    var owner = Setup.seedOwner_(tx);
    if (owner) seeded++;
    // Upgrading a Sheet that already has entries: fill the dashboard caches once.
    var rebuilt = false;
    if (!Db.read('MonthlySummary').length && Db.readColumns('JournalLines', ['jeId']).length) {
      Summaries.rebuild();
      rebuilt = true;
    }
    return { created: created, columnsAdded: columnsAdded, seeded: seeded, owner: owner || '', summariesRebuilt: rebuilt };
  },

  // Write the header if the tab is empty; otherwise add missing columns at the end.
  ensureHeader_: function (sh, columns) {
    var lastCol = sh.getLastColumn();
    var current = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
    var missing = columns.filter(function (c) { return current.indexOf(c) === -1; });
    if (!missing.length) return [];
    var startCol = current.length + 1;
    var needed = current.length + missing.length;
    if (sh.getMaxColumns() < needed) sh.insertColumnsAfter(sh.getMaxColumns(), needed - sh.getMaxColumns());
    sh.getRange(1, startCol, 1, missing.length).setValues([missing]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return current.length ? missing : [];
  },

  // Plain-text format on text columns so Sheets never turns "2026-10-01"
  // into a date or "1100" into a number; integer format on amount columns.
  formatColumns_: function (sh) {
    var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
    var rows = sh.getMaxRows();
    sh.getRange(1, 1, 1, header.length).setNumberFormat('@');
    if (rows < 2) return;
    header.forEach(function (name, i) {
      var fmt = Schema.numberFormat(name);
      if (fmt) sh.getRange(2, i + 1, rows - 1, 1).setNumberFormat(fmt);
    });
  },

  seedAccounts_: function (tx) {
    var have = {};
    Db.read('Accounts').forEach(function (a) { have[a.code] = true; });
    var rows = [];
    SEED.chart_of_accounts.forEach(function (a, i) {
      if (have[a.code]) return;
      rows.push(Object.assign({}, a, { id: a.code, isActive: true, sortOrder: (i + 1) * 10 }));
    });
    if (rows.length) tx.append('Accounts', rows);
    return rows.length;
  },

  seedMissing_: function (tx, tab, seedRows, keyFn) {
    var have = {};
    Db.read(tab).forEach(function (r) { have[keyFn(r)] = true; });
    var rows = seedRows.filter(function (r) { return !have[keyFn(r)]; });
    if (rows.length) tx.append(tab, rows);
    return rows.length;
  },

  seedOwner_: function (tx) {
    if (Db.read('Users').length) return null;
    var email = Setup.ownerEmail_();
    if (!email) throw Validate.coreError('E_INTERNAL', 'Could not tell which account is running Setup');
    tx.append('Users', [{ id: tx.nextMasterId('USR'), email: email, name: 'Owner', role: 'OWNER', store: '', isActive: true, createdAt: Dates.karachiTimestamp() }]);
    return email;
  },

  ownerEmail_: function () {
    return String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  },

  summary_: function (r) {
    return 'Setup: ' + (r.created.length ? 'created ' + r.created.length + ' tabs' : 'no new tabs') +
      ', ' + r.seeded + ' seed rows added' + (r.columnsAdded.length ? ', new columns on ' + r.columnsAdded.length + ' tabs' : '');
  },
};
