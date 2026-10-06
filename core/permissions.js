// core/permissions.js: who may call which API action (docs/05-api-contract.md).
// The server checks this on every request; hiding buttons in the UI is cosmetic.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.

const Validate = require('./validate.js');

const ROLES = ['OWNER', 'FINANCE', 'STUDIO', 'STORE', 'VIEWER'];
const ROLE_LETTER = { O: 'OWNER', F: 'FINANCE', S: 'STUDIO', T: 'STORE', V: 'VIEWER' };
const ROLE_LABEL = { OWNER: 'Owner', FINANCE: 'Finance', STUDIO: 'Studio', STORE: 'Store', VIEWER: 'Viewer' };

// action: [roles as letters, isWrite]
const MATRIX = {
  'session.me': ['OFSTV', false],
  'setup.run': ['O', true],
  'settings.update': ['O', true],
  'users.list': ['O', false],
  'users.upsert': ['O', true],
  'periods.list': ['OFV', false],
  'periods.close': ['O', true],
  'periods.reopen': ['O', true],
  'periods.checklist': ['OF', false],
  'year.close': ['O', true],

  'contacts.search': ['OFST', false],
  'contacts.get': ['OFST', false],
  'contacts.upsert': ['OFST', true],
  'items.search': ['OFSTV', false],
  'items.get': ['OFSTV', false],
  'items.upsert': ['OFS', true],
  'accounts.upsert': ['OF', true],
  'accounts.deactivate': ['OF', true],
  'accounts.list': ['OFV', false],
  'taxCodes.upsert': ['O', true],
  'taxCodes.list': ['OF', false],

  'jobs.list': ['OFSV', false],
  'jobs.get': ['OFSV', false],
  'jobs.create': ['OFS', true],
  'jobs.update': ['OFS', true],
  'jobs.issueStock': ['OFS', true],
  'jobs.returnStock': ['OFS', true],
  'jobs.deliver': ['OFS', true],
  'jobs.completeBatch': ['OFS', true],
  'jobs.cancel': ['OF', true],

  'payments.receiveAdvance': ['OFST', true],
  'payments.receive': ['OFST', true],
  'sale.create': ['OFT', true],
  'sale.return': ['OFT', true],
  'sale.exchange': ['OFT', true],
  'sales.list': ['OFT', false],
  'sales.get': ['OFT', false],
  'cashup.submit': ['OFT', true],
  'cashup.preview': ['OFT', false],
  'invoices.get': ['OFSV', false],
  'invoices.list': ['OFSV', false],
  'receipts.render': ['OFST', false],

  'bills.create': ['OFS', true],
  'bills.list': ['OFV', false],
  'bills.get': ['OFV', false],
  'karigar.logWork': ['OFS', true],
  'vendors.list': ['OFSV', false],
  'attachments.upload': ['OFST', true],
  'attachments.get': ['OFSTV', false],
  'payments.pay': ['OF', true],
  'expenses.create': ['OFT', true],
  'payments.vendorAdvance': ['OF', true],

  'transfers.create': ['OF', true],
  'settlements.create': ['OF', true],
  'bankrec.import': ['OF', true],
  'bankrec.match': ['OF', true],
  'bankrec.list': ['OFV', false],
  'bankrec.get': ['OFV', false],
  'tax.settleSalesTax': ['OF', true],
  'tax.depositWht': ['OF', true],

  'journal.create': ['OF', true],
  'journal.reverse': ['OF', true],
  'journal.get': ['OFV', false],
  'journal.list': ['OFV', false],
  'ledger.account': ['OFV', false],

  'stock.count.create': ['OFST', true],
  'stock.count.post': ['OFST', true],
  'stock.valuation': ['OFV', false],
  'stock.movements': ['OFSV', false],

  'reports.pnl': ['OFV', false],
  'reports.balanceSheet': ['OFV', false],
  'reports.trialBalance': ['OFV', false],
  'reports.jobProfitability': ['OFSV', false],
  'reports.skuMargin': ['OFV', false],
  'reports.arAgeing': ['OFV', false],
  'reports.apAgeing': ['OFV', false],
  'reports.cashPosition': ['OFV', false],
  'reports.salesTax': ['OFV', false],
  'reports.whtRegister': ['OFV', false],
  'reports.dailySales': ['OFVT', false],
  'reports.auditLog': ['OFV', false],

  'export.quickbooksJournals': ['OFV', false],
  'export.table': ['OF', false],
  'backup.now': ['O', true],

  'dashboard.get': ['OFST', false],
  'kpiTargets.list': ['O', false],
  'kpiTargets.upsert': ['O', true],
  'summaries.rebuild': ['O', true],
};

// Dashboard tabs (docs/10) and the roles that see each.
const DASHBOARD_TABS = {
  OVERVIEW: 'OF', CASH: 'OF', UMSHA: 'OFS', MIRAE: 'OFT', OPERATIONS: 'OFS', CUSTOMERS: 'OF', CONTROLS: 'OF',
};

function rolesFor(letters) {
  return letters.split('').map(function (l) { return ROLE_LETTER[l]; });
}

function knownAction(action) {
  return Object.prototype.hasOwnProperty.call(MATRIX, action);
}

function isWrite(action) {
  return knownAction(action) && MATRIX[action][1];
}

function denied(role) {
  Validate.fail('E_ROLE', 'Your role (' + (ROLE_LABEL[role] || role) + ') cannot do this');
}

// Throws E_ROLE unless user ({role, store}) may run action with payload.
// lookups (optional): {accountsByCode, contacts} for the payload-dependent rules.
function check(user, action, payload, lookups) {
  if (!knownAction(action)) Validate.fail('E_VALIDATION', 'Unknown action ' + action, 'action');
  const role = user && user.role;
  if (ROLES.indexOf(role) === -1) denied(role);
  if (rolesFor(MATRIX[action][0]).indexOf(role) === -1) denied(role);
  const p = payload || {};
  const l = lookups || {};

  // Store staff add and edit customers only.
  if (action === 'contacts.upsert' && role === 'STORE') {
    const existing = p.id && l.contacts ? l.contacts[p.id] : null;
    if (p.kind !== 'CUSTOMER' || (existing && existing.kind !== 'CUSTOMER')) denied(role);
  }
  // Studio enters bills for job costs only.
  if (action === 'bills.create' && role === 'STUDIO') {
    if (!(p.lines || []).every(function (x) { return x.lineKind === 'JOB'; })) denied(role);
  }
  // Store pays expenses out of petty cash only, and never drawings.
  if (action === 'expenses.create' && role === 'STORE') {
    const a = l.accountsByCode && l.accountsByCode[String(p.moneyAccountCode)];
    if (p.isDrawings || !a || a.moneyKind !== 'PETTY') denied(role);
  }
  // Store sees its own store's day only.
  if (action === 'reports.dailySales' && role === 'STORE' && p.store !== user.store) denied(role);
  if (action === 'dashboard.get') {
    const tab = String(p.tab || '').toUpperCase();
    if (!DASHBOARD_TABS[tab]) Validate.fail('E_VALIDATION', 'Unknown dashboard tab ' + p.tab, 'tab');
    if (rolesFor(DASHBOARD_TABS[tab]).indexOf(role) === -1) denied(role);
  }
  return true;
}

if (typeof module !== 'undefined') module.exports = {
  ROLES,
  ROLE_LABEL,
  MATRIX,
  DASHBOARD_TABS,
  knownAction,
  isWrite,
  check,
};
