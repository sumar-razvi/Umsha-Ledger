// core/validate.js: one test per error code in docs/03 section 5 that the
// core enforces (E_ROLE and E_DUP_REQUEST are server concerns, milestone M2).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Book, rs, Validate } = require('./helpers/book.js');

function ctxWith(extra) {
  const book = new Book();
  return Object.assign(book.ctx(), extra || {});
}

function entry(lines, extra) {
  return Object.assign({ journal: { date: '2026-10-06', docType: 'MANUAL', docId: '' }, lines: lines, stockMoves: [], itemBalanceUpdates: [] }, extra || {});
}

function line(accountCode, brand, debit, credit, refs) {
  return Object.assign({ accountCode: accountCode, brand: brand, debitPaisa: debit, creditPaisa: credit }, refs || {});
}

function codes(errors) {
  return errors.map((e) => e.code);
}

describe('validateEntry', () => {
  const ctx = ctxWith();

  test('a balanced, branded entry is valid', () => {
    assert.deepEqual(Validate.validateEntry(entry([line('6100', 'MIRAE', 100, 0), line('1100', 'MIRAE', 0, 100)]), ctx), []);
  });

  test('E_UNBALANCED', () => {
    const errors = Validate.validateEntry(entry([line('6100', 'MIRAE', 100, 0), line('1100', 'MIRAE', 0, 99)]), ctx);
    assert.deepEqual(codes(errors), ['E_UNBALANCED']);
    assert.match(errors[0].message, /Debits Rs 1 do not equal credits Rs 0.99/);
  });

  test('E_EMPTY_BRAND for missing or made-up brands', () => {
    for (const brand of ['', undefined, 'umsha', 'BOTH']) {
      const errors = Validate.validateEntry(entry([line('6100', brand, 100, 0), line('1100', 'MIRAE', 0, 100)]), ctx);
      assert.deepEqual(codes(errors), ['E_EMPTY_BRAND'], String(brand));
    }
  });

  test('E_NEG_AMOUNT for negative, two-sided or empty lines', () => {
    const bad = [[-100, 0], [100, 100], [0, 0]];
    for (const [d, c] of bad) {
      const errors = Validate.validateEntry(entry([line('6100', 'MIRAE', d, c), line('1100', 'MIRAE', 0, 100), line('1100', 'MIRAE', 100, 0)]), ctx);
      assert.ok(codes(errors).includes('E_NEG_AMOUNT'), JSON.stringify([d, c]));
    }
  });

  test('float amounts are rejected', () => {
    const errors = Validate.validateEntry(entry([line('6100', 'MIRAE', 100.5, 0), line('1100', 'MIRAE', 0, 100.5)]), ctx);
    assert.ok(codes(errors).includes('E_VALIDATION'));
  });

  test('E_PERIOD_LOCKED', () => {
    const locked = ctxWith({ periods: [{ id: '2026-09', status: 'CLOSED' }, { id: '2026-10', status: 'OPEN' }] });
    const e = entry([line('6100', 'MIRAE', 100, 0), line('1100', 'MIRAE', 0, 100)]);
    assert.deepEqual(Validate.validateEntry(e, locked), []);
    e.journal.date = '2026-09-15';
    assert.deepEqual(codes(Validate.validateEntry(e, locked)), ['E_PERIOD_LOCKED']);
  });

  test('E_INACTIVE_ACCOUNT', () => {
    const book = new Book();
    book.accountRows.find((a) => a.code === '6100').isActive = 'FALSE';
    const ctx2 = Object.assign(book.ctx(), Validate.indexAccounts(book.accountRows));
    const errors = Validate.validateEntry(entry([line('6100', 'MIRAE', 100, 0), line('1100', 'MIRAE', 0, 100)]), ctx2);
    assert.deepEqual(codes(errors), ['E_INACTIVE_ACCOUNT']);
  });

  test('E_NEG_STOCK unless the Owner allows negative stock', () => {
    const e = entry([line('6100', 'MIRAE', 100, 0), line('1100', 'MIRAE', 0, 100)], {
      itemBalanceUpdates: [{ itemId: 'FAB-0001', qty: -1, avgCostMicro: 0, valuePaisa: 0 }],
    });
    assert.deepEqual(codes(Validate.validateEntry(e, ctx)), ['E_NEG_STOCK']);
    assert.deepEqual(Validate.validateEntry(e, ctxWith({ settings: { allowNegativeStock: 'TRUE' } })), []);
  });

  test('E_JOB_CLOSED for cost posted to a cancelled job', () => {
    const ctx2 = ctxWith({ jobs: { 'JOB-2026-00009': { id: 'JOB-2026-00009', status: 'CANCELLED' } } });
    const e = entry([line('1330', 'UMSHA', 100, 0, { jobId: 'JOB-2026-00009', costComponent: 'OTHER' }), line('1100', 'UMSHA', 0, 100)]);
    assert.deepEqual(codes(Validate.validateEntry(e, ctx2)), ['E_JOB_CLOSED']);
  });

  test('control accounts need their sub-ledger key', () => {
    const cases = [['1200', 'contactId'], ['2010', 'contactId'], ['2100', 'contactId'], ['1330', 'jobId'], ['1300', 'itemId']];
    for (const [code, field] of cases) {
      const errors = Validate.validateEntry(entry([line(code, 'SHARED', 100, 0), line('1100', 'SHARED', 0, 100)]), ctx);
      assert.ok(errors.some((e) => e.field.endsWith(field)), code);
    }
  });

  test('inventory lines must match stock moves item by item', () => {
    const e = entry([line('1300', 'SHARED', 100, 0, { itemId: 'FAB-0001' }), line('1100', 'SHARED', 0, 100)], {
      stockMoves: [{ date: '2026-10-06', itemId: 'FAB-0001', qty: 1, valuePaisa: 99 }],
    });
    assert.match(Validate.validateEntry(e, ctx)[0].message, /disagree for FAB-0001/);
    e.stockMoves[0].valuePaisa = 100;
    assert.deepEqual(Validate.validateEntry(e, ctx), []);
  });

  test('unknown accounts, bad dates and single-line entries are rejected', () => {
    assert.ok(codes(Validate.validateEntry(entry([line('9999', 'SHARED', 1, 0), line('1100', 'SHARED', 0, 1)]), ctx)).includes('E_VALIDATION'));
    const e = entry([line('6100', 'MIRAE', 100, 0), line('1100', 'MIRAE', 0, 100)]);
    e.journal.date = '2026-02-30';
    assert.deepEqual(codes(Validate.validateEntry(e, ctx)), ['E_VALIDATION']);
    assert.ok(codes(Validate.validateEntry(entry([line('6100', 'MIRAE', 0, 0)]), ctx)).includes('E_VALIDATION'));
  });

  test('no journal is fine only when nothing of value moved', () => {
    assert.deepEqual(Validate.validateEntry({ journal: null, lines: [], stockMoves: [{ itemId: 'X', qty: 1, valuePaisa: 0 }] }, ctx), []);
    assert.equal(Validate.validateEntry({ journal: null, lines: [], stockMoves: [{ itemId: 'X', qty: 1, valuePaisa: 5 }] }, ctx).length, 1);
  });

  test('assertValid throws the first error with its code', () => {
    assert.throws(() => Validate.assertValid(entry([line('6100', 'MIRAE', 100, 0), line('1100', 'MIRAE', 0, 1)]), ctx), (e) => e.code === 'E_UNBALANCED');
  });

  test('indexAccounts refuses duplicate codes and system keys', () => {
    assert.throws(() => Validate.indexAccounts([{ code: '1', type: 'ASSET' }, { code: '1', type: 'ASSET' }]), /Duplicate account/);
    assert.throws(() => Validate.indexAccounts([{ code: '1', type: 'ASSET', systemKey: 'AR' }, { code: '2', type: 'ASSET', systemKey: 'AR' }]), /systemKey AR/);
    assert.throws(() => Validate.indexAccounts([{ code: '1', type: 'NOPE' }]), /unknown type/);
  });

  test('the seed chart of accounts has every systemKey the engine uses', () => {
    const keys = Object.keys(new Book().acc.accountsBySystemKey);
    for (const k of ['AR', 'CARD_CLEARING', 'INV_FABRIC', 'INV_TRIMS', 'INV_PACKAGING', 'WIP', 'INV_FG', 'VENDOR_ADV', 'INPUT_TAX', 'AP',
      'CUSTOMER_ADV', 'STORE_CREDIT', 'OUTPUT_TAX', 'WHT_PAYABLE', 'OWNER_DRAWINGS', 'RETAINED_EARNINGS', 'SALES_RETURNS', 'CANCEL_INCOME',
      'COGS_RTW', 'SHRINKAGE', 'CARD_FEES', 'CASH_OVER_SHORT', 'FX_GAIN_LOSS', 'ROUNDING', 'RTW_SALES_STORE', 'RTW_SALES_ONLINE',
      'RTW_SALES_EXHIBITION', 'COGS_FABRIC', 'COGS_TRIMS', 'COGS_EMBROIDERY', 'COGS_STITCHING', 'COGS_OUTSOURCED', 'COGS_PACKAGING', 'COGS_OTHER']) {
      assert.ok(keys.includes(k), k);
    }
    assert.equal(rs('1'), 100);
  });
});
