// core/bankrec.js: bank statement import and reconciliation (M8).
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.
//
// A statement line is {date, description, amountPaisa} with money in as
// positive and money out as negative, the same sign as the bank account's
// ledger (debit - credit).

const Money = require('./money.js');
const Validate = require('./validate.js');
const Csv = require('./csv.js');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MMM-YYYY'];

function pad(n) { return String(n).padStart(2, '0'); }

// A statement date in the bank's format to YYYY-MM-DD.
function parseStatementDate(text, format) {
  const t = String(text).trim();
  let y; let m; let d;
  let r;
  if (format === 'YYYY-MM-DD' && (r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((format === 'DD/MM/YYYY' || format === 'MM/DD/YYYY') && (r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(t))) {
    y = +r[3] < 100 ? 2000 + +r[3] : +r[3];
    if (format === 'DD/MM/YYYY') { d = +r[1]; m = +r[2]; } else { m = +r[1]; d = +r[2]; }
  } else if (format === 'DD-MMM-YYYY' && (r = /^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2,4})/.exec(t))) {
    d = +r[1]; m = MONTHS[r[2].toLowerCase()]; y = +r[3] < 100 ? 2000 + +r[3] : +r[3];
  } else {
    Validate.fail('E_VALIDATION', 'Could not read the date "' + t + '" as ' + format, 'dateFormat');
  }
  return Validate.checkDate(y + '-' + pad(m) + '-' + pad(d), 'date');
}

// Read a statement CSV with a column mapping:
// {dateColumn, dateFormat, descriptionColumn, amountColumn} or, for banks
// that split money in and out, {..., debitColumn, creditColumn}
// (debit = money out of the account). Column names match the header row.
function parseStatement(csvText, mapping) {
  const mp = mapping || {};
  if (DATE_FORMATS.indexOf(mp.dateFormat) === -1) Validate.fail('E_VALIDATION', 'Choose the date format the bank uses', 'dateFormat');
  const rows = Csv.parseRows(csvText);
  const headerAt = rows.findIndex(function (r) { return r.map(function (c) { return c.trim(); }).indexOf(mp.dateColumn) >= 0; });
  if (headerAt === -1) Validate.fail('E_VALIDATION', 'No column called "' + mp.dateColumn + '" in the file', 'dateColumn');
  const header = rows[headerAt].map(function (c) { return c.trim(); });
  function col(name, field) {
    const i = header.indexOf(name);
    if (i === -1) Validate.fail('E_VALIDATION', 'No column called "' + name + '" in the file', field);
    return i;
  }
  const di = col(mp.dateColumn, 'dateColumn');
  const ti = mp.descriptionColumn ? col(mp.descriptionColumn, 'descriptionColumn') : -1;
  const ai = mp.amountColumn ? col(mp.amountColumn, 'amountColumn') : -1;
  const dri = ai === -1 ? col(mp.debitColumn, 'debitColumn') : -1;
  const cri = ai === -1 ? col(mp.creditColumn, 'creditColumn') : -1;
  const amt = function (v) { return String(v || '').trim() ? Money.parseRupees(String(v).replace(/\s*(cr|dr)\.?$/i, '')) : 0; };
  const out = [];
  rows.slice(headerAt + 1).forEach(function (r, n) {
    if (!r[di] || !String(r[di]).trim()) return; // totals and blank rows
    let a;
    try {
      a = ai >= 0 ? amt(r[ai]) : amt(r[cri]) - amt(r[dri]);
    } catch (e) {
      Validate.fail('E_VALIDATION', 'Row ' + (headerAt + n + 2) + ': ' + e.message, 'csvText');
    }
    if (ai >= 0 && mp.amountSign === 'DEBIT_POSITIVE') a = -a;
    out.push({ date: parseStatementDate(r[di], mp.dateFormat), description: ti >= 0 ? String(r[ti]).trim() : '', amountPaisa: a });
  });
  if (!out.length) Validate.fail('E_VALIDATION', 'The file has no statement lines', 'csvText');
  return out;
}

// Suggest one ledger line for each statement line: same amount, within
// `days` days, closest date first; each ledger line used at most once.
// ledgerLines: JournalLines on the bank account, not yet reconciled.
function suggestMatches(statementLines, ledgerLines, opts) {
  const days = (opts && opts.days) || 5;
  const used = {};
  const dayNo = function (iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000; };
  const out = [];
  statementLines.forEach(function (s) {
    if (s.matchedJeLineId) return;
    let best = null;
    ledgerLines.forEach(function (l) {
      if (used[l.id] || l.reconciled) return;
      const amount = (l.debitPaisa || 0) - (l.creditPaisa || 0);
      if (amount !== s.amountPaisa) return;
      const gap = Math.abs(dayNo(l.date) - dayNo(s.date));
      if (gap > days) return;
      if (!best || gap < best.gap) best = { line: l, gap: gap };
    });
    if (best) { used[best.line.id] = true; out.push({ statementLineId: s.id, jeLineId: best.line.id }); }
  });
  return out;
}

// Where a reconciliation stands. matches: [{statementLineId, jeLineId}].
// The statement balance should equal the ledger balance at the statement
// date, less ledger items the bank has not cleared yet, plus statement items
// not yet in the ledger (bank charges, profit): difference must be 0.
function reconciliationSummary(rec, statementLines, ledgerLines, matches) {
  const matchedStatement = {};
  const matchedLedger = {};
  (matches || []).forEach(function (m) { matchedStatement[m.statementLineId] = true; matchedLedger[m.jeLineId] = true; });
  statementLines.forEach(function (s) { if (s.matchedJeLineId) { matchedStatement[s.id] = true; matchedLedger[s.matchedJeLineId] = true; } });
  const to = rec.statementDate;
  let ledgerBalance = 0;
  let uncleared = 0;
  const outstanding = [];
  ledgerLines.forEach(function (l) {
    if (l.date > to) return;
    const a = (l.debitPaisa || 0) - (l.creditPaisa || 0);
    ledgerBalance += a;
    if (!l.reconciled && !matchedLedger[l.id]) { uncleared += a; outstanding.push(l); }
  });
  const unmatched = statementLines.filter(function (s) { return !matchedStatement[s.id]; });
  const notInLedger = unmatched.reduce(function (t, s) { return t + s.amountPaisa; }, 0);
  const difference = rec.statementBalancePaisa - (ledgerBalance - uncleared) - notInLedger;
  return {
    statementBalancePaisa: rec.statementBalancePaisa, ledgerBalancePaisa: ledgerBalance, unclearedPaisa: uncleared,
    notInLedgerPaisa: notInLedger, differencePaisa: difference, outstanding: outstanding, unmatchedStatement: unmatched,
    balanced: difference === 0 && unmatched.length === 0,
  };
}

if (typeof module !== 'undefined') module.exports = {
  DATE_FORMATS,
  parseStatementDate,
  parseStatement,
  suggestMatches,
  reconciliationSummary,
};
