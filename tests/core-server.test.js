// Core modules the server relies on: schema/cell conversion, permissions,
// master-data checks, CSV, Karachi dates and the account ledger report.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Schema = require('../core/schema.js');
const Permissions = require('../core/permissions.js');
const Master = require('../core/master.js');
const Csv = require('../core/csv.js');
const Dates = require('../core/dates.js');
const Reports = require('../core/reports.js');
const { Book } = require('./helpers/book.js');

const err = (code) => (e) => e.code === code;

describe('schema', () => {
  test('every tab in docs/04 is defined, with the documented columns', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', '04-data-model.md'), 'utf8');
    for (const tab of Schema.TAB_ORDER) assert.ok(doc.includes('`' + tab + '`') || doc.includes(tab), tab + ' missing from docs/04');
    for (const [tab, def] of Object.entries(Schema.TABS)) {
      const key = Schema.keyOf(tab);
      if (key) assert.ok(def.columns.includes(key), tab + ' key column');
      assert.equal(new Set(def.columns).size, def.columns.length, tab + ' has duplicate columns');
    }
    assert.ok(Schema.TABS.Journal.appendOnly && Schema.TABS.JournalLines.appendOnly && Schema.TABS.StockMoves.appendOnly);
  });

  test('column types', () => {
    const t = Schema.columnType;
    assert.deepEqual(['debitPaisa', 'rateBps', 'avgCostMicro', 'next'].map(t), ['INT', 'INT', 'INT', 'INT']);
    assert.deepEqual(['qty', 'fxRate', 'weight'].map(t), ['DECIMAL', 'DECIMAL', 'DECIMAL']);
    assert.deepEqual(['isActive', 'lateCost', 'reconciled'].map(t), ['BOOL', 'BOOL', 'BOOL']);
    assert.deepEqual(['code', 'date', 'phone', 'id', 'value'].map(t), ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT']);
    assert.equal(t('responseJson'), 'JSON');
    assert.equal(Schema.numberFormat('code'), '@');
    assert.equal(Schema.numberFormat('debitPaisa'), '0');
    assert.equal(Schema.numberFormat('qty'), null);
  });

  test('round trip through cells', () => {
    const header = ['id', 'date', 'debitPaisa', 'qty', 'lateCost', 'responseJson', 'memo'];
    const obj = { id: 'JE-2026-00001-01', date: '2026-10-06', debitPaisa: 125050, qty: -2.5, lateCost: true, responseJson: { ok: true, data: { a: [1] } }, memo: '' };
    const row = Schema.toRow(header, obj);
    assert.deepEqual(row, ['JE-2026-00001-01', '2026-10-06', 125050, -2.5, true, '{"ok":true,"data":{"a":[1]}}', '']);
    assert.deepEqual(Schema.fromRow(header, row), obj);
  });

  test('values Sheets may have converted are read back safely', () => {
    assert.equal(Schema.fromCell('code', 1100), '1100');
    assert.equal(Schema.fromCell('date', new Date(Date.UTC(2026, 9, 6) - 5 * 3600000)), '2026-10-06');
    assert.equal(Schema.fromCell('isActive', 'TRUE'), true);
    assert.equal(Schema.fromCell('isActive', ''), false);
    assert.equal(Schema.fromCell('debitPaisa', '125050'), 125050);
    assert.equal(Schema.fromCell('debitPaisa', ''), '');
  });

  test('refuses floats in integer columns', () => {
    assert.throws(() => Schema.toCell('debitPaisa', 1.5), err('E_VALIDATION'));
    assert.throws(() => Schema.toCell('debitPaisa', 'abc'), err('E_VALIDATION'));
  });
});

