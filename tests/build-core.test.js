// The build turns /core into apps-script/Core.gs. These tests check that the
// output is valid for Apps Script (no CommonJS left), behaves like /core, and
// that the committed Core.gs is not stale.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { buildCore, OUT_FILE } = require('../scripts/build-core.js');

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

  test('dependencies come first (Money before Ids)', () => {
    assert.ok(out.indexOf('var Money =') < out.indexOf('var Ids ='));
  });

  test('committed apps-script/Core.gs is up to date (run `npm run build` if this fails)', () => {
    assert.equal(fs.readFileSync(OUT_FILE, 'utf8'), out);
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
