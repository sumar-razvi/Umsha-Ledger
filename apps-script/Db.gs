// Db.gs: the only code that reads and writes the Sheet.
// - Reads a whole tab once per request with getValues() and maps rows to
//   objects by the header row (column order may change; names may not).
// - Writes go into a transaction (Db.begin) and are flushed by Db.commit in
//   one batch per tab, in a fixed order, after all checks have passed.
// - Posted ledger rows are never edited: Journal, JournalLines, StockMoves
//   and AuditLog only accept appends, apart from the link/reconciliation
//   columns listed in Schema.TABS[tab].updatable, and only from empty.

var Db = (function () {
  var ss = null;
  var cache = {};

  // Sequences first: a gap in numbering is harmless, a reused number is not.
  // Then the order in docs/05: stock, journal, lines, documents, audit, requests.
  var COMMIT_ORDER = ['Sequences', 'StockMoves', 'ItemBalances', 'Journal', 'JournalLines'];
  var COMMIT_LAST = ['AuditLog', 'Requests'];

  function spreadsheet() {
    if (!ss) {
      var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
      if (!id) throw Validate.coreError('E_INTERNAL', 'The SHEET_ID script property is not set');
      ss = SpreadsheetApp.openById(id);
    }
    return ss;
  }

  // Forget everything read so far (start of each request, and inside the lock).
  function reset() {
    cache = {};
  }

  function sheet(tab) {
    var sh = spreadsheet().getSheetByName(tab);
    if (!sh) throw Validate.coreError('E_INTERNAL', 'The ' + tab + ' tab is missing. The Owner needs to run Setup.');
    return sh;
  }

  function load(tab) {
    if (cache[tab]) return cache[tab];
    if (!Schema.TABS[tab]) throw Validate.coreError('E_INTERNAL', 'Unknown tab ' + tab);
    var sh = sheet(tab);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    var values = lastRow > 0 && lastCol > 0 ? sh.getRange(1, 1, lastRow, lastCol).getValues() : [];
    var header = values.length ? values[0].map(function (h) { return String(h).trim(); }) : [];
    var key = Schema.keyOf(tab);
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var o = Schema.fromRow(header, values[i]);
      if (key && o[key] === '') continue; // blank row
      Object.defineProperty(o, '__row', { value: i + 1, enumerable: false, writable: true });
      rows.push(o);
    }
    cache[tab] = { sheet: sh, header: header, rows: rows, index: null };
    return cache[tab];
  }

  // All rows of a tab as objects. Treat the result as read-only.
  function read(tab) {
    return load(tab).rows;
  }

  function header(tab) {
    return load(tab).header;
  }

  // Only some columns of a tab, read as one contiguous block (for the big
  // ledger tabs, when a dashboard needs a few columns of every row).
  // Returns plain objects with just those columns.
  function readColumns(tab, names) {
    var ck = 'cols:' + tab + ':' + names.join(',');
    if (cache[ck]) return cache[ck];
    if (cache[tab]) {
      cache[ck] = cache[tab].rows.map(function (r) { var o = {}; names.forEach(function (n) { o[n] = r[n]; }); return o; });
      return cache[ck];
    }
    var sh = sheet(tab);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2 || !lastCol) return (cache[ck] = []);
    var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
    var idx = names.map(function (n) {
      var i = hdr.indexOf(n);
      if (i === -1) throw Validate.coreError('E_INTERNAL', tab + ' has no column ' + n + '. The Owner needs to run Setup.');
      return i;
    });
    var lo = Math.min.apply(null, idx);
    var hi = Math.max.apply(null, idx);
    var values = sh.getRange(2, lo + 1, lastRow - 1, hi - lo + 1).getValues();
    var out = [];
    values.forEach(function (row) {
      var o = {};
      names.forEach(function (n, k) { o[n] = Schema.fromCell(n, row[idx[k] - lo]); });
      if (o[names[0]] !== '') out.push(o);
    });
    cache[ck] = out;
    return out;
  }

  // {key: row} for tabs with a key column.
  function byKey(tab) {
    var t = load(tab);
    if (!t.index) {
      var key = Schema.keyOf(tab);
      t.index = {};
      t.rows.forEach(function (r) { t.index[r[key]] = r; });
    }
    return t.index;
  }

  function get(tab, id) {
    return byKey(tab)[id] || null;
  }

  // Settings as {key: value}.
  function settings() {
    var out = {};
    read('Settings').forEach(function (r) { out[r.key] = r.value; });
    return out;
  }

  function ensureRows(sh, lastNeeded) {
    var max = sh.getMaxRows();
    if (lastNeeded > max) sh.insertRowsAfter(max, lastNeeded - max);
  }

  function appendRows(tab, objs) {
    if (!objs.length) return;
    var t = load(tab);
    var rows = objs.map(function (o) { return Schema.toRow(t.header, o); });
    var start = t.sheet.getLastRow() + 1;
    ensureRows(t.sheet, start + rows.length - 1);
    t.sheet.getRange(start, 1, rows.length, t.header.length).setValues(rows);
    rows.forEach(function (r, i) {
      var o = Schema.fromRow(t.header, r);
      Object.defineProperty(o, '__row', { value: start + i, enumerable: false, writable: true });
      t.rows.push(o);
      if (t.index) t.index[o[Schema.keyOf(tab)]] = o;
    });
  }

  // Write changed fields of an existing row, cell by cell.
  function updateRow(tab, id, fields) {
    var row = byKey(tab)[id];
    if (!row) throw Validate.coreError('E_NOT_FOUND', tab + ' ' + id + ' not found');
    updateRowObject(tab, row, fields);
  }

  function updateRowObject(tab, row, fields) {
    var t = load(tab);
    var id = row[Schema.keyOf(tab) || 'id'];
    var def = Schema.TABS[tab];
    Object.keys(fields).forEach(function (name) {
      var col = t.header.indexOf(name);
      if (col === -1) throw Validate.coreError('E_INTERNAL', tab + ' has no column ' + name + '. The Owner needs to run Setup.');
      if (def.appendOnly) {
        var allowed = (def.updatable || []).indexOf(name) >= 0;
        var empty = row[name] === '' || row[name] === false;
        if (!allowed || !empty) throw Validate.coreError('E_INTERNAL', 'Posted ' + tab + ' rows cannot be changed (' + name + ' on ' + id + ')');
      }
      var cell = Schema.toCell(name, fields[name]);
      t.sheet.getRange(row.__row, col + 1).setValue(cell);
      row[name] = Schema.fromCell(name, cell);
    });
  }

  // Replace every data row of a tab (only for caches and the Requests log).
  function rewrite(tab, objs) {
    if (Schema.TABS[tab].appendOnly) throw Validate.coreError('E_INTERNAL', tab + ' is append-only');
    var t = load(tab);
    var last = t.sheet.getLastRow();
    if (last > 1) t.sheet.getRange(2, 1, last - 1, t.header.length).clearContent();
    delete cache[tab];
    var fresh = load(tab);
    fresh.rows.length = 0;
    if (objs.length) {
      var rows = objs.map(function (o) { return Schema.toRow(fresh.header, o); });
      ensureRows(fresh.sheet, rows.length + 1);
      fresh.sheet.getRange(2, 1, rows.length, fresh.header.length).setValues(rows);
    }
    delete cache[tab];
  }

  // ---------- transactions ----------

  function begin() {
    var tx = {
      appends: {},
      updates: {},
      upserts: {},
      seq: null,
      seqTouched: {},
      append: function (tab, objs) {
        if (!Schema.TABS[tab]) throw Validate.coreError('E_INTERNAL', 'Unknown tab ' + tab);
        (tx.appends[tab] = tx.appends[tab] || []).push.apply(tx.appends[tab], objs);
      },
      // Change an existing row. (A row added in this same transaction must be
      // appended with its final values: updates are written before appends.)
      update: function (tab, id, fields) {
        if (!Schema.TABS[tab]) throw Validate.coreError('E_INTERNAL', 'Unknown tab ' + tab);
        var list = (tx.updates[tab] = tx.updates[tab] || []);
        list.push({ id: id, fields: fields });
      },
      // Update every row for which match(row) is true (tabs without a unique key).
      updateWhere: function (tab, match, fields) {
        if (!Schema.TABS[tab]) throw Validate.coreError('E_INTERNAL', 'Unknown tab ' + tab);
        (tx.updates[tab] = tx.updates[tab] || []).push({ match: match, fields: fields });
      },
      // Insert or replace by key (for caches such as ItemBalances).
      upsert: function (tab, obj) {
        var m = (tx.upserts[tab] = tx.upserts[tab] || {});
        m[obj[Schema.keyOf(tab)]] = obj;
      },
      // Reserve `count` numbers from a Sequences row (in memory until commit).
      next: function (key, count) {
        if (!tx.seq) {
          tx.seq = {};
          read('Sequences').forEach(function (r) { tx.seq[r.id] = r.next; });
        }
        var r = Ids.reserveNumbers(tx.seq[key], count || 1);
        tx.seq[key] = r.next;
        tx.seqTouched[key] = true;
        return r.numbers;
      },
      nextDocId: function (prefix, date) {
        var year = Ids.yearOfDate(date);
        return Ids.formatDocId(prefix, year, tx.next(Ids.docSequenceKey(prefix, year), 1)[0]);
      },
      nextMasterId: function (prefix) {
        return Ids.formatMasterId(prefix, tx.next(Ids.masterSequenceKey(prefix), 1)[0]);
      },
    };
    return tx;
  }

  function flushTab(tx, tab) {
    if (tab === 'Sequences') {
      var existing = byKey('Sequences');
      var fresh = [];
      Object.keys(tx.seqTouched).forEach(function (k) {
        if (existing[k]) updateRow('Sequences', k, { next: tx.seq[k] });
        else fresh.push({ id: k, next: tx.seq[k] });
      });
      appendRows('Sequences', fresh);
      return;
    }
    (tx.updates[tab] || []).forEach(function (u) {
      if (u.match) {
        load(tab).rows.filter(u.match).forEach(function (row) {
          if (Schema.TABS[tab].appendOnly) updateRowObject(tab, row, u.fields);
          else writeRowObject(tab, row, u.fields);
        });
      }
      else updateRow(tab, u.id, u.fields);
    });
    var ups = tx.upserts[tab];
    if (ups) {
      var idx = byKey(tab);
      var add = [];
      Object.keys(ups).forEach(function (k) {
        if (idx[k]) {
          var changed = {};
          load(tab).header.forEach(function (h) { if (h in ups[k] && h !== Schema.keyOf(tab)) changed[h] = ups[k][h]; });
          updateRowWhole(tab, k, changed);
        } else add.push(ups[k]);
      });
      appendRows(tab, add);
    }
    appendRows(tab, tx.appends[tab] || []);
  }

  // Rewrite a whole row in one setValues (for cache tabs, not the ledger).
  function updateRowWhole(tab, id, fields) {
    writeRowObject(tab, byKey(tab)[id], fields);
  }

  function writeRowObject(tab, row, fields) {
    var t = load(tab);
    if (Schema.TABS[tab].appendOnly) throw Validate.coreError('E_INTERNAL', tab + ' is append-only');
    var merged = {};
    t.header.forEach(function (h) { merged[h] = h in fields ? fields[h] : row[h]; });
    var values = Schema.toRow(t.header, merged);
    t.sheet.getRange(row.__row, 1, 1, t.header.length).setValues([values]);
    t.header.forEach(function (h, i) { if (h) row[h] = Schema.fromCell(h, values[i]); });
  }

  function commit(tx) {
    var tabs = {};
    Object.keys(tx.appends).concat(Object.keys(tx.updates), Object.keys(tx.upserts)).forEach(function (t) { tabs[t] = true; });
    if (Object.keys(tx.seqTouched).length) tabs.Sequences = true;
    var order = COMMIT_ORDER.filter(function (t) { return tabs[t]; });
    Object.keys(tabs).sort().forEach(function (t) {
      if (COMMIT_ORDER.indexOf(t) === -1 && COMMIT_LAST.indexOf(t) === -1) order.push(t);
    });
    COMMIT_LAST.forEach(function (t) { if (tabs[t]) order.push(t); });
    order.forEach(function (t) { flushTab(tx, t); });
    SpreadsheetApp.flush();
  }

  return {
    spreadsheet: spreadsheet,
    reset: reset,
    read: read,
    readColumns: readColumns,
    header: header,
    byKey: byKey,
    get: get,
    settings: settings,
    rewrite: rewrite,
    begin: begin,
    commit: commit,
  };
})();
