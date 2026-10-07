// core/validate.js: journal validation (the invariants in CLAUDE.md and the
// error codes in docs/03-accounting-rules.md section 5), plus the shared
// constants and lookups every other core module needs.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.

const Money = require('./money.js');

const BRANDS = ['UMSHA', 'MIRAE', 'SHARED'];
const COST_COMPONENTS = ['FABRIC', 'TRIMS', 'EMBROIDERY', 'STITCHING', 'OUTSOURCED', 'PACKAGING', 'OTHER'];
const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE', 'OTHER', 'TAX'];
const PNL_TYPES = ['REVENUE', 'COGS', 'EXPENSE', 'OTHER', 'TAX'];

// Lines on these accounts must name who/what they belong to, so control
// accounts always reconcile to their sub-ledgers (invariant 7).
const CONTACT_REQUIRED_KEYS = ['AR', 'AP', 'CUSTOMER_ADV', 'VENDOR_ADV'];
const JOB_REQUIRED_KEYS = ['WIP'];
const INVENTORY_KEYS = ['INV_FABRIC', 'INV_TRIMS', 'INV_PACKAGING', 'INV_FG'];

// An error the API returns as {ok:false, code, message}.
function coreError(code, message, field) {
  const err = new Error(message);
  err.code = code;
  if (field) err.field = field;
  return err;
}

function fail(code, message, field) {
  throw coreError(code, message, field);
}

// Sheets hand back booleans as true/'TRUE' and blanks as ''.
function isTrue(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

function isBlank(v) {
  return v === undefined || v === null || v === '';
}

function checkDate(date, field) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])) {
      return date;
    }
  }
  return fail('E_VALIDATION', (field || 'date') + ' must be a real date as YYYY-MM-DD, got ' + date, field || 'date');
}

function periodIdOf(date) {
  return checkDate(date).slice(0, 7);
}

// periods: array of Periods rows {id: 'YYYY-MM', status} or a map id -> row.
function isPeriodLocked(periods, date) {
  if (!periods) return false;
  const id = periodIdOf(date);
  const row = Array.isArray(periods)
    ? periods.filter(function (p) { return p.id === id; })[0]
    : periods[id];
  return !!row && row.status === 'CLOSED';
}

// Normalise an Accounts row read from the sheet or the seed CSV.
function normaliseAccount(row) {
  return {
    code: String(row.code),
    name: row.name || '',
    type: row.type,
    subType: row.subType || '',
    normalBalance: row.normalBalance || (['ASSET', 'COGS', 'EXPENSE', 'TAX'].indexOf(row.type) >= 0 ? 'DEBIT' : 'CREDIT'),
    isContra: isTrue(row.isContra),
    systemKey: row.systemKey || '',
    defaultBrand: row.defaultBrand || 'SHARED',
    isMoney: isTrue(row.isMoney),
    moneyKind: row.moneyKind || '',
    qbAccountName: row.qbAccountName || '',
    isActive: isBlank(row.isActive) ? true : isTrue(row.isActive),
  };
}

// Build the account lookups a posting context needs:
// {accountsByCode, accountsBySystemKey}. Spread the result into ctx.
function indexAccounts(rows) {
  const byCode = {};
  const byKey = {};
  rows.forEach(function (r) {
    const a = normaliseAccount(r);
    if (ACCOUNT_TYPES.indexOf(a.type) === -1) fail('E_VALIDATION', 'Account ' + a.code + ' has unknown type ' + a.type, 'type');
    if (byCode[a.code]) fail('E_VALIDATION', 'Duplicate account code ' + a.code, 'code');
    byCode[a.code] = a;
    if (a.systemKey) {
      if (byKey[a.systemKey]) fail('E_VALIDATION', 'Two accounts have systemKey ' + a.systemKey, 'systemKey');
      byKey[a.systemKey] = a;
    }
  });
  return { accountsByCode: byCode, accountsBySystemKey: byKey };
}

function systemKeyOf(ctx, accountCode) {
  const a = ctx.accountsByCode[accountCode];
  return a ? a.systemKey : '';
}

function lineAmount(line) {
  return (line.debitPaisa || 0) - (line.creditPaisa || 0);
}

