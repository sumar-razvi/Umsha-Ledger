const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Ids = require('../core/ids.js');

describe('document IDs (PREFIX-YYYY-NNNNN)', () => {
  test('examples from CLAUDE.md', () => {
    assert.equal(Ids.formatDocId('INV', 2026, 42), 'INV-2026-00042');
    assert.equal(Ids.formatDocId('BILL', 2026, 7), 'BILL-2026-00007');
    assert.equal(Ids.formatDocId('JOB', 2026, 113), 'JOB-2026-00113');
    assert.equal(Ids.formatDocId('JE', 2026, 981), 'JE-2026-00981');
  });
  test('widens past 99999 instead of wrapping', () => {
    assert.equal(Ids.formatDocId('JE', 2026, 100000), 'JE-2026-100000');
  });
  test('rejects unknown prefix, bad year, bad number', () => {
    assert.throws(() => Ids.formatDocId('XYZ', 2026, 1), (e) => e.code === 'E_VALIDATION');
    assert.throws(() => Ids.formatDocId('INV', 26, 1));
    assert.throws(() => Ids.formatDocId('INV', 2026, 0));
    assert.throws(() => Ids.formatDocId('INV', 2026, 1.5));
  });
  test('parseDocId round-trips', () => {
    assert.deepEqual(Ids.parseDocId('INV-2026-00042'), { prefix: 'INV', year: 2026, n: 42 });
    assert.deepEqual(Ids.parseDocId(Ids.formatDocId('SALE', 2027, 123456)), { prefix: 'SALE', year: 2027, n: 123456 });
    assert.equal(Ids.parseDocId('CUS-00001'), null);
    assert.equal(Ids.parseDocId('INV-2026-42'), null);
    assert.equal(Ids.parseDocId('FOO-2026-00001'), null);
  });
  test('sequence keys', () => {
    assert.equal(Ids.docSequenceKey('INV', 2026), 'INV-2026');
    assert.equal(Ids.masterSequenceKey('CUS'), 'CUS');
  });
});

describe('master data IDs', () => {
  test('widths per prefix', () => {
    assert.equal(Ids.formatMasterId('CUS', 1), 'CUS-00001');
    assert.equal(Ids.formatMasterId('VEN', 3), 'VEN-00003');
    assert.equal(Ids.formatMasterId('FAM', 1), 'FAM-001');
    assert.equal(Ids.formatMasterId('FAB', 1), 'FAB-0001');
    assert.equal(Ids.formatMasterId('TRM', 12), 'TRM-0012');
    assert.equal(Ids.formatMasterId('SKU', 1), 'SKU-000001');
  });
  test('item prefix by category', () => {
    assert.equal(Ids.ITEM_PREFIX_BY_CATEGORY.FABRIC, 'FAB');
    assert.equal(Ids.ITEM_PREFIX_BY_CATEGORY.TRIM, 'TRM');
    assert.equal(Ids.ITEM_PREFIX_BY_CATEGORY.PACKAGING, 'PKG');
    assert.equal(Ids.ITEM_PREFIX_BY_CATEGORY.SKU, 'SKU');
  });
  test('rejects document prefixes', () => {
    assert.throws(() => Ids.formatMasterId('INV', 1));
  });
});

describe('line IDs', () => {
  test('parent + 2-digit line number', () => {
    assert.equal(Ids.formatLineId('JE-2026-00981', 1), 'JE-2026-00981-01');
    assert.equal(Ids.formatLineId('JE-2026-00981', 123), 'JE-2026-00981-123');
    assert.throws(() => Ids.formatLineId('', 1));
    assert.throws(() => Ids.formatLineId('JE-2026-00981', 0));
  });
});

describe('yearOfDate', () => {
  test('calendar year of an ISO date', () => {
    assert.equal(Ids.yearOfDate('2026-10-06'), 2026);
    assert.equal(Ids.yearOfDate('2027-01-01'), 2027);
    assert.equal(Ids.yearOfDate('2028-02-29'), 2028);
  });
  test('rejects non-ISO and impossible dates', () => {
    for (const d of ['2026-10-6', '06/10/2026', '2026-13-01', '2026-02-30', '2027-02-29', '', null]) {
      assert.throws(() => Ids.yearOfDate(d), (e) => e.code === 'E_VALIDATION', String(d));
    }
  });
});

describe('reserveNumbers', () => {
  test('a missing Sequences row starts at 1', () => {
    assert.deepEqual(Ids.reserveNumbers(undefined, 1), { numbers: [1], next: 2 });
    assert.deepEqual(Ids.reserveNumbers('', 2), { numbers: [1, 2], next: 3 });
  });
  test('continues from next and accepts sheet values as strings', () => {
    assert.deepEqual(Ids.reserveNumbers(42, 3), { numbers: [42, 43, 44], next: 45 });
    assert.deepEqual(Ids.reserveNumbers('7', 1), { numbers: [7], next: 8 });
  });
  test('rejects bad input', () => {
    assert.throws(() => Ids.reserveNumbers(0, 1));
    assert.throws(() => Ids.reserveNumbers(1, 0));
    assert.throws(() => Ids.reserveNumbers('abc', 1));
  });
});
