// core/ids.js: human-readable, prefixed IDs. Formats are defined in docs/04-data-model.md.
// Pure: the server allocates numbers from the Sequences tab under the script lock
// and calls these functions to turn them into IDs.

const Money = require('./money.js');

const DOC_NUMBER_WIDTH = 5;
const LINE_NUMBER_WIDTH = 2;

// Year-scoped document and ledger prefixes: PREFIX-YYYY-NNNNN.
const DOC_PREFIXES = ['JE', 'INV', 'BILL', 'JOB', 'PAY', 'SALE', 'SM', 'CNT', 'CUP', 'REC', 'ATT', 'AUD'];

// Master data prefixes (not year-scoped) and their zero-pad widths.
const MASTER_WIDTHS = { CUS: 5, VEN: 5, FAM: 3, FAB: 4, TRM: 4, PKG: 4, SKU: 6, USR: 3 };

const ITEM_PREFIX_BY_CATEGORY = { FABRIC: 'FAB', TRIM: 'TRM', PACKAGING: 'PKG', SKU: 'SKU' };

function checkSequenceNumber(n) {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw Money.validationError('Sequence number must be a positive integer, got ' + n);
  }
}

function checkYear(year) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw Money.validationError('Year must be a 4-digit year, got ' + year);
  }
}

function checkPrefix(prefix, allowed) {
  if (allowed.indexOf(prefix) === -1) {
    throw Money.validationError('Unknown ID prefix: ' + prefix);
  }
}

// "2026-10-06" -> 2026. Documents are numbered by the calendar year of their
// own date (not the fiscal year, not the posting time).
// TODO(decision-D-18): switch to fiscal-year numbering if the accountant prefers it.
function yearOfDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate));
  if (!m) throw Money.validationError('Date must be YYYY-MM-DD, got ' + isoDate, 'date');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw Money.validationError('Not a real calendar date: ' + isoDate, 'date');
  }
  return year;
}

// formatDocId('INV', 2026, 42) => 'INV-2026-00042'
function formatDocId(prefix, year, n) {
  checkPrefix(prefix, DOC_PREFIXES);
  checkYear(year);
  checkSequenceNumber(n);
  return prefix + '-' + year + '-' + String(n).padStart(DOC_NUMBER_WIDTH, '0');
}

// formatMasterId('CUS', 1) => 'CUS-00001'
function formatMasterId(prefix, n) {
  checkPrefix(prefix, Object.keys(MASTER_WIDTHS));
  checkSequenceNumber(n);
  return prefix + '-' + String(n).padStart(MASTER_WIDTHS[prefix], '0');
}

// formatLineId('JE-2026-00981', 1) => 'JE-2026-00981-01'
function formatLineId(parentId, lineNo) {
  if (!parentId) throw Money.validationError('Line ID needs a parent ID');
  checkSequenceNumber(lineNo);
  return parentId + '-' + String(lineNo).padStart(LINE_NUMBER_WIDTH, '0');
}

// 'INV-2026-00042' => {prefix:'INV', year:2026, n:42}; null if not a document ID.
function parseDocId(id) {
  const m = /^([A-Z]+)-(\d{4})-(\d+)$/.exec(String(id));
  if (!m || DOC_PREFIXES.indexOf(m[1]) === -1 || m[3].length < DOC_NUMBER_WIDTH) return null;
  return { prefix: m[1], year: Number(m[2]), n: Number(m[3]) };
}

// Key of the Sequences row a document number comes from: 'INV-2026'.
function docSequenceKey(prefix, year) {
  checkPrefix(prefix, DOC_PREFIXES);
  checkYear(year);
  return prefix + '-' + year;
}

// Key of the Sequences row a master-data number comes from: 'CUS'.
function masterSequenceKey(prefix) {
  checkPrefix(prefix, Object.keys(MASTER_WIDTHS));
  return prefix;
}

// Take `count` numbers from a Sequences row whose `next` is the next unused
// number (a missing row starts at 1). Returns the numbers and the new `next`
// to write back. Must be called under the script lock.
function reserveNumbers(currentNext, count) {
  const start = currentNext === undefined || currentNext === null || currentNext === '' ? 1 : Number(currentNext);
  checkSequenceNumber(start);
  if (!Number.isInteger(count) || count < 1) {
    throw Money.validationError('Must reserve at least one number, got ' + count);
  }
  const numbers = [];
  for (let i = 0; i < count; i++) numbers.push(start + i);
  return { numbers: numbers, next: start + count };
}

if (typeof module !== 'undefined') module.exports = {
  DOC_PREFIXES,
  MASTER_WIDTHS,
  ITEM_PREFIX_BY_CATEGORY,
  yearOfDate,
  formatDocId,
  formatMasterId,
  formatLineId,
  parseDocId,
  docSequenceKey,
  masterSequenceKey,
  reserveNumbers,
};
