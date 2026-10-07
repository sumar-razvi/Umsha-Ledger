// /core must stay pure (CLAUDE.md): no Apps Script services, no DOM, no Node
// globals. This guards against I/O creeping into the accounting logic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CORE_DIR = path.join(__dirname, '..', 'core');
const FORBIDDEN = [
  'SpreadsheetApp', 'DriveApp', 'LockService', 'CacheService', 'PropertiesService',
  'UrlFetchApp', 'ScriptApp', 'Session', 'Utilities', 'ContentService',
  'document', 'window', 'localStorage', 'fetch', 'process',
];

function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

for (const file of fs.readdirSync(CORE_DIR).filter((f) => f.endsWith('.js'))) {
  test('core/' + file + ' uses no I/O globals', () => {
    const code = stripCommentsAndStrings(fs.readFileSync(path.join(CORE_DIR, file), 'utf8'));
    for (const name of FORBIDDEN) {
      assert.doesNotMatch(code, new RegExp('\\b' + name + '\\b'), file + ' references ' + name);
    }
  });
}
