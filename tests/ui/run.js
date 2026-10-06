#!/usr/bin/env node
// Browser test of index.html (milestone M3 "done when"): on a phone-sized
// screen, create a customer, book an order, take an advance, log karigar
// work, deliver it and take the balance; then check the journal entries as
// the Owner. Runs the real page against the demo server (real apps-script
// code in memory). Needs Playwright with Chromium; skipped if not installed.
//
//   npm run test:ui            (SCREENSHOTS=dir to keep screenshots)

'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

let playwright;
try { playwright = require('playwright'); } catch (e) {
  console.log('SKIP: Playwright is not installed (npm i -g playwright).');
  process.exit(0);
}
const { start } = require('../../scripts/dev-server.js');

const SHOTS = process.env.SCREENSHOTS || '';
let step = 0;
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, String(++step).padStart(2, '0') + '-' + name + '.png'), fullPage: true });
}

async function signInAs(browser, base, label, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  await page.getByRole('button', { name: new RegExp(label) }).click();
  return { page, errors };
}

async function noHorizontalScroll(page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(sw <= cw + 1, 'page scrolls sideways: ' + sw + ' > ' + cw);
}

(async () => {
  const { server, gas, port } = await start({ port: 0, demo: true });
  const base = 'http://localhost:' + port + '/';
  const browser = await playwright.chromium.launch();
  const phone = { width: 375, height: 760 };
  try {
    // ---- Studio, on a phone ----
    const { page, errors } = await signInAs(browser, base, 'Hina', phone);
    await page.waitForSelector('h1:has-text("Orders")');
    await shot(page, 'orders-list');
    await noHorizontalScroll(page);

    await page.locator('a.btn.primary', { hasText: 'New order' }).click();
    await page.getByPlaceholder('Search by name or phone').fill('Zara');
    await page.getByRole('button', { name: /\+ New customer "Zara"/ }).click();
    const dlg = page.getByRole('dialog', { name: 'New customer' });
    await dlg.locator('input').nth(0).fill('Zara Ahmed');
    await dlg.locator('input[type=tel]').fill('0333 5551234');
    await dlg.getByRole('button', { name: 'Save customer' }).click();
    await page.waitForSelector('.chosen >> text=Zara Ahmed');
    await page.getByPlaceholder('e.g. Mehndi outfit for Ayesha').fill('Walima gharara');
    await page.getByPlaceholder('e.g. Bridal lehenga, red').fill('Gharara with kurti');
    await page.locator('.lineedit').nth(1).locator('input[aria-label=Price]').fill('5L');
    await page.locator('input[aria-label="First advance"]').fill('300k');
    await page.waitForSelector('text=Rs 590,000');
    await shot(page, 'new-order');
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Book order' }).click();

    // receipt for the advance
    await page.waitForSelector('text=Payment receipt');
    await page.waitForSelector('text=Rs 290,000');
    const wa = await page.getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href');
    assert.ok(wa.startsWith('https://wa.me/923335551234?text='), wa);
    assert.match(decodeURIComponent(wa), /Received Rs 300,000 for JOB-\d{4}-\d{5}\. Balance Rs 290,000/);
    await shot(page, 'advance-receipt');
    const jobId = decodeURIComponent(wa).match(/JOB-\d{4}-\d{5}/)[0];

    // order detail: karigar work
    await page.goto(base + '#/orders/' + jobId);
    await page.waitForSelector('text=Cost sheet');
    await page.getByRole('button', { name: 'Log karigar work' }).click();
    const k = page.getByRole('dialog', { name: /Log karigar work/ });
    await k.getByPlaceholder('Search karigar').fill('Aslam');
    await k.getByRole('button', { name: /Aslam/ }).click();
    await k.locator('input[type=number]').fill('40');
    await k.locator('input[aria-label="Rate per piece"]').fill('2000');
    await k.getByRole('button', { name: 'Log work' }).click();
    await k.waitFor({ state: 'detached', timeout: 10000 }).catch(async () => { throw new Error('Karigar sheet stayed open: ' + (await k.innerText())); });
    await page.waitForSelector('.card >> text=Embroidery (karigar)');
    await page.waitForSelector('text=Rs 80,000');
    await shot(page, 'order-detail');
    await noHorizontalScroll(page);

    // deliver, then take the balance
    await page.getByRole('link', { name: 'Deliver' }).click();
    await page.waitForSelector('text=Balance due on delivery');
    assert.ok(await page.locator('.kv >> text=Rs 290,000').count() >= 1);
    await shot(page, 'deliver-preview');
    await page.getByRole('button', { name: 'Confirm delivery' }).click();
    const bal = page.getByRole('dialog', { name: 'Receive balance' });
    await bal.waitFor();
    await bal.getByRole('button', { name: 'Save and show receipt' }).click();
    await page.waitForSelector('text=Balance remaining');
    await page.waitForSelector('.kv >> text=Rs 0');
    await shot(page, 'balance-receipt');

    const ordersAfter = gas.rows('Jobs').find((j) => j.id === jobId);
    assert.equal(ordersAfter.status, 'DELIVERED');
    const inv = gas.rows('Invoices').find((i) => i.jobId === jobId);
    assert.equal(inv.balancePaisa, 0);
    assert.equal(inv.grossPaisa, 59000000);
    assert.deepEqual(errors, [], 'browser errors: ' + errors.join('\n'));

    // ---- Owner, on a desktop: the journal entries are visible and match T01/T06 ----
    const owner = await signInAs(browser, base, 'Umar', { width: 1280, height: 900 });
    await owner.page.goto(base + '#/orders/' + jobId);
    await owner.page.waitForSelector('text=Timeline');
    await shot(owner.page, 'owner-order-detail');
    await owner.page.locator('.timeline a', { hasText: 'Rs 1,021,000' }).first().click().catch(() => {});
    const deliveryJe = gas.rows('Journal').find((j) => j.docType === 'INVOICE' && j.docId === inv.id).id;
    await owner.page.goto(base + '#/je/' + deliveryJe);
    await owner.page.waitForSelector('text=Journal entry ' + deliveryJe);
    for (const t of ['1200 Accounts receivable', '4010 MTO sales - bridal & couture', '2200 Output sales tax', '2100 Customer advances (MTO deposits)', '5030 Embroidery labour (karigar)', '1330 Work in progress - jobs']) {
      await owner.page.waitForSelector('text=' + t);
    }
    const foot = await owner.page.locator('tfoot td').allTextContents();
    assert.ok(foot.includes('970,000.00'), 'totals: ' + foot.join(' | ')); // Dr AR 590,000 + Dr advances 300,000 + Dr COGS 80,000 (as T06, no materials)
    await shot(owner.page, 'owner-je');
    const advJe = gas.rows('Journal').find((j) => j.docType === 'PAYMENT' && gas.rows('JournalLines').some((l) => l.jeId === j.id && l.jobId === jobId && l.accountCode === '2100' && l.creditPaisa === 30000000)).id;
    await owner.page.goto(base + '#/je/' + advJe);
    await owner.page.waitForSelector('text=1010 Cash in hand - Studio'); // Studio staff receive into studio cash by default
    await owner.page.waitForSelector('text=300,000.00');
    await owner.page.goto(base + '#/');
    await owner.page.waitForSelector('text=Due in the next 14 days');
    await shot(owner.page, 'owner-home');
    await owner.page.goto(base + '#/settings');
    await owner.page.waitForSelector('text=People');
    await shot(owner.page, 'owner-settings');
    assert.deepEqual(owner.errors, [], 'browser errors: ' + owner.errors.join('\n'));

    // ---- Store staff see their own navigation and cannot open journals ----
    const store = await signInAs(browser, base, 'Ali', phone);
    await store.page.waitForSelector('h1:has-text("New sale")');
    await store.page.goto(base + '#/je/' + advJe);
    await store.page.waitForSelector('text=Your role (Store) cannot do this');

    // ---- M4: Finance enters a bill with a photo, pays it with WHT; drawings ----
    const fin = await signInAs(browser, base, 'Sara', { width: 1280, height: 900 });
    const fp = fin.page;
    await fp.goto(base + '#/purchases/bills/new');
    await fp.getByPlaceholder('Search vendor or karigar').fill('Bolton');
    await fp.getByRole('button', { name: /Bolton Market Fabrics/ }).click();
    await fp.locator('select[aria-label=Item]').selectOption({ label: 'Silk organza (M)' });
    await fp.locator('input[aria-label=Quantity]').fill('10');
    await fp.locator('input[aria-label="Cost each"]').fill('2,000');
    await fp.locator('select[aria-label=Tax]').selectOption('ST-IN-STD');
    await fp.getByPlaceholder('Their invoice number').fill('BMF-950');
    await fp.waitForSelector('.kv >> text=Rs 23,600');
    await fp.waitForSelector('.kv >> text=Rs 900'); // WHT preview: 4.5% of 20,000
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await fp.locator('input[type=file]').setInputFiles({ name: 'bill.png', mimeType: 'image/png', buffer: png });
    await shot(fp, 'new-bill');
    await fp.getByRole('button', { name: 'Save bill' }).click();
    await fp.waitForSelector('h1:has-text("Bill BILL-")');
    await fp.waitForSelector('text=Unpaid');
    await fp.waitForSelector('button:has-text("bill.jpg")');
    await shot(fp, 'bill-detail');
    await fp.getByRole('link', { name: 'Pay', exact: true }).click();
    await fp.waitForSelector('text=Pay the vendor');
    await fp.waitForSelector('.kv >> text=Rs 22,700');
    await shot(fp, 'pay-bills');
    await fp.getByRole('button', { name: 'Pay', exact: true }).click();
    await fp.waitForSelector('text=Payment voucher');
    await fp.waitForSelector('text=Withholding tax deducted (WHT-GOODS-F)');
    await shot(fp, 'voucher');
    const bill950 = gas.rows('Bills').find((b) => b.vendorRef === 'BMF-950');
    assert.deepEqual([bill950.balancePaisa, bill950.whtPaisa], [0, 90000]);

    await fp.goto(base + '#/purchases/expense');
    await fp.locator('input[aria-label="Amount"]').fill('5000');
    await fp.getByRole('checkbox', { name: 'Personal / family' }).check();
    await fp.getByPlaceholder('Which family member?').fill('Family');
    await fp.getByRole('button', { name: /Family member/ }).click();
    await fp.getByRole('button', { name: 'Save', exact: true }).click();
    await fp.waitForSelector('text=Drawings recorded');
    assert.ok(gas.rows('Payments').some((p) => p.kind === 'DRAWINGS' && p.amountPaisa === 500000));
    await fp.goto(base + '#/purchases');
    await fp.waitForSelector('text=Who we owe');
    await shot(fp, 'purchases');
    assert.deepEqual(fin.errors, [], 'browser errors: ' + fin.errors.join('\n'));

    // ---- M4: Studio logs karigar work from the Karigars tab ----
    const st = await signInAs(browser, base, 'Hina', phone);
    await st.page.goto(base + '#/karigars');
    await st.page.getByRole('button', { name: 'Log work' }).click();
    const lw = st.page.getByRole('dialog', { name: 'Log karigar work' });
    await lw.getByPlaceholder('Search karigar').fill('Rafiq');
    await lw.getByRole('button', { name: /Rafiq/ }).click();
    await lw.locator('select').first().selectOption({ index: 1 });
    await lw.locator('input[type=number]').fill('5');
    await lw.locator('input[aria-label="Rate per piece"]').fill('1000');
    await lw.getByRole('button', { name: 'Log work' }).click();
    await st.page.waitForSelector('tr:has-text("Rafiq") >> text=5,000.00');
    await shot(st.page, 'karigars');
    await noHorizontalScroll(st.page);

    // ---- M4: Store pays a petty expense ----
    const sp = (await signInAs(browser, base, 'Ali', phone)).page;
    await sp.goto(base + '#/purchases/expense');
    assert.deepEqual(await sp.locator('select').first().locator('option').allTextContents(), ['Petty cash']);
    await sp.locator('input[aria-label="Amount"]').fill('750');
    await sp.locator('select[aria-label=Account]').selectOption('6800');
    await sp.getByPlaceholder('What was it for?').fill('Tea and biscuits');
    await sp.getByRole('button', { name: 'Save', exact: true }).click();
    await sp.waitForSelector('text=Expense saved');
    await noHorizontalScroll(sp);
    assert.ok(gas.rows('Bills').some((b) => b.grossPaisa === 75000 && b.balancePaisa === 0));

    console.log('ok - UI: book, advance, karigar, deliver, balance, receipts and journals (' + (SHOTS ? 'screenshots in ' + SHOTS : 'no screenshots') + ')');
  } catch (e) {
    console.error('not ok - UI test failed:', e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
