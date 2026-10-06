// A Node stand-in for the Apps Script runtime, for tests only. It loads every
// apps-script/*.gs file into one VM context (as Apps Script does) with fakes
// for SpreadsheetApp, LockService, CacheService, PropertiesService,
// UrlFetchApp, Utilities, Session, ContentService, DriveApp and ScriptApp.
//
// The fake spreadsheet behaves like Sheets where it matters:
// - unless a column is formatted as plain text ('@'), strings that look like
//   numbers, booleans or dates are converted (so a missing text format shows
//   up as a failing test, not as a corrupted Sheet in production);
// - ranges outside the grid throw, and setValues needs exactly the range's shape;
// - it counts getValues/setValues calls so tests can check batching.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const GAS_DIR = path.join(__dirname, '..', '..', 'apps-script');
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const SHEET_ID = 'sheet-123';
const COMPANY_EMAIL = 'accounts@umsha.example';

const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';

function convertForCell(v, format, makeDate) {
  if (v === null || v === undefined) return '';
  if (format === '@') {
    if (isDate(v)) return v.toISOString();
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (s === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^(TRUE|FALSE)$/i.test(s)) return s.toUpperCase() === 'TRUE';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return (makeDate || ((ms) => new Date(ms)))(Date.UTC(+m[1], +m[2] - 1, +m[3]) - 5 * 3600000); // midnight Karachi
  return v;
}

class FakeSheet {
  constructor(ss, name) {
    this.ss = ss;
    this.name = name;
    this.maxRows = 1000;
    this.maxCols = 26;
    this.cells = []; // cells[r][c], 0-based
    this.formats = {}; // column index -> format (applies to rows >= 2)
    this.frozen = 0;
  }
  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  getLastRow() {
    for (let r = this.cells.length - 1; r >= 0; r--) if ((this.cells[r] || []).some((v) => v !== '' && v !== undefined)) return r + 1;
    return 0;
  }
  getLastColumn() {
    let last = 0;
    this.cells.forEach((row) => (row || []).forEach((v, c) => { if (v !== '' && v !== undefined && c + 1 > last) last = c + 1; }));
    return last;
  }
  getRange(row, col, numRows, numCols) {
    if (typeof row === 'string') throw new Error('A1 notation is not supported by the fake');
    const nr = numRows === undefined ? 1 : numRows;
    const nc = numCols === undefined ? 1 : numCols;
    if (row < 1 || col < 1 || nr < 1 || nc < 1 || row + nr - 1 > this.maxRows || col + nc - 1 > this.maxCols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    return new FakeRange(this, row, col, nr, nc);
  }
  insertRowsAfter(after, n) { this.maxRows += n; this.cells.splice(after, 0, ...Array.from({ length: n }, () => [])); return this; }
  insertColumnsAfter(after, n) { this.maxCols += n; return this; }
  setFrozenRows(n) { this.frozen = n; return this; }
  // Rows as they would read back, for assertions.
  values() {
    const lr = this.getLastRow();
    const lc = this.getLastColumn();
    return lr && lc ? this.getRange(1, 1, lr, lc).getValues() : [];
  }
}

class FakeRange {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
    this.sheet.ss.stats.getValues++;
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const src = this.sheet.cells[this.row - 1 + r] || [];
      const row = [];
      for (let c = 0; c < this.nc; c++) {
        const v = src[this.col - 1 + c];
        row.push(v === undefined ? '' : isDate(v) ? this.sheet.ss.makeDate(v.getTime()) : v);
      }
      out.push(row);
    }
    return out;
  }
  setValues(values) {
    this.sheet.ss.stats.setValues++;
    this.sheet.ss.stats.setValuesByTab[this.sheet.name] = (this.sheet.ss.stats.setValuesByTab[this.sheet.name] || 0) + 1;
    if (!Array.isArray(values) || values.length !== this.nr || values.some((r) => !Array.isArray(r) || r.length !== this.nc)) {
      throw new Error('The number of rows or columns in the data does not match the range');
    }
    values.forEach((r, i) => r.forEach((v, j) => this.write(i, j, v)));
    return this;
  }
  setValue(v) {
    this.sheet.ss.stats.setValue++;
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.write(i, j, v);
    return this;
  }
  write(i, j, v) {
    const r = this.row - 1 + i;
    const c = this.col - 1 + j;
    if (v !== null && typeof v === 'object' && !isDate(v)) throw new Error('Cannot write an object to a cell: ' + JSON.stringify(v));
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Cannot write ' + v + ' to a cell');
    const fmt = r === 0 ? '@' : this.sheet.formats[c];
    while (this.sheet.cells.length <= r) this.sheet.cells.push([]);
    this.sheet.cells[r][c] = convertForCell(v, fmt, this.sheet.ss.makeDate);
  }
  setNumberFormat(fmt) {
    // Data-row formats are tracked per column (Setup formats rows 2..max); row 1 is the header.
    if (this.row === 2) for (let j = 0; j < this.nc; j++) this.sheet.formats[this.col - 1 + j] = fmt;
    return this;
  }
  setFontWeight() { return this; }
  clearContent() {
    for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) {
      const row = this.sheet.cells[this.row - 1 + i];
      if (row) row[this.col - 1 + j] = '';
    }
    return this;
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = [new FakeSheet(this, 'Sheet1')];
    this.stats = { getValues: 0, setValues: 0, setValue: 0, setValuesByTab: {} };
    this.makeDate = (ms) => new Date(ms);
  }
  getId() { return SHEET_ID; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  getSheets() { return this.sheets.slice(); }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error('A sheet with the name "' + name + '" already exists.');
    const s = new FakeSheet(this, name);
    this.sheets.push(s);
    return s;
  }
  resetStats() { this.stats = { getValues: 0, setValues: 0, setValue: 0, setValuesByTab: {} }; }
}