describe('permissions', () => {
  const u = (role, store) => ({ role, store: store || '' });

  test('the matrix from docs/05', () => {
    const allowed = (role, action, payload) => {
      try { return Permissions.check(u(role, 'S1'), action, payload || {}); } catch (e) { if (e.code === 'E_ROLE') return false; throw e; }
    };
    assert.equal(allowed('STORE', 'journal.create'), false);
    assert.equal(allowed('FINANCE', 'journal.create'), true);
    assert.equal(allowed('VIEWER', 'reports.pnl'), true);
    assert.equal(allowed('STUDIO', 'reports.pnl'), false);
    assert.equal(allowed('STUDIO', 'reports.jobProfitability'), true);
    assert.equal(allowed('STORE', 'sale.create'), true);
    assert.equal(allowed('STUDIO', 'sale.create'), false);
    assert.equal(allowed('OWNER', 'periods.close'), true);
    assert.equal(allowed('FINANCE', 'periods.close'), false);
    assert.equal(allowed('STUDIO', 'jobs.cancel'), false);
    assert.equal(allowed('VIEWER', 'export.quickbooksJournals'), true);
    assert.equal(allowed('VIEWER', 'export.table'), false);
  });

  test('payload-dependent rules', () => {
    const acc = { accountsByCode: { 1030: { moneyKind: 'PETTY' }, 1100: { moneyKind: 'BANK' } } };
    assert.ok(Permissions.check(u('STORE'), 'expenses.create', { moneyAccountCode: '1030' }, acc));
    assert.throws(() => Permissions.check(u('STORE'), 'expenses.create', { moneyAccountCode: '1100' }, acc), err('E_ROLE'));
    assert.throws(() => Permissions.check(u('STORE'), 'expenses.create', { moneyAccountCode: '1030', isDrawings: true }, acc), err('E_ROLE'));
    assert.throws(() => Permissions.check(u('STUDIO'), 'bills.create', { lines: [{ lineKind: 'JOB' }, { lineKind: 'STOCK' }] }), err('E_ROLE'));
    assert.throws(() => Permissions.check(u('STORE'), 'contacts.upsert', { id: 'VEN-00001', kind: 'CUSTOMER' }, { contacts: { 'VEN-00001': { kind: 'VENDOR' } } }), err('E_ROLE'));
    assert.ok(Permissions.check(u('STORE', 'MIRAE-KHI-01'), 'reports.dailySales', { store: 'MIRAE-KHI-01' }));
    assert.throws(() => Permissions.check(u('STORE', 'MIRAE-KHI-01'), 'reports.dailySales', { store: 'MIRAE-LHR-01' }), err('E_ROLE'));
  });

  test('T25 (role part): Store cannot open the Overview dashboard but can open Mirae', () => {
    assert.throws(() => Permissions.check(u('STORE'), 'dashboard.get', { tab: 'Overview' }), err('E_ROLE'));
    assert.ok(Permissions.check(u('STORE'), 'dashboard.get', { tab: 'Mirae' }));
    assert.throws(() => Permissions.check(u('OWNER'), 'dashboard.get', { tab: 'Nope' }), err('E_VALIDATION'));
  });

  test('unknown roles and actions', () => {
    assert.throws(() => Permissions.check(u('ADMIN'), 'session.me'), err('E_ROLE'));
    assert.throws(() => Permissions.check(u('OWNER'), 'drop.tables'), err('E_VALIDATION'));
    assert.equal(Permissions.isWrite('payments.receiveAdvance'), true);
    assert.equal(Permissions.isWrite('reports.pnl'), false);
  });
});

