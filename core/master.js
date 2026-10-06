// core/master.js: checks and normalisation for master data (contacts,
// items, jobs, users) before the server writes them.
// Pure: no SpreadsheetApp, no DOM. Runs in Node and Apps Script.

const Money = require('./money.js');
const Validate = require('./validate.js');
const Inventory = require('./inventory.js');

const fail = Validate.fail;
const isBlank = Validate.isBlank;

const CONTACT_KINDS = ['CUSTOMER', 'VENDOR', 'BOTH', 'FAMILY'];
const VENDOR_TYPES = ['SUPPLIER', 'KARIGAR', 'SERVICE', 'OTHER'];
const FILER_STATUSES = ['FILER', 'NON_FILER'];
const ITEM_CATEGORIES = ['FABRIC', 'TRIM', 'PACKAGING', 'SKU'];
const ITEM_UNITS = ['M', 'PC', 'G', 'SET'];
const DEFAULT_UNIT = { FABRIC: 'M', TRIM: 'PC', PACKAGING: 'PC', SKU: 'PC' };
const JOB_TYPES = ['MTO_ORDER', 'RTW_BATCH'];
const CONTACT_PREFIX = { CUSTOMER: 'CUS', BOTH: 'CUS', VENDOR: 'VEN', FAMILY: 'FAM' };

function text(v) {
  return isBlank(v) ? '' : String(v).trim();
}

function oneOf(value, allowed, field, label) {
  if (allowed.indexOf(value) === -1) fail('E_VALIDATION', label + ' must be one of ' + allowed.join(', '), field);
  return value;
}

// Pakistani mobile numbers to 92XXXXXXXXXX: "0300-1234567", "+92 300 1234567",
// "3001234567" and "923001234567" all become "923001234567". Blank stays blank.
function normalizePhone(input) {
  if (isBlank(input)) return '';
  let d = String(input).replace(/[^\d+]/g, '');
  if (d.indexOf('+') > 0) fail('E_VALIDATION', 'Phone number is not valid: ' + input, 'phone');
  d = d.replace('+', '');
  if (d.indexOf('0092') === 0) d = d.slice(2);
  if (/^03\d{9}$/.test(d)) d = '92' + d.slice(1);
  else if (/^3\d{9}$/.test(d)) d = '92' + d;
  if (!/^92\d{10}$/.test(d)) fail('E_VALIDATION', 'Phone number should look like 0300 1234567, got ' + input, 'phone');
  return d;
}

function findTax(taxCodes, id, kinds, field) {
  if (isBlank(id)) return '';
  const t = (taxCodes || []).filter(function (x) { return x.id === id; })[0];
  if (!t) fail('E_VALIDATION', 'Unknown tax code ' + id, field);
  if (kinds.indexOf(t.kind) === -1) fail('E_VALIDATION', 'Tax code ' + id + ' cannot be used here', field);
  return id;
}

function optionalPaisa(v, field) {
  if (isBlank(v)) return '';
  Money.assertPaisa(v, field);
  if (v < 0) fail('E_VALIDATION', field + ' cannot be negative', field);
  return v;
}

// Contact create/update. existing: the current row (update) or null (create).
// all: every contact, for the duplicate-phone warning.
// Returns {row, prefix (create only), warnings}.
function prepareContact(input, existing, all, lookups) {
  const l = lookups || {};
  const base = existing || {};
  const merged = Object.assign({}, base, input);
  const kind = oneOf(merged.kind, CONTACT_KINDS, 'kind', 'Kind');
  if (existing && existing.kind !== kind) {
    const pair = [existing.kind, kind].sort().join('/');
    if (['BOTH/CUSTOMER', 'BOTH/VENDOR'].indexOf(pair) === -1) fail('E_VALIDATION', 'A ' + existing.kind.toLowerCase() + ' cannot become a ' + kind.toLowerCase(), 'kind');
  }
  const name = text(merged.name);
  if (!name) fail('E_VALIDATION', 'Enter a name', 'name');
  const phone = normalizePhone(merged.phone);
  const email = text(merged.email).toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('E_VALIDATION', 'Email address is not valid', 'email');
  const isVendor = kind === 'VENDOR' || kind === 'BOTH';
  const row = {
    kind: kind, name: name, phone: phone, email: email, city: text(merged.city), address: text(merged.address),
    cnic: text(merged.cnic), ntn: text(merged.ntn), strn: text(merged.strn),
    filerStatus: isBlank(merged.filerStatus) ? '' : oneOf(merged.filerStatus, FILER_STATUSES, 'filerStatus', 'Filer status'),
    vendorType: isVendor ? oneOf(merged.vendorType || 'OTHER', VENDOR_TYPES, 'vendorType', 'Vendor type') : '',
    whtTaxCodeId: isVendor ? findTax(l.taxCodes, merged.whtTaxCodeId, ['WHT'], 'whtTaxCodeId') : '',
    defaultBrand: isBlank(merged.defaultBrand) ? '' : oneOf(merged.defaultBrand, Validate.BRANDS, 'defaultBrand', 'Brand'),
    openingBalancePaisa: optionalPaisa(merged.openingBalancePaisa, 'openingBalancePaisa') || 0,
    notes: text(merged.notes),
    isActive: isBlank(merged.isActive) ? true : Validate.isTrue(merged.isActive),
  };
  if (row.cnic && !/^\d{5}-?\d{7}-?\d$/.test(row.cnic)) fail('E_VALIDATION', 'CNIC should look like 42101-1234567-1', 'cnic');
  const warnings = [];
  if (phone) {
    const dup = (all || []).filter(function (c) { return c.phone === phone && c.id !== base.id; })[0];
    if (dup) warnings.push('Phone ' + phone + ' is already used by ' + dup.name + ' (' + dup.id + ')');
  }
  return { row: row, prefix: existing ? null : CONTACT_PREFIX[kind], warnings: warnings };
}

