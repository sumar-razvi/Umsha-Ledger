// Export.gs: backups and the nightly job. The QuickBooks journal export is
// milestone M8.

var BACKUP_KEEP = 30;
var REQUESTS_KEEP_DAYS = 30;
var BACKUP_PREFIX = 'UMSHA Ledger backup ';

var Backup = {
  // Copy the whole Sheet into the backup folder (Settings.backupFolderId, or
  // My Drive) and keep the newest 30 copies.
  now: function () {
    var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    var folderId = Db.settings().backupFolderId;
    var folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
    var name = BACKUP_PREFIX + Dates.karachiTimestamp().slice(0, 16).replace('T', ' ');
    var copy = DriveApp.getFileById(sheetId).makeCopy(name, folder);
    var backups = [];
    var it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.getName().indexOf(BACKUP_PREFIX) === 0 && !f.isTrashed()) backups.push(f);
    }
    backups.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
    var trashed = 0;
    backups.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); trashed++; });
    return { fileId: copy.getId(), name: name, trashed: trashed };
  },
};

// Time-driven trigger target (installTriggers sets it for 02:00 Karachi).
function nightly() {
  var results = {};
  Lock.run(function () {
    Db.reset();
    results.backup = Backup.now();
    results.requestsPruned = pruneRequests_();
    var tx = Db.begin();
    var drift = checkItemBalances_();
    var now = new Date();
    var audit = [{ action: 'nightly', docType: 'BACKUP', docId: results.backup.fileId, summary: 'Nightly backup ' + results.backup.name + '; ' + results.requestsPruned + ' old requests pruned' }];
    drift.forEach(function (d) {
      audit.push({ action: 'nightly.drift', docType: 'ITEM', docId: d.itemId, summary: 'ItemBalances differs from StockMoves for ' + d.itemId, before: d.stored, after: d.rebuilt });
    });
    tx.append('AuditLog', audit.map(function (a) {
      return Object.assign({ id: tx.nextDocId('AUD', Dates.karachiDate(now)), ts: Dates.karachiTimestamp(now), userEmail: 'system', requestId: '', before: '', after: '' }, a);
    }));
    Db.commit(tx);
    results.drift = drift.length;
  });
  return results;
}

// The idempotency log only needs to outlive client retries.
function pruneRequests_() {
  var cutoff = Dates.addDays(Dates.karachiDate(), -REQUESTS_KEEP_DAYS);
  var rows = Db.read('Requests');
  var keep = rows.filter(function (r) { return String(r.ts).slice(0, 10) >= cutoff; });
  if (keep.length === rows.length) return 0;
  Db.rewrite('Requests', keep);
  return rows.length - keep.length;
}

// Compare the ItemBalances cache with a full rebuild from StockMoves.
function checkItemBalances_() {
  var rebuilt = Inventory.rebuildItemBalances(Db.read('StockMoves'));
  var stored = Db.byKey('ItemBalances');
  var drift = [];
  Object.keys(rebuilt).concat(Object.keys(stored)).forEach(function (id) {
    var a = rebuilt[id] || { qty: 0, avgCostMicro: 0, valuePaisa: 0 };
    var b = stored[id] || { qty: 0, avgCostMicro: 0, valuePaisa: 0 };
    if (a.qty !== b.qty || a.avgCostMicro !== b.avgCostMicro || a.valuePaisa !== b.valuePaisa) {
      if (!drift.some(function (d) { return d.itemId === id; })) {
        drift.push({ itemId: id, stored: { qty: b.qty, avgCostMicro: b.avgCostMicro, valuePaisa: b.valuePaisa }, rebuilt: { qty: a.qty, avgCostMicro: a.avgCostMicro, valuePaisa: a.valuePaisa } });
      }
    }
  });
  return drift;
}

// Run once from the editor: (re)creates the nightly trigger.
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'nightly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightly').timeBased().atHour(2).everyDays(1).inTimezone('Asia/Karachi').create();
  return 'Nightly backup scheduled for 02:00 Asia/Karachi';
}