describe('master data', () => {
  test('normalizePhone', () => {
    for (const p of ['0300-1234567', '+92 300 1234567', '3001234567', '923001234567', '0092 300 1234567', '(0300) 123 4567']) {
      assert.equal(Master.normalizePhone(p), '923001234567', p);
    }
    assert.equal(Master.normalizePhone(''), '');
    for (const p of ['12345', '021-1234567', '92300123456', '30012345678', '0300+1234567']) {
      assert.throws(() => Master.normalizePhone(p), err('E_VALIDATION'), p);
    }
  });

  test('prepareContact', () => {
    const taxCodes = [{ id: 'WHT-SVC-F', kind: 'WHT' }, { id: 'ST-STD', kind: 'SALES_OUTPUT' }];
    const r = Master.prepareContact({ kind: 'VENDOR', name: ' Aslam ', vendorType: 'KARIGAR', whtTaxCodeId: 'WHT-SVC-F', cnic: '42101-1234567-1' }, null, [], { taxCodes });
    assert.equal(r.prefix, 'VEN');
    assert.equal(r.row.name, 'Aslam');
    assert.throws(() => Master.prepareContact({ kind: 'VENDOR', name: 'x', whtTaxCodeId: 'ST-STD' }, null, [], { taxCodes }), /cannot be used here/);
    assert.throws(() => Master.prepareContact({ kind: 'VENDOR', name: 'x', cnic: '123' }, null, [], { taxCodes }), /CNIC/);
    assert.throws(() => Master.prepareContact({ kind: 'CUSTOMER', name: '' }, null, []), /Enter a name/);
    assert.throws(() => Master.prepareContact({ kind: 'FAMILY' }, { id: 'CUS-00001', kind: 'CUSTOMER', name: 'A' }, []), /cannot become/);
    assert.equal(Master.prepareContact({ kind: 'BOTH' }, { id: 'CUS-00001', kind: 'CUSTOMER', name: 'A' }, []).row.vendorType, 'OTHER');
  });

  test('prepareJob', () => {
    const book = new Book();
    const ctx = Object.assign(book.ctx(), {
      contacts: { 'CUS-00001': { id: 'CUS-00001', kind: 'CUSTOMER' }, 'VEN-00001': { id: 'VEN-00001', kind: 'VENDOR' } },
      items: { 'SKU-A': { id: 'SKU-A', category: 'SKU', name: 'A' }, 'FAB-0001': { id: 'FAB-0001', category: 'FABRIC' } },
    });
    const mto = Master.prepareJob({
      type: 'MTO_ORDER', contactId: 'CUS-00001', title: 'Bridal', taxCodeId: 'ST-STD',
      lines: [{ description: 'Lehenga', qty: 1, unitPricePaisa: 50000000 }, { description: 'Dupatta', qty: 2, unitPricePaisa: 1000000, discountPaisa: 500000 }],
    }, ctx, '2026-10-06');
    assert.equal(mto.job.quotedPricePaisa, 51500000);
    assert.equal(mto.job.brand, 'UMSHA');
    assert.equal(mto.job.revenueAccount, '4010');
    assert.equal(mto.job.bookedDate, '2026-10-06');
    const rtw = Master.prepareJob({ type: 'RTW_BATCH', title: 'Winter', lines: [{ itemId: 'SKU-A', qty: 50 }] }, ctx, '2026-10-06');
    assert.equal(rtw.job.brand, 'MIRAE');
    assert.equal(rtw.lines[0].weight, 1);
    assert.throws(() => Master.prepareJob({ type: 'MTO_ORDER', contactId: 'VEN-00001', title: 'x', lines: [{ description: 'x', unitPricePaisa: 1 }] }, ctx, '2026-10-06'), /customer/);
    assert.throws(() => Master.prepareJob({ type: 'RTW_BATCH', title: 'x', lines: [{ itemId: 'FAB-0001', qty: 1 }] }, ctx, '2026-10-06'), /finished SKU/);
    assert.throws(() => Master.prepareJob({ type: 'MTO_ORDER', contactId: 'CUS-00001', title: 'x', promisedDate: '2026-01-01', lines: [{ description: 'x', unitPricePaisa: 1 }] }, ctx, '2026-10-06'), /before the booking/);
  });

  test('prepareItem and prepareUser', () => {
    assert.equal(Master.prepareItem({ category: 'TRIM', name: 'Dabka' }, null, []).prefix, 'TRM');
    assert.throws(() => Master.prepareItem({ category: 'SKU' }, { id: 'FAB-0001', category: 'FABRIC', name: 'x' }, []), /cannot change/);
    assert.throws(() => Master.prepareItem({ id: 'FAB-X', category: 'FABRIC', name: 'x' }, null, []), /Only SKUs/);
    assert.throws(() => Master.prepareUser({ email: 'a@b.co', role: 'STORE' }, null, []), /store/);
    assert.throws(() => Master.prepareUser({ email: 'A@b.co', role: 'OWNER' }, null, [{ id: 'USR-001', email: 'a@b.co' }]), /already a user/);
    assert.equal(Master.prepareUser({ email: 'New@B.co', role: 'VIEWER' }, null, []).row.email, 'new@b.co');
  });
});

