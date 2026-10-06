#!/usr/bin/env node
// Local demo server: `npm run serve`, then open http://localhost:8000.
//
// Serves index.html and core.bundle.js, and answers the API by running the
// real apps-script/*.gs code in memory (the same fake Apps Script runtime the
// tests use). Sign-in is a "sign in as" picker instead of Google. Nothing is
// saved: data lives in memory and resets when the server stops.
//
// Options: PORT=8000, --empty (no demo data).

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSystem } = require('../tests/helpers/gas.js');

const ROOT = path.join(__dirname, '..');

function seedDemo(gas, users) {
  const call = (who, action, payload) => {
    const r = gas.call(who, action, payload);
    if (!r.ok) throw new Error(action + ': ' + r.message);
    return r.data;
  };
  const o = users.owner;
  // Demo rates only (the docs/08 test fixtures). Real rates come from the tax advisor.
  call(o, 'taxCodes.upsert', { id: 'WHT-GOODS-F', name: 'WHT goods - filer (demo rate)', kind: 'WHT', rateBps: 450, whtBase: 'EXCL_SALES_TAX', appliesTo: 'GOODS', vendorFilerStatus: 'FILER', effectiveFrom: '2025-07-01', isActive: true });
  call(o, 'taxCodes.upsert', { id: 'WHT-SVC-F', name: 'WHT services - filer (demo rate)', kind: 'WHT', rateBps: 1000, whtBase: 'EXCL_SALES_TAX', appliesTo: 'SERVICES', vendorFilerStatus: 'FILER', effectiveFrom: '2025-07-01', isActive: true });
  call(o, 'settings.update', { key: 'attachmentsFolderId', value: 'demo-attachments' });
  const ayesha = call(o, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Ayesha Khan', phone: '0300 1234567', city: 'Karachi' }).contact;
  call(o, 'contacts.upsert', { kind: 'CUSTOMER', name: 'Sana Malik', phone: '0321 7654321', city: 'Lahore' });
  call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Aslam (embroidery)', filerStatus: 'FILER', whtTaxCodeId: 'WHT-SVC-F' });
  call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Rafiq (stitching)' });
  const supplier = call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'SUPPLIER', name: 'Bolton Market Fabrics', strn: '32-77-8761-123-45', filerStatus: 'FILER', whtTaxCodeId: 'WHT-GOODS-F' }).contact;
  call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'SERVICE', name: 'Landlord' });
  call(o, 'contacts.upsert', { kind: 'FAMILY', name: 'Family member' });
  const fabric = call(o, 'items.upsert', { category: 'FABRIC', name: 'Silk organza', unit: 'M' }).item;
  const trim = call(o, 'items.upsert', { category: 'TRIM', name: 'Dabka', unit: 'G' }).item;
  const today = gas.context.Dates.karachiDate();
  call(o, 'bills.create', {
    contactId: supplier.id, date: today, vendorRef: 'BMF-901',
    lines: [
      { lineKind: 'STOCK', itemId: fabric.id, qty: 50, unitCostPaisa: 200000, taxCodeId: 'ST-IN-STD' },
      { lineKind: 'STOCK', itemId: trim.id, qty: 1000, unitCostPaisa: 3000 },
    ],
  });
  const job = call(users.studio, 'jobs.create', {
    type: 'MTO_ORDER', contactId: ayesha.id, title: 'Bridal lehenga', promisedDate: gas.context.Dates.addDays(today, 10), taxCodeId: 'ST-STD',
    lines: [{ description: 'Lehenga, red, with dupatta', qty: 1, unitPricePaisa: 50000000 }],
  }).job;
  call(users.studio, 'payments.receiveAdvance', { jobId: job.id, date: today, amountPaisa: 30000000, moneyAccountCode: '1100' });
  call(users.studio, 'jobs.issueStock', { jobId: job.id, date: today, lines: [{ itemId: fabric.id, qty: 12 }, { itemId: trim.id, qty: 400 }] });

  // Mirae: two SKUs from a completed batch, ready to sell.
  const unit = call(o, 'contacts.upsert', { kind: 'VENDOR', vendorType: 'KARIGAR', name: 'Mirae stitching unit' }).contact;
  call(o, 'items.upsert', { id: 'SKU-NOOR-S', category: 'SKU', name: 'Noor kurta S', barcode: '8960000000011', salePricePaisa: 944000, taxCodeId: 'ST-STD', collection: 'Winter 26' });
  call(o, 'items.upsert', { id: 'SKU-NOOR-M', category: 'SKU', name: 'Noor kurta M', barcode: '8960000000028', salePricePaisa: 944000, taxCodeId: 'ST-STD', collection: 'Winter 26' });
  const batch = call(users.studio, 'jobs.create', { type: 'RTW_BATCH', title: 'Noor run 1', collection: 'Winter 26', lines: [{ itemId: 'SKU-NOOR-S', qty: 10 }, { itemId: 'SKU-NOOR-M', qty: 10 }] }).job;
  call(users.studio, 'karigar.logWork', { contactId: unit.id, jobId: batch.id, date: today, costComponent: 'STITCHING', pieces: 20, ratePaisa: 250000 });
  call(users.studio, 'jobs.completeBatch', { jobId: batch.id, date: today, outputs: [{ itemId: 'SKU-NOOR-S', qty: 10 }, { itemId: 'SKU-NOOR-M', qty: 10 }] });
}

function start(opts) {
  const o = opts || {};
  const { gas, users } = createSystem();
  const names = { [users.owner]: 'Umar', [users.finance]: 'Sara', [users.studio]: 'Hina', [users.store]: 'Ali', [users.viewer]: 'Accountant' };
  gas.rows('Users').forEach((u) => gas.call(users.owner, 'users.upsert', { id: u.id, name: names[u.email] || u.name }));
  if (o.demo !== false) seedDemo(gas, users);
  const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace("API_URL: '',", "API_URL: '/api',")
    .replace('DEV_SIGNIN: false,', 'DEV_SIGNIN: true,');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(200, 'text/html; charset=utf-8', page);
    if (req.method === 'GET' && url.pathname === '/core.bundle.js') return send(200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'core.bundle.js')));
    if (req.method === 'GET' && url.pathname === '/dev/users') {
      return send(200, 'application/json', JSON.stringify(gas.rows('Users').filter((u) => u.isActive).map((u) => ({ email: u.email, name: u.name, role: u.role }))));
    }
    if (req.method === 'GET' && url.pathname === '/dev/token') return send(200, 'application/json', JSON.stringify({ token: gas.signIn(url.searchParams.get('email')) }));
    if (req.method === 'POST' && url.pathname === '/api') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => send(200, 'application/json', JSON.stringify(gas.post(body))));
      return undefined;
    }
    return send(404, 'text/plain', 'Not found');
  });
  return new Promise((resolve) => server.listen(o.port === undefined ? 8000 : o.port, () => resolve({ server, gas, users, port: server.address().port })));
}

if (require.main === module) {
  start({ port: Number(process.env.PORT || 8000), demo: !process.argv.includes('--empty') }).then(({ port }) => {
    console.log('UMSHA Ledger demo: http://localhost:' + port + '  (in-memory data, Ctrl+C to stop)');
  });
}

module.exports = { start };