// Item create/update. Category cannot change once created (its stock account depends on it).
function prepareItem(input, existing, all, lookups) {
  const l = lookups || {};
  const base = existing || {};
  const merged = Object.assign({}, base, input);
  const category = oneOf(merged.category, ITEM_CATEGORIES, 'category', 'Category');
  if (existing && existing.category !== category) fail('E_VALIDATION', 'An item\'s category cannot change', 'category');
  const name = text(merged.name);
  if (!name) fail('E_VALIDATION', 'Enter a name', 'name');
  const row = {
    category: category, name: name, unit: oneOf(merged.unit || DEFAULT_UNIT[category], ITEM_UNITS, 'unit', 'Unit'),
    style: text(merged.style), size: text(merged.size), colour: text(merged.colour), collection: text(merged.collection),
    barcode: text(merged.barcode), salePricePaisa: optionalPaisa(merged.salePricePaisa, 'salePricePaisa'),
    taxCodeId: findTax(l.taxCodes, merged.taxCodeId, ['SALES_OUTPUT', 'EXEMPT', 'ZERO'], 'taxCodeId'),
    reorderLevel: isBlank(merged.reorderLevel) ? '' : Inventory.fromMilli(Inventory.toMilli(merged.reorderLevel)),
    isActive: isBlank(merged.isActive) ? true : Validate.isTrue(merged.isActive),
  };
  if (row.reorderLevel !== '' && row.reorderLevel < 0) fail('E_VALIDATION', 'Reorder level cannot be negative', 'reorderLevel');
  if (row.barcode) {
    const dup = (all || []).filter(function (i) { return i.barcode === row.barcode && i.id !== base.id; })[0];
    if (dup) fail('E_VALIDATION', 'Barcode ' + row.barcode + ' is already on ' + dup.name + ' (' + dup.id + ')', 'barcode');
  }
  let id = null;
  if (!existing && !isBlank(input.id)) {
    id = String(input.id).trim().toUpperCase();
    if (category !== 'SKU' || !/^SKU-[A-Z0-9]+(-[A-Z0-9]+)*$/.test(id)) fail('E_VALIDATION', 'Only SKUs can choose their own ID, like SKU-AYLA-M-RED', 'id');
    if ((all || []).some(function (i) { return i.id === id; })) fail('E_VALIDATION', 'Item ' + id + ' already exists', 'id');
  }
  return { row: row, id: id, prefix: existing || id ? null : { FABRIC: 'FAB', TRIM: 'TRM', PACKAGING: 'PKG', SKU: 'SKU' }[category], warnings: [] };
}

