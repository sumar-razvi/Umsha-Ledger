// core/export.js: the QuickBooks Online journal export (M8.7, docs/05 Export).
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.
//
// One row per journal line. Accounts map through Accounts.qbAccountName and
// brands to QuickBooks classes. If any account used has no QuickBooks name,
// no file is produced and the accounts are listed instead.
// TODO(decision-D-15): headers and date format follow the documented
// QuickBooks Online "Journal entries" import; check them against the
// template downloaded from the accountant's QuickBooks before first use.

const Money = require('./money.js');
const Csv = require('./csv.js');

const QB_HEADERS = ['Journal No.', 'Journal Date', 'Account', 'Debits', 'Credits', 'Description', 'Name', 'Class', 'Currency'];
const QB_CLASS = { UMSHA: 'UMSHA', MIRAE: 'Mirae', SHARED: 'Shared' };

function qbDate(iso, format) {
  const y = iso.slice(0, 4); const m = iso.slice(5, 7); const d = iso.slice(8, 10);
  if (format === 'MM/DD/YYYY') return m + '/' + d + '/' + y;
  if (format === 'YYYY-MM-DD') return iso;
  return d + '/' + m + '/' + y;
}

// journals: Journal rows; lines: JournalLines rows; accountsByCode from
// Validate.indexAccounts; contacts: {id: row}. opts: {from, to, dateFormat, currency}.
function quickbooksJournals(journals, lines, accountsByCode, contacts, opts) {
  const o = opts || {};
  const inRange = {};
  journals.forEach(function (j) { if ((!o.from || j.date >= o.from) && (!o.to || j.date <= o.to)) inRange[j.id] = j; });
  const chosen = lines.filter(function (l) { return inRange[l.jeId]; });
  const unmapped = {};
  chosen.forEach(function (l) {
    const a = accountsByCode[l.accountCode];
    if (!a || !a.qbAccountName) unmapped[l.accountCode] = a ? a.name : '(unknown account)';
  });
  const unmappedAccounts = Object.keys(unmapped).sort().map(function (c) { return { code: c, name: unmapped[c] }; });
  let debits = 0;
  let credits = 0;
  const rows = chosen.map(function (l) {
    const j = inRange[l.jeId];
    debits += l.debitPaisa || 0;
    credits += l.creditPaisa || 0;
    const a = accountsByCode[l.accountCode] || {};
    const c = l.contactId && contacts ? contacts[l.contactId] : null;
    return {
      'Journal No.': l.jeId, 'Journal Date': qbDate(j.date, o.dateFormat), 'Account': a.qbAccountName || '',
      'Debits': l.debitPaisa ? Money.toRupeeString(l.debitPaisa) : '', 'Credits': l.creditPaisa ? Money.toRupeeString(l.creditPaisa) : '',
      'Description': l.memo || j.memo || (j.docType + ' ' + (j.docId || '')).trim(), 'Name': c ? c.name : '',
      'Class': QB_CLASS[l.brand] || '', 'Currency': o.currency || 'PKR',
    };
  });
  const name = 'umsha-journals-' + (o.from || 'start') + '-to-' + (o.to || 'end') + '.csv';
  return {
    filename: name, rowCount: rows.length, journalCount: Object.keys(inRange).length, debitsPaisa: debits, creditsPaisa: credits,
    unmappedAccounts: unmappedAccounts, csv: unmappedAccounts.length ? '' : Csv.toCsv(rows, QB_HEADERS),
  };
}

if (typeof module !== 'undefined') module.exports = {
  QB_HEADERS,
  QB_CLASS,
  quickbooksJournals,
};
