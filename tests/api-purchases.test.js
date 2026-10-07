// Milestone M4 through the API: bills, karigar work, bill payments with WHT,
// quick expenses and drawings, vendor balances, AP ageing, attachments,
// tax-code versions. Scenarios T02, T05, T07 and T18 with real actions.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { createSystem } = require('./helpers/gas.js');

const rs = (r) => Math.round(r * 100);

function sumLines(gas, jeId) {
  const out = {};
  gas.rows('JournalLines').filter((l) => l.jeId === jeId).forEach((l) => {
    const k = (l.debitPaisa ? 'Dr ' : 'Cr ') + l.accountCode + ' ' + l.brand;
    out[k] = (out[k] || 0) + (l.debitPaisa || l.creditPaisa);
  });
  return out;
}

function setup() {
  const { gas, users } = createSystem();
  const ok = (r) => { assert.ok(r.ok, JSON.stringify(r)); return r.data; };
  const o = users.owner;
  // The tax advisor's rates (test fixtures, as in docs/08): switch the seeded WHT codes on.
  ok(gas.call(o, 'taxCodes.upsert', { id: 'WHT-GOODS-F', name: 'WHT goods - filer', kind: 'WHT', rateBps: 450, whtBase: 'EXCL_SALES_TAX', appliesTo: 'GOODS', vendorFilerStatus: 'FILER', effectiveFrom: '2025-07-01', isActive: true }));
  ok(gas.call(o, 'taxCodes.upsert', { id: 'WHT-SVC-F', name: 'WHT services - filer', kind: 'WHT', rateBps: 1000, whtBase: 'EXCL_SALES_TAX', appliesTo: 'SERVICES', vendorFilerStatus: 'FILER', effectiveFrom: '2025-07-01', isActive: true }));
  const supplier = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'SUPPLIER', name: 'Registered fabric house', strn: '32-77-8761-123-45', filerStatus: 'FILER', whtTaxCodeId: 'WHT-GOODS-F' })).contact;
  const shop = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'SUPPLIER', name: 'Trims shop' })).contact;
  const karigar = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Embroidery karigar', filerStatus: 'FILER', whtTaxCodeId: 'WHT-SVC-F' })).contact;
  const landlord = ok(gas.call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'SERVICE', name: 'Landlord' })).contact;
  const family = ok(gas.call(o, 'contacts.upsert', { kind: 'FAMILY', name: 'Family member' })).contact;
  const fabric = ok(gas.call(o, 'items.upsert', { category: 'FABRIC', name: 'Silk organza' })).item;
  const trim = ok(gas.call(o, 'items.upsert', { category: 'TRIM', name: 'Dabka', unit: 'G' })).item;
  const customer = ok(gas.call(o, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Ayesha' })).contact;
  const job = ok(gas.call(users.studio, 'jobs.create', { type: 'MTO_ORDER', contactId: customer.id, title: 'Bridal', taxCodeId: 'ST-STD', lines: [{ description: 'Lehenga', unitPricePaisa: rs(500000) }] })).job;
  return { gas, users, ok, supplier, shop, karigar, landlord, family, fabric, trim, job };
}

describe('purchases through the API (M4)', () => {
  test('T02/T05: stock bills, karigar work, payments with WHT, balances and voucher', () => {
    const s = setup();
    const { gas, users, ok } = s;
    const billA = ok(gas.call(users.finance, 'bills.create', {
      contactId: s.supplier.id, date: '2026-10-02', vendorRef: 'FH-901', dueDate: '2026-10-31',
      lines: [{ lineKind: 'STOCK', itemId: s.fabric.id, qty: 50, unitCostPaisa: rs(2000), taxCodeId: 'ST-IN-STD' }],
    }));
    assert.deepEqual(sumLines(gas, billA.jeId), { 'Dr 1300 SHARED': rs(100000), 'Dr 1500 SHARED': rs(18000), 'Cr 2010 SHARED': rs(118000) });
    ok(gas.call(users.finance, 'bills.create', { contactId: s.shop.id, date: '2026-10-02', lines: [{ lineKind: 'STOCK', itemId: s.trim.id, qty: 1000, unitCostPaisa: rs(30) }] }));
    assert.equal(gas.rows('ItemBalances').find((b) => b.itemId === s.fabric.id).qty, 50);

    // T03: issue to the order
    ok(gas.call(users.studio, 'jobs.issueStock', { jobId: s.job.id, date: '2026-10-03', lines: [{ itemId: s.fabric.id, qty: 12 }, { itemId: s.trim.id, qty: 400 }] }));

    // T05a/b: karigar work and payment, WHT 10%
    const work = ok(gas.call(users.studio, 'karigar.logWork', { contactId: s.karigar.id, jobId: s.job.id, date: '2026-10-05', costComponent: 'EMBROIDERY', pieces: 40, ratePaisa: rs(2000) }));
    const payK = ok(gas.call(users.finance, 'payments.pay', { contactId: s.karigar.id, date: '2026-10-05', moneyAccountCode: '1100', allocations: [{ docType: 'BILL', docId: work.billId, amountPaisa: rs(80000) }] }));
    assert.deepEqual(sumLines(gas, payK.jeId), { 'Dr 2010 UMSHA': rs(80000), 'Cr 1100 UMSHA': rs(72000), 'Cr 2210 UMSHA': rs(8000) });

    // T05c: supplier paid in full, WHT 4.5% on the amount excluding sales tax
    const payS = ok(gas.call(users.finance, 'payments.pay', { contactId: s.supplier.id, date: '2026-10-05', moneyAccountCode: '1100', allocations: [{ docType: 'BILL', docId: billA.billId, amountPaisa: rs(118000) }] }));
    assert.deepEqual(sumLines(gas, payS.jeId), { 'Dr 2010 SHARED': rs(118000), 'Cr 1100 SHARED': rs(113500), 'Cr 2210 SHARED': rs(4500) });
    assert.equal(gas.rows('PaymentAllocations').find((a) => a.paymentId === payS.paymentId).whtPaisa, rs(4500));
    const v = ok(gas.call(users.finance, 'receipts.render', { docType: 'PAYMENT', docId: payS.paymentId }));
    assert.equal(v.kind, 'VOUCHER');
    assert.deepEqual([v.grossSettledPaisa, v.whtPaisa, v.amountPaisa], [rs(118000), rs(4500), rs(113500)]);
    assert.equal(v.lines[0].label, 'Bill ' + billA.billId + ' (FH-901)');

    const states = Object.fromEntries(ok(gas.call(users.finance, 'bills.list', {})).map((b) => [b.id, b.state]));
    assert.equal(states[billA.billId], 'PAID');
    const vendors = Object.fromEntries(ok(gas.call(users.studio, 'vendors.list', { vendorType: 'KARIGAR' })).map((x) => [x.id, x.weOwePaisa]));
    assert.deepEqual(vendors, { [s.karigar.id]: 0 });
    assert.equal(gas.call(users.studio, 'payments.pay', { contactId: s.karigar.id, date: '2026-10-05', moneyAccountCode: '1100', allocations: [] }).code, 'E_ROLE');
  });

  test('T07: multi-brand landlord bill paid in parts; quick expense; drawings; T18 reversal via the API', () => {
    const s = setup();
    const { gas, users, ok } = s;
    const rent = ok(gas.call(users.finance, 'bills.create', {
      contactId: s.landlord.id, date: '2026-10-07', vendorRef: 'OCT-RENT', dueDate: '2026-10-10',
      lines: [
        { lineKind: 'EXPENSE', accountCode: '6020', brand: 'MIRAE', netPaisa: rs(150000), description: 'Store rent' },
        { lineKind: 'EXPENSE', accountCode: '6030', brand: 'UMSHA', netPaisa: rs(100000), description: 'Studio rent' },
        { lineKind: 'EXPENSE', accountCode: '6040', brand: 'SHARED', netPaisa: rs(40000), description: 'Electricity' },
      ],
    }));
    assert.deepEqual(sumLines(gas, rent.jeId), {
      'Dr 6020 MIRAE': rs(150000), 'Dr 6030 UMSHA': rs(100000), 'Dr 6040 SHARED': rs(40000),
      'Cr 2010 MIRAE': rs(150000), 'Cr 2010 UMSHA': rs(100000), 'Cr 2010 SHARED': rs(40000),
    });
    ok(gas.call(users.finance, 'payments.pay', { contactId: s.landlord.id, date: '2026-10-08', moneyAccountCode: '1100', allocations: [{ docType: 'BILL', docId: rent.billId, amountPaisa: rs(100000) }] }));
    const bill = ok(gas.call(users.finance, 'bills.get', { id: rent.billId }));
    assert.equal(bill.bill.state, 'PART_PAID');
    assert.equal(bill.bill.balancePaisa, rs(190000));
    assert.equal(bill.payments.length, 1);

    // AP ageing: 190,000 is 21 days late on 31 Oct
    const age = ok(gas.call(users.viewer, 'reports.apAgeing', { asOf: '2026-10-31' }));
    assert.deepEqual([age.rows[0].contactName, age.rows[0].d1_30, age.totals.total], ['Landlord', rs(190000), rs(190000)]);

    // T07b quick expense, then T18: reverse it
    const shoot = ok(gas.call(users.finance, 'expenses.create', { date: '2026-10-07', moneyAccountCode: '1100', lines: [{ accountCode: '6100', brand: 'MIRAE', netPaisa: rs(45000), description: 'Photo shoot' }] }));
    assert.deepEqual(sumLines(gas, shoot.jeId), { 'Dr 6100 MIRAE': rs(45000), 'Cr 1100 MIRAE': rs(45000) });
    assert.equal(gas.rows('Bills').find((b) => b.id === shoot.billId).balancePaisa, 0);
    assert.equal(gas.rows('Payments').find((p) => p.id === shoot.paymentId).kind, 'EXPENSE_PAID');
    const rev = ok(gas.call(users.finance, 'journal.reverse', { jeId: shoot.jeId, date: '2026-10-13', reason: 'Entered twice' }));
    assert.deepEqual(sumLines(gas, rev.jeId), { 'Dr 1100 MIRAE': rs(45000), 'Cr 6100 MIRAE': rs(45000) });
    assert.equal(gas.rows('Bills').find((b) => b.id === shoot.billId).status, 'VOID');
    assert.equal(gas.rows('Payments').find((p) => p.id === shoot.paymentId).status, 'VOID');

    // T07c drawings from petty cash: never an expense
    const draw = ok(gas.call(users.owner, 'expenses.create', { date: '2026-10-07', moneyAccountCode: '1030', isDrawings: true, contactId: s.family.id, amountPaisa: rs(20000) }));
    assert.deepEqual(sumLines(gas, draw.jeId), { 'Dr 3020 SHARED': rs(20000), 'Cr 1030 SHARED': rs(20000) });
    assert.equal(gas.rows('Payments').find((p) => p.id === draw.paymentId).kind, 'DRAWINGS');

    // Store staff: petty cash only, never drawings
    assert.equal(gas.call(users.store, 'expenses.create', { date: '2026-10-07', moneyAccountCode: '1100', lines: [{ accountCode: '6800', brand: 'MIRAE', netPaisa: 100 }] }).code, 'E_ROLE');
    assert.equal(gas.call(users.store, 'expenses.create', { date: '2026-10-07', moneyAccountCode: '1030', isDrawings: true, contactId: s.family.id, amountPaisa: 100 }).code, 'E_ROLE');
    ok(gas.call(users.store, 'expenses.create', { date: '2026-10-07', moneyAccountCode: '1030', lines: [{ accountCode: '6800', brand: 'MIRAE', netPaisa: rs(500), description: 'Tea' }] }));
  });

  test('reversing a bill payment puts the balance back; WHT override needs a reason', () => {
    const s = setup();
    const { gas, users, ok } = s;
    const work = ok(gas.call(users.studio, 'karigar.logWork', { contactId: s.karigar.id, jobId: s.job.id, date: '2026-10-05', costComponent: 'EMBROIDERY', pieces: 10, ratePaisa: rs(1000) }));
    const payload = { contactId: s.karigar.id, date: '2026-10-06', moneyAccountCode: '1100', allocations: [{ docType: 'BILL', docId: work.billId, amountPaisa: rs(10000), whtPaisa: rs(500) }] };
    assert.equal(gas.call(users.finance, 'payments.pay', payload).code, 'E_TAX_OVERRIDE_NO_REASON');
    const pay = ok(gas.call(users.finance, 'payments.pay', Object.assign({ whtOverrideReason: 'Reduced-rate certificate' }, payload)));
    assert.deepEqual(sumLines(gas, pay.jeId), { 'Dr 2010 UMSHA': rs(10000), 'Cr 1100 UMSHA': rs(9500), 'Cr 2210 UMSHA': rs(500) });
    ok(gas.call(users.finance, 'journal.reverse', { jeId: pay.jeId, date: '2026-10-07', reason: 'Wrong bank' }));
    const b = gas.rows('Bills').find((x) => x.id === work.billId);
    assert.deepEqual([b.paidPaisa, b.whtPaisa, b.balancePaisa], [0, 0, rs(10000)]);
    assert.equal(gas.rows('Payments').find((p) => p.id === pay.paymentId).status, 'VOID');
  });

  test('Studio may enter job-cost bills only', () => {
    const s = setup();
    const { gas, users, ok } = s;
    ok(gas.call(users.studio, 'bills.create', { contactId: s.shop.id, date: '2026-10-02', lines: [{ lineKind: 'JOB', jobId: s.job.id, costComponent: 'OUTSOURCED', netPaisa: rs(7000), description: 'Dyeing' }] }));
    assert.equal(gas.call(users.studio, 'bills.create', { contactId: s.shop.id, date: '2026-10-02', lines: [{ lineKind: 'STOCK', itemId: s.fabric.id, qty: 1, unitCostPaisa: 100 }] }).code, 'E_ROLE');
  });

  test('tax codes are effective-dated versions', () => {
    const s = setup();
    const { gas, users, ok } = s;
    ok(gas.call(users.owner, 'taxCodes.upsert', { id: 'WHT-SVC-F', name: 'WHT services - filer', kind: 'WHT', rateBps: 1100, whtBase: 'EXCL_SALES_TAX', appliesTo: 'SERVICES', vendorFilerStatus: 'FILER', effectiveFrom: '2026-11-01' }));
    const versions = gas.rows('TaxCodes').filter((t) => t.id === 'WHT-SVC-F');
    assert.deepEqual(versions.map((t) => [t.rateBps, t.effectiveFrom, t.effectiveTo]), [[1000, '2025-07-01', '2026-10-31'], [1100, '2026-11-01', '']]);
    assert.equal(gas.call(users.owner, 'taxCodes.upsert', { id: 'WHT-SVC-F', name: 'x', kind: 'SALES_OUTPUT', rateBps: 1, effectiveFrom: '2027-01-01' }).code, 'E_VALIDATION');
    assert.equal(gas.call(users.finance, 'taxCodes.upsert', { id: 'X', name: 'x', kind: 'ZERO', rateBps: 0, effectiveFrom: '2027-01-01' }).code, 'E_ROLE');
    // a karigar paid in November is withheld at the new rate
    const work = ok(gas.call(users.studio, 'karigar.logWork', { contactId: s.karigar.id, jobId: s.job.id, date: '2026-11-02', costComponent: 'EMBROIDERY', pieces: 10, ratePaisa: rs(1000) }));
    const pay = ok(gas.call(users.finance, 'payments.pay', { contactId: s.karigar.id, date: '2026-11-02', moneyAccountCode: '1100', allocations: [{ docType: 'BILL', docId: work.billId, amountPaisa: rs(10000) }] }));
    assert.equal(pay.whtPaisa, rs(1100));
  });

  test('photo attachments go to Drive and come back', () => {
    const s = setup();
    const { gas, users, ok } = s;
    const bill = ok(gas.call(users.finance, 'bills.create', { contactId: s.shop.id, date: '2026-10-02', lines: [{ lineKind: 'STOCK', itemId: s.trim.id, qty: 10, unitCostPaisa: rs(30) }] }));
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]).toString('base64');
    const up = { docType: 'BILL', docId: bill.billId, fileName: 'bill photo.png', mimeType: 'image/png', dataBase64: png };
    assert.equal(gas.call(users.finance, 'attachments.upload', up).field, 'attachmentsFolderId');
    ok(gas.call(users.owner, 'settings.update', { key: 'attachmentsFolderId', value: 'folder-att' }));
    assert.equal(gas.call(users.finance, 'attachments.upload', Object.assign({}, up, { mimeType: 'text/html' })).code, 'E_VALIDATION');
    const a = ok(gas.call(users.finance, 'attachments.upload', up));
    assert.equal(gas.rows('Bills').find((b) => b.id === bill.billId).attachmentIds, JSON.stringify([a.attachmentId]));
    const got = ok(gas.call(users.viewer, 'attachments.get', { id: a.attachmentId }));
    assert.equal(got.dataBase64, png);
    assert.equal(ok(gas.call(users.finance, 'bills.get', { id: bill.billId })).attachments.length, 1);
  });
});