// Check an entry ({journal, lines, stockMoves, itemBalanceUpdates}) against
// every invariant that can be checked without the rest of the ledger.
// Returns a list of {code, message, field}; empty means valid.
// ctx needs accountsByCode, periods, settings; jobs is used when present.
function validateEntry(entry, ctx) {
  const errors = [];
  function err(code, message, field) { errors.push({ code: code, message: message, field: field || '' }); }
  const lines = entry.lines || [];
  const moves = entry.stockMoves || [];
  const settings = ctx.settings || {};

  if (!entry.journal) {
    if (lines.length) err('E_VALIDATION', 'Lines without a journal header');
    if (moves.some(function (m) { return m.valuePaisa !== 0; })) err('E_VALIDATION', 'Stock moves with value need a journal entry');
  } else {
    const date = entry.journal.date;
    try { checkDate(date); } catch (e) { err(e.code, e.message, 'date'); return errors; }
    if (isPeriodLocked(ctx.periods, date)) err('E_PERIOD_LOCKED', 'The period ' + periodIdOf(date) + ' is closed', 'date');
    if (lines.length < 2) err('E_VALIDATION', 'A journal entry needs at least two lines');

    let debits = 0;
    let credits = 0;
    lines.forEach(function (l, i) {
      const where = 'lines[' + i + ']';
      if (BRANDS.indexOf(l.brand) === -1) err('E_EMPTY_BRAND', 'Line ' + (i + 1) + ' has no valid brand (UMSHA, MIRAE or SHARED)', where + '.brand');
      const d = l.debitPaisa || 0;
      const c = l.creditPaisa || 0;
      if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c)) {
        err('E_VALIDATION', 'Line ' + (i + 1) + ' amounts must be whole paisa', where);
      } else if (d < 0 || c < 0 || (d > 0) === (c > 0)) {
        err('E_NEG_AMOUNT', 'Line ' + (i + 1) + ' must have either a debit or a credit above zero, not both', where);
      }
      debits += d;
      credits += c;

      const acct = ctx.accountsByCode[l.accountCode];
      if (!acct) { err('E_VALIDATION', 'Line ' + (i + 1) + ' uses unknown account ' + l.accountCode, where + '.accountCode'); return; }
      if (!acct.isActive) err('E_INACTIVE_ACCOUNT', 'Account ' + acct.code + ' ' + acct.name + ' is deactivated', where + '.accountCode');
      if (CONTACT_REQUIRED_KEYS.indexOf(acct.systemKey) >= 0 && isBlank(l.contactId)) {
        err('E_VALIDATION', 'Line ' + (i + 1) + ' on ' + acct.name + ' needs a contact', where + '.contactId');
      }
      if (JOB_REQUIRED_KEYS.indexOf(acct.systemKey) >= 0 && isBlank(l.jobId)) {
        err('E_VALIDATION', 'Line ' + (i + 1) + ' on ' + acct.name + ' needs a job', where + '.jobId');
      }
      if (INVENTORY_KEYS.indexOf(acct.systemKey) >= 0 && isBlank(l.itemId)) {
        err('E_VALIDATION', 'Line ' + (i + 1) + ' on ' + acct.name + ' needs an item', where + '.itemId');
      }
      if (!isBlank(l.costComponent) && COST_COMPONENTS.indexOf(l.costComponent) === -1) {
        err('E_VALIDATION', 'Line ' + (i + 1) + ' has unknown cost component ' + l.costComponent, where + '.costComponent');
      }
      if (ctx.jobs && !isBlank(l.jobId) && acct.systemKey === 'WIP' && d > 0) {
        const job = ctx.jobs[l.jobId];
        if (job && job.status === 'CANCELLED') err('E_JOB_CLOSED', 'Job ' + l.jobId + ' is cancelled', where + '.jobId');
      }
    });
    if (debits !== credits) {
      err('E_UNBALANCED', 'Debits ' + Money.formatPaisa(debits) + ' do not equal credits ' + Money.formatPaisa(credits));
    }
    if (debits === 0 && lines.length) err('E_VALIDATION', 'A journal entry cannot be for zero');

    // Inventory GL must move exactly with stock (invariant 7, item by item).
    const glByItem = {};
    lines.forEach(function (l) {
      const acct = ctx.accountsByCode[l.accountCode];
      if (acct && INVENTORY_KEYS.indexOf(acct.systemKey) >= 0) {
        glByItem[l.itemId] = (glByItem[l.itemId] || 0) + lineAmount(l);
      }
    });
    const stockByItem = {};
    moves.forEach(function (m) { stockByItem[m.itemId] = (stockByItem[m.itemId] || 0) + m.valuePaisa; });
    Object.keys(glByItem).concat(Object.keys(stockByItem)).forEach(function (itemId) {
      if ((glByItem[itemId] || 0) !== (stockByItem[itemId] || 0)) {
        err('E_VALIDATION', 'Inventory ledger and stock moves disagree for ' + itemId);
      }
    });
    moves.forEach(function (m) {
      if (m.date !== date) err('E_VALIDATION', 'Stock move for ' + m.itemId + ' is not dated with its journal entry');
    });
  }

  if (!isTrue(settings.allowNegativeStock)) {
    (entry.itemBalanceUpdates || []).forEach(function (b) {
      if (b.qty < 0) err('E_NEG_STOCK', 'Not enough stock of ' + b.itemId, 'qty');
    });
  }
  return errors;
}

// Throw the first validation error, if any. Returns the entry for chaining.
function assertValid(entry, ctx) {
  const errors = validateEntry(entry, ctx);
  if (errors.length) fail(errors[0].code, errors[0].message, errors[0].field);
  return entry;
}

if (typeof module !== 'undefined') module.exports = {
  BRANDS,
  COST_COMPONENTS,
  ACCOUNT_TYPES,
  PNL_TYPES,
  INVENTORY_KEYS,
  coreError,
  fail,
  isTrue,
  isBlank,
  checkDate,
  periodIdOf,
  isPeriodLocked,
  normaliseAccount,
  indexAccounts,
  systemKeyOf,
  lineAmount,
  validateEntry,
  assertValid,
};