// New job (MTO order or RTW batch) with its lines. ctx: {contacts, items,
// taxCodes, accountsByCode, settings}. Returns {job, lines} without ids.
function prepareJob(input, ctx, today) {
  const type = oneOf(input.type, JOB_TYPES, 'type', 'Job type');
  const title = text(input.title);
  if (!title) fail('E_VALIDATION', 'Enter a title', 'title');
  const bookedDate = Validate.checkDate(input.bookedDate || today, 'bookedDate');
  const promisedDate = isBlank(input.promisedDate) ? '' : Validate.checkDate(input.promisedDate, 'promisedDate');
  if (promisedDate && promisedDate < bookedDate) fail('E_VALIDATION', 'Promised date is before the booking date', 'promisedDate');
  const job = {
    type: type, brand: type === 'MTO_ORDER' ? 'UMSHA' : 'MIRAE', contactId: '', title: title, description: text(input.description),
    quotedPricePaisa: 0, taxCodeId: '', bookedDate: bookedDate, promisedDate: promisedDate, deliveredDate: '', status: 'OPEN',
    revenueAccount: '', invoiceId: '', collection: text(input.collection), notes: text(input.notes),
    budgetCostPaisa: optionalPaisa(input.budgetCostPaisa, 'budgetCostPaisa'),
  };
  const lines = (input.lines || []).map(function (l, i) {
    const field = 'lines[' + i + ']';
    const qty = isBlank(l.qty) ? 1 : l.qty;
    if (Inventory.toMilli(qty) <= 0) fail('E_VALIDATION', 'Quantity must be more than zero', field + '.qty');
    if (type === 'MTO_ORDER') {
      const description = text(l.description);
      if (!description) fail('E_VALIDATION', 'Describe each piece', field + '.description');
      Money.assertPaisa(l.unitPricePaisa, field + '.unitPricePaisa');
      if (l.unitPricePaisa < 0) fail('E_VALIDATION', 'Price cannot be negative', field + '.unitPricePaisa');
      const discount = optionalPaisa(l.discountPaisa, field + '.discountPaisa') || 0;
      const gross = Inventory.qtyTimesPaisa(qty, l.unitPricePaisa);
      if (discount > gross) fail('E_VALIDATION', 'A discount is bigger than its line', field + '.discountPaisa');
      job.quotedPricePaisa += gross - discount;
      return { description: description, itemId: '', qty: qty, unitPricePaisa: l.unitPricePaisa, discountPaisa: discount, weight: '', sortOrder: i + 1 };
    }
    const item = ctx.items && ctx.items[l.itemId];
    if (!item || item.category !== 'SKU') fail('E_VALIDATION', 'Choose a finished SKU for each planned output', field + '.itemId');
    const weight = isBlank(l.weight) ? 1 : Number(l.weight);
    if (!(weight > 0)) fail('E_VALIDATION', 'Weight must be more than zero', field + '.weight');
    return { description: text(l.description) || item.name, itemId: item.id, qty: qty, unitPricePaisa: '', discountPaisa: '', weight: weight, sortOrder: i + 1 };
  });
  if (type === 'MTO_ORDER') {
    const c = ctx.contacts && ctx.contacts[input.contactId];
    if (!c || (c.kind !== 'CUSTOMER' && c.kind !== 'BOTH')) fail('E_VALIDATION', 'Choose the customer for this order', 'contactId');
    if (!lines.length) fail('E_VALIDATION', 'Add at least one piece to the order', 'lines');
    job.contactId = c.id;
    job.taxCodeId = findTax(ctx.taxCodes, input.taxCodeId, ['SALES_OUTPUT', 'EXEMPT', 'ZERO'], 'taxCodeId');
    const rev = String(input.revenueAccount || (ctx.settings || {}).defaultMtoRevenueAccount || '');
    const acct = ctx.accountsByCode && ctx.accountsByCode[rev];
    if (!acct || acct.type !== 'REVENUE') fail('E_VALIDATION', 'Choose a revenue account for this order', 'revenueAccount');
    job.revenueAccount = rev;
  } else {
    job.quotedPricePaisa = '';
  }
  return { job: job, lines: lines };
}

// User create/update (Owner only).
function prepareUser(input, existing, all) {
  const merged = Object.assign({}, existing || {}, input);
  const email = text(merged.email).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('E_VALIDATION', 'Enter the person\'s Google email address', 'email');
  const dup = (all || []).filter(function (u) { return u.email === email && u.id !== (existing || {}).id; })[0];
  if (dup) fail('E_VALIDATION', email + ' is already a user', 'email');
  const role = oneOf(merged.role, ['OWNER', 'FINANCE', 'STUDIO', 'STORE', 'VIEWER'], 'role', 'Role');
  const store = text(merged.store);
  if (role === 'STORE' && !store) fail('E_VALIDATION', 'Store staff need a store, e.g. MIRAE-KHI-01', 'store');
  return { row: { email: email, name: text(merged.name) || email, role: role, store: store, isActive: isBlank(merged.isActive) ? true : Validate.isTrue(merged.isActive) } };
}

if (typeof module !== 'undefined') module.exports = {
  CONTACT_KINDS,
  ITEM_CATEGORIES,
  normalizePhone,
  prepareContact,
  prepareItem,
  prepareJob,
  prepareUser,
};