function createGas(opts) {
  const o = opts || {};
  const ss = new FakeSpreadsheet();
  const props = { SHEET_ID: SHEET_ID, OAUTH_CLIENT_ID: CLIENT_ID };
  const cacheStore = {};
  const lock = { held: false, tryLock() { if (this.held) return false; this.held = true; return true; }, releaseLock() { this.held = false; }, hasLock() { return this.held; } };
  const tokens = {};
  const drive = { files: [], nextId: 1 };
  const triggers = [];
  const logs = [];
  let clock = o.now ? new Date(o.now).getTime() : null;

  function makeFile(name, folder) {
    const f = {
      id: 'file-' + drive.nextId++, name, folder, trashed: false, created: new Date(nowMs()),
      getId() { return this.id; }, getName() { return this.name; }, isTrashed() { return this.trashed; },
      setTrashed(t) { this.trashed = t; return this; }, getDateCreated() { return this.created; },
      makeCopy(n, folder2) { return makeFile(n, folder2 || folder); },
      bytes: [], mime: 'application/octet-stream',
      getBlob() { const self = this; return { getBytes: () => self.bytes.slice(), getContentType: () => self.mime, getName: () => self.name }; },
      getMimeType() { return this.mime; },
    };
    drive.files.push(f);
    return f;
  }
  function nowMs() { return clock === null ? Date.now() : clock; }
  const root = { id: 'root', getId() { return 'root'; } };
  const sheetFile = makeFile('UMSHA Ledger', root);
  sheetFile.id = SHEET_ID;
  const folderApi = (folder) => ({
    getId: () => folder.id,
    createFile(blob) { const f = makeFile(blob.name, folder); f.bytes = blob.bytes; f.mime = blob.mime; return f; },
    getFiles() {
      const list = drive.files.filter((f) => f.folder === folder || (f.folder && f.folder.id === folder.id));
      let i = 0;
      return { hasNext: () => i < list.length, next: () => list[i++] };
    },
    id: folder.id,
  });

  const globals = {
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    Logger: { log: (s) => logs.push(String(s)) },
    SpreadsheetApp: { openById: (id) => { if (id !== SHEET_ID) throw new Error('No spreadsheet ' + id); return ss; }, flush() {} },
    LockService: { getScriptLock: () => lock },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cacheStore ? cacheStore[k] : null),
        put: (k, v) => { cacheStore[k] = String(v); },
        remove: (k) => { delete cacheStore[k]; },
      }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    UrlFetchApp: {
      fetch(url) {
        const token = decodeURIComponent(url.split('id_token=')[1] || '');
        const info = tokens[token];
        return {
          getResponseCode: () => (info ? 200 : 400),
          getContentText: () => JSON.stringify(info || { error: 'invalid_token' }),
        };
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => (b + 256) % 256)).toString('base64'),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => COMPANY_EMAIL }), getActiveUser: () => ({ getEmail: () => COMPANY_EMAIL }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } }),
    },
    DriveApp: {
      getFileById: (id) => { const f = drive.files.find((x) => x.id === id); if (!f) throw new Error('No file ' + id); return f; },
      getFolderById: (id) => folderApi({ id }),
      getRootFolder: () => folderApi(root),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger(fn) {
        const t = { fn, getHandlerFunction: () => fn };
        const b = { timeBased: () => b, atHour: (h) => { t.hour = h; return b; }, everyDays: (d) => { t.days = d; return b; }, inTimezone: (z) => { t.tz = z; return b; }, create: () => { triggers.push(t); return t; } };
        return b;
      },
    },
  };
  // Apps Script's clock, when a test pins it.
  const RealDate = Date;
  if (clock !== null) {
    globals.Date = class extends RealDate {
      constructor(...a) { super(...(a.length ? a : [nowMs()])); }
      static now() { return nowMs(); }
    };
  }

  const context = vm.createContext(globals);
  const VmDate = vm.runInContext('Date', context);
  ss.makeDate = (ms) => new VmDate(ms);
  const order = ['Core.gs', 'Seed.gs'].concat(fs.readdirSync(GAS_DIR).filter((f) => f.endsWith('.gs') && f !== 'Core.gs' && f !== 'Seed.gs').sort());
  for (const f of order) vm.runInContext(fs.readFileSync(path.join(GAS_DIR, f), 'utf8'), context, { filename: f });

  let n = 0;
  const gas = {
    ss, context, logs, lock, triggers, drive, props, cacheStore,
    // Register a Google sign-in and return its ID token.
    signIn(email, extra) {
      const token = 'token-' + email + '-' + (++n);
      tokens[token] = Object.assign({ aud: CLIENT_ID, iss: 'https://accounts.google.com', email, email_verified: 'true', exp: Math.floor(nowMs() / 1000) + 3600 }, extra || {});
      return token;
    },
    setNow(iso) { clock = new RealDate(iso).getTime(); },
    // POST to the web app exactly as the front end does; returns the parsed envelope.
    post(req) {
      const out = context.doPost({ postData: { contents: typeof req === 'string' ? req : JSON.stringify(req) } });
      return JSON.parse(out.getContent());
    },
    // Call an action as a user. Writes get a fresh requestId unless one is given.
    call(email, action, payload, requestId) {
      if (!gas.tokenOf[email]) gas.tokenOf[email] = gas.signIn(email);
      const req = { action, idToken: gas.tokenOf[email], payload: payload || {} };
      req.requestId = requestId || 'req-' + crypto.randomUUID();
      return gas.post(req);
    },
    tokenOf: {},
    // A tab as objects (header row -> keys), read straight from the fake sheet.
    rows(tab) {
      const sh = ss.getSheetByName(tab);
      if (!sh) return null;
      const v = sh.values();
      if (!v.length) return [];
      const h = v[0];
      return v.slice(1).filter((r) => r.some((x) => x !== '')).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
    },
    run(fnName, ...args) { return context[fnName](...args); },
    COMPANY_EMAIL,
  };
  return gas;
}

// A set-up system with users for every role.
function createSystem(opts) {
  const gas = createGas(opts);
  gas.run('setupRun');
  const owner = COMPANY_EMAIL;
  const users = {
    owner,
    finance: 'finance@umsha.example',
    studio: 'studio@umsha.example',
    store: 'store@umsha.example',
    viewer: 'advisor@example.com',
  };
  const add = (email, role, store) => {
    const r = gas.call(owner, 'users.upsert', { email, role, name: role, store: store || '' });
    if (!r.ok) throw new Error(JSON.stringify(r));
  };
  add(users.finance, 'FINANCE');
  add(users.studio, 'STUDIO');
  add(users.store, 'STORE', 'MIRAE-KHI-01');
  add(users.viewer, 'VIEWER');
  return { gas, users };
}

module.exports = { createGas, createSystem, CLIENT_ID, COMPANY_EMAIL, convertForCell };