describe('csv and dates', () => {
  test('csv round trip with commas, quotes, newlines and a BOM', () => {
    const rows = [{ a: 'x, y', b: 'say "hi"', c: 'line1\nline2' }, { a: '1', b: '', c: ' pad ' }];
    const text = Csv.toCsv(rows, ['a', 'b', 'c']);
    assert.deepEqual(Csv.parseObjects('﻿' + text), rows);
    assert.deepEqual(Csv.parseRows('a,b\r\n1,2\r\n\r\n'), [['a', 'b'], ['1', '2']]);
  });

  test('every seed CSV parses with a consistent column count', () => {
    for (const f of ['chart_of_accounts.csv', 'tax_codes.csv', 'settings.csv']) {
      const rows = Csv.parseRows(fs.readFileSync(path.join(__dirname, '..', 'seed', f), 'utf8'));
      assert.equal(new Set(rows.map((r) => r.length)).size, 1, f);
    }
  });

  test('Karachi dates', () => {
    assert.equal(Dates.karachiDate(new Date('2026-10-05T18:59:59Z')), '2026-10-05');
    assert.equal(Dates.karachiDate(new Date('2026-10-05T19:00:00Z')), '2026-10-06');
    assert.equal(Dates.karachiTimestamp(new Date('2026-10-06T09:05:07Z')), '2026-10-06T14:05:07+05:00');
    assert.deepEqual(Dates.periodBounds('2028-02'), { id: '2028-02', startDate: '2028-02-01', endDate: '2028-02-29' });
    assert.throws(() => Dates.periodBounds('2026-13'), err('E_VALIDATION'));
    assert.equal(Dates.addDays('2026-03-01', -1), '2026-02-28');
  });
});

describe('account ledger report', () => {
  test('opening balance, running balance in natural sign, brand filter', () => {
    const book = new Book();
    const lines = [
      { id: 'a', date: '2026-09-30', accountCode: '2300', brand: 'SHARED', debitPaisa: 0, creditPaisa: 1000 },
      { id: 'c', date: '2026-10-02', accountCode: '2300', brand: 'SHARED', debitPaisa: 400, creditPaisa: 0 },
      { id: 'b', date: '2026-10-01', accountCode: '2300', brand: 'UMSHA', debitPaisa: 0, creditPaisa: 250 },
      { id: 'd', date: '2026-10-01', accountCode: '1100', brand: 'SHARED', debitPaisa: 5, creditPaisa: 0 },
    ];
    const r = Reports.accountLedger(lines, book.acc, { accountCode: '2300', from: '2026-10-01', to: '2026-10-31' });
    assert.equal(r.openingPaisa, 1000);
    assert.deepEqual(r.rows.map((x) => [x.id, x.balancePaisa]), [['b', 1250], ['c', 850]]);
    assert.equal(r.closingPaisa, 850);
    assert.equal(Reports.accountLedger(lines, book.acc, { accountCode: '2300', brand: 'UMSHA' }).closingPaisa, 250);
    assert.throws(() => Reports.accountLedger(lines, book.acc, { accountCode: '9999' }), err('E_NOT_FOUND'));
  });
});
