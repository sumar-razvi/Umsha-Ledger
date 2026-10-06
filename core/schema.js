// core/schema.js: every Google Sheets tab and its columns (docs/04-data-model.md),
// and how each column's values are written to and read from cells.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.
//
// Sheets converts what you type: "2026-10-01" becomes a date, "1100" a
// number, "TRUE" a boolean. So every text column is formatted as plain text
// ('@') by Setup, and Db converts cells by column type on the way in and out.

const DOC_HEADER = ['id', 'date', 'contactId', 'brand', 'status', 'memo', 'jeId', 'attachmentIds', 'requestId', 'createdBy', 'createdAt'];

const TABS = {
  Settings: { key: 'key', columns: ['key', 'value'] },
  Users: { columns: ['id', 'email', 'name', 'role', 'store', 'isActive', 'createdAt'] },
  Accounts: { columns: ['id', 'code', 'name', 'type', 'subType', 'normalBalance', 'isContra', 'systemKey', 'defaultBrand', 'isMoney', 'moneyKind', 'qbAccountName', 'isActive', 'sortOrder'] },
  TaxCodes: { key: null, columns: ['id', 'name', 'kind', 'rateBps', 'claimable', 'whtBase', 'appliesTo', 'vendorFilerStatus', 'effectiveFrom', 'effectiveTo', 'isActive', 'notes'] },
  Periods: { columns: ['id', 'startDate', 'endDate', 'status', 'closedBy', 'closedAt', 'reopenReason'] },
  Sequences: { columns: ['id', 'next'] },

  Contacts: { columns: ['id', 'kind', 'name', 'phone', 'email', 'city', 'address', 'cnic', 'ntn', 'strn', 'filerStatus', 'vendorType', 'whtTaxCodeId', 'defaultBrand', 'openingBalancePaisa', 'notes', 'isActive', 'createdBy', 'createdAt'] },
  Items: { columns: ['id', 'category', 'name', 'unit', 'style', 'size', 'colour', 'collection', 'barcode', 'salePricePaisa', 'taxCodeId', 'reorderLevel', 'isActive', 'createdAt'] },
  ItemBalances: { key: 'itemId', columns: ['itemId', 'qty', 'avgCostMicro', 'valuePaisa', 'lastMoveId', 'updatedAt'] },

  Jobs: { columns: ['id', 'type', 'brand', 'contactId', 'title', 'description', 'quotedPricePaisa', 'taxCodeId', 'bookedDate', 'promisedDate', 'deliveredDate', 'status', 'revenueAccount', 'invoiceId', 'collection', 'notes', 'budgetCostPaisa', 'createdBy', 'createdAt'] },
  JobLines: { columns: ['id', 'jobId', 'description', 'itemId', 'qty', 'unitPricePaisa', 'discountPaisa', 'weight', 'sortOrder'] },

  Invoices: { columns: DOC_HEADER.concat(['jobId', 'dueDate', 'netPaisa', 'taxPaisa', 'grossPaisa', 'taxCodeId', 'taxOverrideReason', 'advanceAppliedPaisa', 'paidPaisa', 'balancePaisa']) },
  InvoiceLines: { columns: ['id', 'invoiceId', 'description', 'itemId', 'qty', 'unitPricePaisa', 'discountPaisa', 'netPaisa', 'revenueAccount'] },
  Sales: { columns: DOC_HEADER.concat(['kind', 'channel', 'store', 'netPaisa', 'taxPaisa', 'grossPaisa', 'discountPaisa', 'pricesIncludeTax', 'fbrInvoiceNo', 'originalSaleId']) },
  SaleLines: { columns: ['id', 'saleId', 'itemId', 'qty', 'unitPricePaisa', 'discountPaisa', 'netPaisa', 'taxPaisa', 'unitCostMicro', 'costPaisa', 'restock', 'returnedQty', 'returnedNetPaisa', 'returnedTaxPaisa', 'returnedCostPaisa', 'originalLineId'] },
  SalePayments: { columns: ['id', 'saleId', 'method', 'accountCode', 'amountPaisa', 'reference'] },
  Bills: { columns: DOC_HEADER.concat(['vendorRef', 'dueDate', 'netPaisa', 'taxPaisa', 'grossPaisa', 'paidPaisa', 'whtPaisa', 'balancePaisa']) },
  BillLines: { columns: ['id', 'billId', 'lineKind', 'accountCode', 'itemId', 'qty', 'unitCostPaisa', 'jobId', 'costComponent', 'brand', 'taxCodeId', 'netPaisa', 'taxPaisa', 'description'] },
  Payments: { columns: DOC_HEADER.concat(['direction', 'kind', 'moneyAccountCode', 'amountPaisa', 'whtPaisa', 'whtTaxCodeId', 'currency', 'fxAmount', 'fxRate', 'reference']) },
  PaymentAllocations: { columns: ['id', 'paymentId', 'docType', 'docId', 'amountPaisa', 'whtPaisa'] },
  StockMoves: { appendOnly: true, columns: ['id', 'date', 'itemId', 'qty', 'unitCostMicro', 'valuePaisa', 'moveType', 'docType', 'docId', 'jobId', 'sourceMoveId', 'jeId', 'createdAt'] },
  StockCounts: { columns: ['id', 'date', 'location', 'status', 'jeId', 'createdBy', 'createdAt'] },
  StockCountLines: { columns: ['id', 'countId', 'itemId', 'systemQty', 'countedQty', 'diffQty', 'valuePaisa'] },
  CashUps: { columns: ['id', 'date', 'store', 'expectedCashPaisa', 'countedCashPaisa', 'diffPaisa', 'expectedCardPaisa', 'notes', 'jeId', 'createdBy', 'createdAt'] },
  BankRecs: { columns: ['id', 'accountCode', 'statementDate', 'statementBalancePaisa', 'status'] },
  BankStatementLines: { columns: ['id', 'recId', 'date', 'description', 'amountPaisa', 'matchedJeLineId'] },

  // Ledger: append-only (invariant 3). Only the listed columns may ever be
  // written after posting, and only from empty to a value.
  Journal: { appendOnly: true, updatable: ['reversedByJeId'], columns: ['id', 'date', 'docType', 'docId', 'memo', 'isManual', 'isClosing', 'reversesJeId', 'reversedByJeId', 'requestId', 'createdBy', 'createdAt'] },
  JournalLines: { appendOnly: true, updatable: ['reconciled', 'reconciledDate'], columns: ['id', 'jeId', 'date', 'accountCode', 'brand', 'debitPaisa', 'creditPaisa', 'contactId', 'jobId', 'itemId', 'qty', 'costComponent', 'currency', 'fxAmount', 'fxRate', 'lateCost', 'reconciled', 'reconciledDate', 'memo'] },

  AuditLog: { appendOnly: true, columns: ['id', 'ts', 'userEmail', 'action', 'docType', 'docId', 'requestId', 'summary', 'before', 'after'] },
  Requests: { key: 'requestId', columns: ['requestId', 'action', 'userEmail', 'ts', 'responseJson'] },
  Attachments: { columns: ['id', 'docType', 'docId', 'driveFileId', 'fileName', 'mimeType', 'uploadedBy', 'uploadedAt'] },
};

