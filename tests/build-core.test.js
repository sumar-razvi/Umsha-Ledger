// The build turns /core into apps-script/Core.gs. These tests check that the
// output is valid for Apps Script (no CommonJS left), behaves like /core, and
// that the committed Core.gs is not stale.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { buildCore, buildSeed, readText, OUT_FILE, SEED_FILE, BROWSER_FILE } = require('../scripts/build-core.js');

function runInAppsScriptLikeContext(source) {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context;
}

describe('scripts/build-core.js', () => {
  const out = buildCore();

  test('output has no module.exports or require()', () => {
    assert.doesNotMatch(out, /module\.exports/);
    assert.doesNotMatch(out, /\brequire\s*\(/);
  });

  test('output runs without module/require and exposes namespaces that match /core', () => {
    const ctx = runInAppsScriptLikeContext(out);
    assert.equal(ctx.Money.parseRupees('1.25L'), 12500000);
    assert.equal(ctx.Money.formatPaisa(12500050), 'Rs 125,000.50');
    assert.deepEqual(Array.from(ctx.Money.splitProRata(100, [1, 1, 1])), [33, 33, 34]);
    assert.equal(ctx.Ids.formatDocId('INV', 2026, 42), 'INV-2026-00042');
    for (const name of ['Posting', 'Validate', 'Inventory', 'Reports']) {
      assert.equal(typeof ctx[name], 'object', name + ' namespace missing');
    }
  });

  test('dependencies come first', () => {
    const at = (ns) => out.indexOf('var ' + ns + ' =');
    assert.ok(at('Money') < at('Ids'));
    assert.ok(at('Money') < at('Validate') && at('Validate') < at('Inventory'));
    assert.ok(at('Inventory') < at('Posting') && at('Inventory') < at('Reports'));
  });

  test('the posting engine runs inside Core.gs (R1 advance)', () => {
    const ctx = runInAppsScriptLikeContext(out);
    const index = ctx.Validate.indexAccounts([
      { code: '1100', name: 'Bank', type: 'ASSET', isMoney: 'TRUE', moneyKind: 'BANK' },
      { code: '2100', name: 'Customer advances', type: 'LIABILITY', systemKey: 'CUSTOMER_ADV' },
    ]);
    const postingCtx = Object.assign({}, index, {
      settings: {}, periods: [], jobs: { 'JOB-2026-00001': { id: 'JOB-2026-00001', type: 'MTO_ORDER', brand: 'UMSHA', status: 'OPEN', contactId: 'CUS-00001' } },
    });
    const e = ctx.Posting.receiveAdvance({ date: '2026-10-01', jobId: 'JOB-2026-00001', amountPaisa: 30000000, moneyAccountCode: '1100' }, postingCtx);
    // JSON round-trip: arrays made inside the VM have a different Array prototype.
    assert.deepEqual(JSON.parse(JSON.stringify(e.lines.map((l) => [l.accountCode, l.debitPaisa, l.creditPaisa]))), [['1100', 30000000, 0], ['2100', 0, 30000000]]);
  });

  test('committed apps-script/Core.gs is up to date (run `npm run build` if this fails)', () => {
    assert.equal(readText(OUT_FILE), out);
    assert.equal(readText(BROWSER_FILE), out, 'core.bundle.js is stale');
  });

  test('committed apps-script/Seed.gs is up to date and holds every seed row', () => {
    const seed = buildSeed();
    assert.equal(readText(SEED_FILE), seed);
    const ctx = runInAppsScriptLikeContext(seed);
    assert.equal(ctx.SEED.chart_of_accounts.length, 72);
    assert.equal(ctx.SEED.chart_of_accounts.find((a) => a.code === '1710').name, 'Furniture, fixtures & store fit-out');
    assert.ok(ctx.SEED.tax_codes.length > 0 && ctx.SEED.settings.length > 0);
  });

  describe('rejects core files that break the conventions', () => {
    function buildFrom(files) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-'));
      for (const [name, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), src);
      return buildCore(dir);
    }
    const EXPORT = "if (typeof module !== 'undefined') module.exports = { a };\n";

    test('missing export statement', () => {
      assert.throws(() => buildFrom({ 'a.js': 'function a() {}\n' }), /must end with exactly one/);
    });
    test('require bound to the wrong name', () => {
      assert.throws(() => buildFrom({
        'money.js': 'function a() {}\n' + EXPORT,
        'b.js': "const M = require('./money.js');\nfunction a() {}\n" + EXPORT,
      }), /must be assigned to `Money`/);
    });
    test('require of anything other than a sibling core file', () => {
      assert.throws(() => buildFrom({ 'a.js': "const fs = require('fs');\nfunction a() {}\n" + EXPORT }), /only top-level/);
    });
    test('circular requires', () => {
      assert.throws(() => buildFrom({
        'a.js': "const B = require('./b.js');\nfunction a() {}\n" + EXPORT,
        'b.js': "const A = require('./a.js');\nfunction a() {}\n" + EXPORT,
      }), /Circular require/);
    });
    test('missing dependency', () => {
      assert.throws(() => buildFrom({ 'a.js': "const Nope = require('./nope.js');\nfunction a() {}\n" + EXPORT }), /missing core file/);
    });
  });
});
