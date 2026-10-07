// core/dates.js: dates and timestamps in Asia/Karachi (UTC+5, no daylight
// saving), without Utilities.formatDate, so the same code runs in Node.
// Storage: dates are 'YYYY-MM-DD'; timestamps ISO 8601 with +05:00.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.

const Validate = require('./validate.js');

const KARACHI_OFFSET_MINUTES = 5 * 60;

function pad(n, w) {
  return String(n).padStart(w || 2, '0');
}

function shifted(date) {
  return new Date(date.getTime() + KARACHI_OFFSET_MINUTES * 60000);
}

// The calendar date in Karachi of a moment: 2026-10-05T20:00Z -> '2026-10-06'.
function karachiDate(date) {
  const d = shifted(date || new Date());
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

// '2026-10-06T14:05:00+05:00'
function karachiTimestamp(date) {
  const d = shifted(date || new Date());
  return karachiDate(date || new Date()) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '+05:00';
}

// Add days to an ISO date.
function addDays(isoDate, days) {
  Validate.checkDate(isoDate);
  const d = new Date(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)) + days));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

// '2026-09' -> {id, startDate: '2026-09-01', endDate: '2026-09-30'}
function periodBounds(periodId) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(periodId));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) Validate.fail('E_VALIDATION', 'Period must be YYYY-MM, got ' + periodId, 'periodId');
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { id: periodId, startDate: periodId + '-01', endDate: periodId + '-' + pad(last) };
}

// A Date read back from a sheet cell (if Sheets auto-converted text) to 'YYYY-MM-DD'.
// Sheets dates are midnight in the spreadsheet time zone (Asia/Karachi).
function sheetDateToIso(date) {
  return karachiDate(date);
}

if (typeof module !== 'undefined') module.exports = {
  karachiDate,
  karachiTimestamp,
  addDays,
  periodBounds,
  sheetDateToIso,
};