// Tab order for Setup (and for people browsing the Sheet).
const TAB_ORDER = Object.keys(TABS);

const DECIMAL_COLUMNS = ['qty', 'systemQty', 'countedQty', 'diffQty', 'returnedQty', 'fxAmount', 'fxRate', 'weight', 'reorderLevel'];
const INT_COLUMNS = ['next', 'sortOrder'];
const BOOL_COLUMNS = ['claimable', 'lateCost', 'reconciled', 'restock', 'pricesIncludeTax'];
const JSON_COLUMNS = ['attachmentIds', 'before', 'after', 'responseJson'];

// 'TEXT' | 'INT' | 'DECIMAL' | 'BOOL' | 'JSON'
function columnType(name) {
  if (/Paisa$|Bps$|Micro$/.test(name) || INT_COLUMNS.indexOf(name) >= 0) return 'INT';
  if (DECIMAL_COLUMNS.indexOf(name) >= 0) return 'DECIMAL';
  if (/^is[A-Z]/.test(name) || BOOL_COLUMNS.indexOf(name) >= 0) return 'BOOL';
  if (JSON_COLUMNS.indexOf(name) >= 0) return 'JSON';
  return 'TEXT';
}

// Number format Setup gives each column: '@' (plain text) or '0' (integer).
// DECIMAL and BOOL columns keep Sheets' automatic format.
function numberFormat(name) {
  const t = columnType(name);
  if (t === 'TEXT' || t === 'JSON') return '@';
  if (t === 'INT') return '0';
  return null;
}

function blank(v) {
  return v === undefined || v === null || v === '';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// A value about to be written to a cell.
function toCell(name, v) {
  const t = columnType(name);
  if (t === 'TEXT') {
    if (blank(v)) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  if (t === 'JSON') {
    if (v === undefined || v === null || v === '') return '';
    return JSON.stringify(v);
  }
  if (t === 'BOOL') {
    if (blank(v)) return false;
    return v === true || String(v).toUpperCase() === 'TRUE';
  }
  if (blank(v)) return '';
  const n = Number(v);
  if (!Number.isFinite(n) || (t === 'INT' && !Number.isSafeInteger(n))) {
    const err = new Error('Column ' + name + ' needs a ' + (t === 'INT' ? 'whole number' : 'number') + ', got ' + v);
    err.code = 'E_VALIDATION';
    err.field = name;
    throw err;
  }
  return n;
}

// A value read from a cell, back to what the core expects.
function fromCell(name, v) {
  const t = columnType(name);
  if (t === 'TEXT') {
    if (v instanceof Date) {
      // A date Sheets converted despite the text format: back to YYYY-MM-DD
      // in the sheet's zone (Asia/Karachi, UTC+5).
      const d = new Date(v.getTime() + 5 * 3600000);
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    return blank(v) ? '' : String(v);
  }
  if (t === 'JSON') {
    if (blank(v)) return '';
    try { return JSON.parse(v); } catch (e) { return v; }
  }
  if (t === 'BOOL') return v === true || String(v).toUpperCase() === 'TRUE';
  if (blank(v)) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

// Object -> row array in `header` order (header comes from the live sheet,
// so column order in the Sheet can change; names cannot).
function toRow(header, obj) {
  return header.map(function (h) { return toCell(h, obj[h]); });
}

function fromRow(header, row) {
  const o = {};
  header.forEach(function (h, i) { if (h) o[h] = fromCell(h, row[i]); });
  return o;
}

function keyOf(tab) {
  const def = TABS[tab];
  if (!def) return null;
  return def.key === undefined ? 'id' : def.key;
}

if (typeof module !== 'undefined') module.exports = {
  TABS,
  TAB_ORDER,
  DOC_HEADER,
  columnType,
  numberFormat,
  toCell,
  fromCell,
  toRow,
  fromRow,
  keyOf,
};
