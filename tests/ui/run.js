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
// Chart.js for the dashboard comes from cdnjs. Point CHART_JS at a local copy
// (chart.umd.js) to test real charts offline; otherwise the table fallback is tested.
const CHART_JS = process.env.CHART_JS || '';
let step = 0;
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, String(++step).padStart(2, '0') + '-' + name + '.png'), fullPage: true });
}

async function signInAs(browser, base, label, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  // No internet in tests: Chart.js comes from a local copy, or an empty script (charts fall back to tables).
  await ctx.route('https://cdnjs.cloudflare.com/**', (route) => (CHART_JS
    ? route.fulfill({ path: CHART_JS, contentType: 'application/javascript' })
    : route.fulfill({ body: '/* Chart.js not available offline */', contentType: 'application/javascript' })));
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
    await owner.page.waitForSelector('h1:has-text("Dashboard")');
    await owner.page.waitForSelector('.tile[data-kpi="C1"]');
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

    // ---- M5: Studio makes SKUs, runs a batch and completes it ----
    const s5 = (await signInAs(browser, base, 'Hina', phone)).page;
    for (const [code, name] of [['SKU-AYLA-S', 'Ayla kurta S'], ['SKU-AYLA-M', 'Ayla kurta M']]) {
      await s5.goto(base + '#/inventory');
      await s5.getByRole('button', { name: 'New item' }).click();
      const it = s5.getByRole('dialog', { name: 'New item' });
      await it.locator('select').first().selectOption('SKU');
      await it.locator('label:has-text("Name") input').fill(name);
      await it.getByPlaceholder('Optional, e.g. SKU-AYLA-M-RED').fill(code);
      await it.locator('input[aria-label="Sale price"]').fill('9440');
      await it.getByRole('button', { name: 'Save' }).click();
      await it.waitFor({ state: 'detached' });
    }
    await s5.goto(base + '#/batches/new');
    await s5.getByPlaceholder('e.g. Winter 26 kurtas, run 1').fill('Ayla run 1');
    await s5.locator('select[aria-label=SKU]').selectOption('SKU-AYLA-S');
    await s5.locator('input[aria-label="Planned pieces"]').fill('10');
    await s5.getByRole('button', { name: '+ Another SKU' }).click();
    await s5.locator('select[aria-label=SKU]').nth(1).selectOption('SKU-AYLA-M');
    await s5.locator('input[aria-label="Planned pieces"]').nth(1).fill('20');
    await s5.getByRole('button', { name: 'Start batch' }).click();
    await s5.waitForSelector('h1:has-text("Ayla run 1")');
    await s5.getByRole('button', { name: 'Issue materials' }).click();
    const iss = s5.getByRole('dialog', { name: /Issue materials/ });
    await iss.locator('select').first().selectOption(await iss.locator('option', { hasText: 'Dabka' }).getAttribute('value'));
    await iss.locator('input[aria-label=Quantity]').fill('100');
    await iss.getByRole('button', { name: 'Issue' }).click();
    await iss.waitFor({ state: 'detached' });
    await s5.getByRole('button', { name: 'Log karigar work' }).click();
    const lk = s5.getByRole('dialog', { name: /Log karigar work/ });
    await lk.getByPlaceholder('Search karigar').fill('Rafiq');
    await lk.getByRole('button', { name: /Rafiq/ }).click();
    await lk.locator('input[type=number]').fill('30');
    await lk.locator('input[aria-label="Rate per piece"]').fill('900');
    await lk.getByRole('button', { name: 'Log work' }).click();
    await lk.waitFor({ state: 'detached' });
    await s5.waitForSelector('.kv >> text=Rs 30,000'); // 100 g dabka at Rs 30 + 30 x 900
    await s5.getByRole('button', { name: 'Complete batch' }).click();
    const cb = s5.getByRole('dialog', { name: /Complete/ });
    await cb.getByText('10,000.00', { exact: true }).waitFor(); // 10 of 30 pieces, equal weights
    await cb.getByText('20,000.00', { exact: true }).waitFor();
    await shot(s5, 'complete-batch');
    await cb.getByRole('button', { name: 'Complete batch' }).click();
    await cb.waitFor({ state: 'detached' });
    await s5.waitForSelector('text=Moved into finished stock');
    const ayM = gas.rows('ItemBalances').find((b) => b.itemId === 'SKU-AYLA-M');
    assert.deepEqual([ayM.qty, ayM.valuePaisa], [20, 2000000]);
    await s5.goto(base + '#/inventory?category=SKU');
    await s5.waitForSelector('text=Ayla kurta M');
    await noHorizontalScroll(s5);

    // ---- M5: Finance counts blind, reviews, posts; valuation reconciles ----
    const f5 = (await signInAs(browser, base, 'Sara', { width: 1280, height: 900 })).page;
    await f5.goto(base + '#/inventory/count');
    await f5.locator('select').first().selectOption('SKU');
    await f5.waitForSelector('text=Ayla kurta M');
    assert.equal(await f5.locator('text=20 PC').count(), 0, 'system quantities must stay hidden while counting');
    await f5.locator('input[aria-label="Counted Ayla kurta M"]').fill('19');
    await f5.locator('input[aria-label="Counted Ayla kurta S"]').fill('10');
    await f5.getByRole('button', { name: 'Review differences' }).click();
    await f5.waitForSelector('td:has-text("-1")');
    await shot(f5, 'count-review');
    await f5.getByRole('button', { name: 'Post count' }).click();
    await f5.waitForSelector('h1:has-text("Inventory")');
    assert.equal(gas.rows('ItemBalances').find((b) => b.itemId === 'SKU-AYLA-M').qty, 19);
    await f5.goto(base + '#/inventory/valuation');
    await f5.waitForSelector('text=Stock on hand agrees with the ledger to the paisa.');
    await shot(f5, 'valuation');
    await f5.goto(base + '#/inventory/items/SKU-AYLA-M');
    await f5.waitForSelector('text=Batch output');
    await f5.waitForSelector('text=Stock count');

    // ---- M6: Store sells (cash + card), returns one, checks Today, cashes up ----
    const sp6 = (await signInAs(browser, base, 'Ali', phone)).page;
    await sp6.waitForSelector('h1:has-text("New sale")');
    await sp6.getByLabel('Find item').fill('8960000000011'); // scan the S barcode
    await sp6.keyboard.press('Enter');
    await sp6.waitForSelector('.cartline >> text=Noor kurta S');
    await sp6.getByLabel('Find item').fill('noor kurta m');
    await sp6.getByRole('button', { name: /Noor kurta M/ }).click();
    await sp6.getByRole('button', { name: 'One more Noor kurta M' }).click();
    await sp6.waitForSelector('.grandtotal:has-text("Rs 28,320")');
    await sp6.getByRole('button', { name: 'Cash', exact: true }).click();
    await sp6.locator('input[aria-label="Cash amount"]').fill('10000');
    await sp6.locator('input[aria-label="Cash given"]').fill('10500');
    await sp6.waitForSelector('text=Change to give');
    await sp6.getByRole('button', { name: 'Card', exact: true }).click(); // defaults to what is left: 18,320
    await sp6.getByLabel('Customer mobile').fill('0345 1112223');
    await shot(sp6, 'new-sale');
    await noHorizontalScroll(sp6);
    await sp6.getByRole('button', { name: 'Complete sale' }).click();
    await sp6.waitForSelector('text=Sale receipt');
    await sp6.waitForSelector('text=Paid Card');
    await shot(sp6, 'sale-receipt');
    const sale6 = gas.rows('Sales').find((x) => x.kind === 'SALE');
    assert.deepEqual([sale6.grossPaisa, sale6.netPaisa, sale6.taxPaisa], [2832000, 2400000, 432000]);
    const pays6 = gas.rows('SalePayments').filter((x) => x.saleId === sale6.id).map((x) => [x.method, x.amountPaisa]);
    assert.deepEqual(pays6, [['CASH', 1000000], ['CARD', 1832000]]);

    await sp6.goto(base + '#/returns');
    await sp6.getByLabel('Find sale').fill(sale6.id);
    await sp6.getByRole('button', { name: 'Find', exact: true }).click();
    await sp6.locator('tr.click', { hasText: sale6.id }).click();
    await sp6.getByRole('button', { name: 'Return one more Noor kurta M' }).click();
    await sp6.waitForSelector('.grandtotal:has-text("Refund Rs 9,440")');
    await sp6.getByRole('button', { name: 'Refund card' }).click();
    await shot(sp6, 'return');
    await sp6.getByRole('button', { name: 'Confirm' }).click();
    await sp6.waitForSelector('h2:has-text("Refund")');
    const ret6 = gas.rows('Sales').find((x) => x.kind === 'RETURN');
    assert.equal(ret6.grossPaisa, 944000);

    await sp6.goto(base + '#/today');
    await sp6.waitForSelector('text=By payment method');
    assert.ok(await sp6.locator('td:has-text("8,880.00")').count() >= 1, 'card takings net of the refund: 18,320 - 9,440');
    await shot(sp6, 'today');
    await sp6.goto(base + '#/cashup');
    await sp6.waitForSelector('text=Rs 10,000');
    await sp6.locator('input[aria-label="Cash counted"]').fill('9,980');
    await sp6.getByRole('button', { name: 'Submit cash-up' }).click();
    await sp6.waitForSelector('text=short by Rs 20');
    await noHorizontalScroll(sp6);

    // ---- M6: Finance settles the card takings ----
    const fp6 = (await signInAs(browser, base, 'Sara', { width: 1280, height: 900 })).page;
    await fp6.goto(base + '#/store');
    await fp6.waitForSelector('text=Card & wallet not yet in bank');
    await fp6.getByRole('button', { name: 'Card settlement' }).click();
    const sd = fp6.getByRole('dialog', { name: 'Card / wallet settlement' });
    await sd.locator('input[aria-label="Fee"]').fill('177.60');
    await sd.getByRole('button', { name: 'Save' }).click();
    await sd.waitFor({ state: 'detached' });
    await fp6.waitForSelector('.tile:has-text("Card & wallet not yet in bank") >> text=Rs 0');
    await shot(fp6, 'store');

    // ---- M7: Owner reads the P&L, drills down, posts a journal, closes a month ----
    const op = (await signInAs(browser, base, 'Umar', { width: 1280, height: 900 })).page;
    await op.goto(base + '#/reports');
    await op.getByRole('link', { name: /Profit & loss by brand/ }).click();
    await op.waitForSelector('text=Gross profit');
    await op.getByRole('button', { name: 'Split by revenue' }).click();
    await op.waitForSelector('text=shared costs split by each brand');
    await shot(op, 'pnl');
    assert.equal(await op.locator('th', { hasText: 'Shared' }).count(), 0, 'allocated view has no Shared column');
    await op.getByRole('button', { name: 'Show separately' }).click();
    await op.waitForSelector('th:has-text("Shared")');
    const revenueCell = op.locator('tr', { hasText: 'RTW sales - store' }).locator('a').first();
    await revenueCell.click();
    await op.waitForSelector('h1:has-text("4100 RTW sales - store")');
    await shot(op, 'ledger-drilldown');
    await op.locator('table.data a', { hasText: 'JE-' }).first().click();
    await op.waitForSelector('h1:has-text("Journal entry")');
    await op.locator('p.muted a', { hasText: 'SALE-' }).first().click();
    await op.waitForSelector('text=Sale receipt');

    await op.goto(base + '#/reports/trial-balance');
    await op.waitForSelector('text=Debits equal credits.');
    await op.goto(base + '#/journals/new');
    await op.getByPlaceholder('What is this journal for?').fill('Audit fee accrual');
    await op.locator('select[aria-label=Account]').nth(0).selectOption('6300');
    await op.locator('input[aria-label=Debit]').nth(0).fill('25000');
    await op.locator('select[aria-label=Account]').nth(1).selectOption('2300');
    await op.locator('input[aria-label=Credit]').nth(1).fill('24000');
    await op.waitForSelector('text=Out by');
    await op.locator('input[aria-label=Credit]').nth(1).fill('25000');
    await op.waitForSelector('text=Balanced');
    await op.getByRole('button', { name: 'Post journal' }).click();
    await op.waitForSelector('h1:has-text("Journal entry")');
    await op.waitForSelector('text=6300 Professional fees');

    const lastMonth = new Date(Date.UTC(2026, 8, 1)).toISOString().slice(0, 7); // 2026-09, nothing posted
    await op.goto(base + '#/settings');
    await op.locator('.kv', { hasText: lastMonth }).getByRole('button', { name: 'Close' }).click();
    const cm = op.getByRole('dialog', { name: 'Close ' + lastMonth });
    await cm.getByText('Trial balance balances').waitFor();
    await shot(op, 'close-month');
    await cm.getByRole('checkbox').check();
    await cm.getByRole('button', { name: 'Close ' + lastMonth }).click();
    await cm.waitFor({ state: 'detached' });
    assert.equal(gas.rows('Periods').find((x) => x.id === lastMonth).status, 'CLOSED');

    await op.goto(base + '#/reports/sales-tax');
    await op.waitForSelector('text=Output tax charged on sales');
    await op.goto(base + '#/reports/cash');
    await op.waitForSelector('text=Cash and bank');
    await shot(op, 'cash-position');

    // ---- M8: Finance imports a bank statement, reconciles it, exports for QuickBooks ----
    const today = gas.context.Dates.karachiDate();
    const jeDate = Object.fromEntries(gas.rows('Journal').map((j) => [j.id, j.date]));
    const bankLines = gas.rows('JournalLines').filter((l) => l.accountCode === '1100' && jeDate[l.jeId] <= today);
    const ledgerBal = bankLines.reduce((s, l) => s + l.debitPaisa - l.creditPaisa, 0);
    const dmy = (d) => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
    const csvText = 'Statement of account\nDate,Narration,Amount\n' + bankLines.map((l, i) => dmy(jeDate[l.jeId]) + ',Line ' + (i + 1) + ',' + ((l.debitPaisa - l.creditPaisa) / 100).toFixed(2)).join('\n') +
      '\n' + dmy(today) + ',"Service charges, Sept",-500.00\n';
    const fb = (await signInAs(browser, base, 'Sara', { width: 1280, height: 900 })).page;
    await fb.goto(base + '#/banking');
    await fb.waitForSelector('h1:has-text("Banking")');
    await fb.getByRole('link', { name: 'Import statement' }).click();
    await fb.waitForSelector('h1:has-text("Import a bank statement")');
    await fb.locator('select[aria-label=Account]').selectOption('1100');
    await fb.locator('input[aria-label="Statement file"]').setInputFiles({ name: 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csvText) });
    await fb.waitForSelector('text=' + (bankLines.length + 1) + ' lines');
    await fb.locator('.field', { hasText: 'Statement end date' }).locator('input').fill(today);
    await fb.locator('input[aria-label="Closing balance on the statement"]').fill(((ledgerBal - 50000) / 100).toFixed(2));
    await shot(fb, 'bank-import');
    await fb.getByRole('button', { name: 'Import' }).click();
    await fb.waitForSelector('text=Statement balance');
    assert.ok(await fb.getByRole('button', { name: 'Finish reconciliation' }).isDisabled(), 'the bank charge is not in the ledger yet');
    await fb.getByRole('button', { name: 'Record bank charge' }).click();
    const bc = fb.getByRole('dialog', { name: /Bank charge/ });
    await bc.getByRole('button', { name: 'Record' }).click();
    await bc.waitFor({ state: 'detached' });
    await fb.waitForSelector('button:has-text("Finish reconciliation"):not([disabled])');
    await shot(fb, 'bank-rec');
    await fb.getByRole('button', { name: 'Finish reconciliation' }).click();
    await fb.waitForSelector('.pagehead .status:has-text("Reconciled")');
    const rec = gas.rows('BankRecs').at(-1);
    assert.equal(rec.status, 'RECONCILED');
    assert.equal(gas.rows('JournalLines').filter((l) => l.accountCode === '1100' && l.reconciled).length, bankLines.length + 1);

    await fb.goto(base + '#/accounts');
    await fb.locator('table.data tr', { hasText: '6600' }).first().click();
    const as = fb.getByRole('dialog', { name: /6600/ });
    await as.locator('.field', { hasText: 'QuickBooks account name' }).locator('input').fill('Bank Service Charges');
    await as.getByRole('button', { name: 'Save' }).click();
    await as.waitFor({ state: 'detached' });
    assert.equal(gas.rows('Accounts').find((a) => a.code === '6600').qbAccountName, 'Bank Service Charges');
    await fb.goto(base + '#/reports/quickbooks');
    await fb.waitForSelector('h1:has-text("QuickBooks export")');
    const dl = fb.getByRole('button', { name: /Download .*\.csv/ });
    if (await dl.count()) {
      const [download] = await Promise.all([fb.waitForEvent('download'), dl.click()]);
      const body = fs.readFileSync(await download.path(), 'utf8');
      assert.match(body.split('\n')[0], /^Journal No\.,Journal Date,Account,Debits,Credits/);
      assert.match(body, /Bank Service Charges/);
    } else {
      await fb.waitForSelector('text=have no QuickBooks name yet');
    }
    await shot(fb, 'quickbooks');

    // ---- M10: dashboards for the Owner (desktop), Store and Studio (phone) ----
    const db = (await signInAs(browser, base, 'Umar', { width: 1280, height: 900 }));
    const dp = db.page;
    await dp.goto(base + '#/');
    await dp.waitForSelector('h1:has-text("Dashboard")');
    await dp.waitForSelector('.tile[data-kpi="A1"] .value');
    assert.equal(await dp.locator('.dashtabs a').count(), 7);
    assert.ok(await dp.locator('.alerts li').count() >= 1, 'alerts strip');
    await dp.waitForSelector('[data-chart="B1-trend"] ' + (CHART_JS ? 'canvas' : 'table'));
    await shot(dp, 'dashboard-overview');
    await dp.locator('.tile[data-kpi="B1"]').click();
    await dp.waitForSelector('h1:has-text("Profit")');
    await dp.goBack();
    await dp.locator('.dashtabs a', { hasText: 'Cash' }).click();
    await dp.waitForSelector('.tile[data-kpi="A3"]');
    await dp.waitForSelector('[data-chart="A5"] ' + (CHART_JS ? 'canvas' : 'table'));
    await shot(dp, 'dashboard-cash');
    for (const [name, kpi] of [['UMSHA', 'C4'], ['Mirae', 'D3'], ['Operations', 'E1'], ['Customers', 'F1'], ['Controls', 'G4']]) {
      await dp.locator('.dashtabs a', { hasText: name }).click();
      await dp.waitForSelector('.tile[data-kpi="' + kpi + '"]');
    }
    await dp.locator('select[aria-label=Period]').selectOption('YTD');
    await dp.waitForURL(/period=YTD/);
    await dp.waitForSelector('.tile[data-kpi="G4"]');
    await dp.locator('select[aria-label=Compare]').selectOption('TARGET');
    await dp.waitForURL(/cmp=TARGET/);
    await dp.waitForSelector('.tile[data-kpi="G4"]');
    await dp.goto(base + '#/settings');
    await dp.locator('table.data tr', { hasText: 'minCash' }).click();
    const kt = dp.getByRole('dialog', { name: /Target minCash/ });
    await kt.locator('.field', { hasText: 'Red at' }).locator('input').fill('100000000');
    await kt.getByRole('button', { name: 'Save' }).click();
    await kt.waitFor({ state: 'detached' });
    assert.equal(gas.rows('KpiTargets').find((t) => t.kpi === 'minCash').redAt, 100000000);
    await dp.goto(base + '#/dashboard?tab=CASH&period=MTD&brand=ALL&cmp=PREVIOUS');
    await dp.waitForSelector('.tile.rag-red[data-kpi="A1"]');
    assert.deepEqual(db.errors, [], 'browser errors: ' + db.errors.join('\n'));

    const dsp = (await signInAs(browser, base, 'Ali', phone)).page;
    await dsp.goto(base + '#/today');
    await dsp.getByRole('link', { name: 'Dashboard' }).click();
    await dsp.waitForSelector('.tile[data-kpi="D2"]');
    assert.equal(await dsp.locator('.dashtabs').count(), 0, 'Store has one tab only');
    assert.ok(!/cost|margin/i.test(await dsp.locator('#view').innerText()), 'no cost or margin for Store');
    await noHorizontalScroll(dsp);
    await shot(dsp, 'dashboard-store');

    const dst = (await signInAs(browser, base, 'Hina', phone)).page;
    await dst.waitForSelector('h1:has-text("Orders")');
    await dst.getByRole('link', { name: 'Dashboard' }).click();
    await dst.waitForSelector('.tile[data-kpi="C1"]');
    assert.deepEqual(await dst.locator('.dashtabs a').allTextContents(), ['UMSHA (MTO)', 'Operations']);
    await noHorizontalScroll(dst);
    await shot(dst, 'dashboard-studio');

    console.log('ok - UI: book, advance, karigar, deliver, balance, receipts and journals (' + (SHOTS ? 'screenshots in ' + SHOTS : 'no screenshots') + ')');
  } catch (e) {
    console.error('not ok - UI test failed:', e.message);
    for (const c of browser.contexts()) for (const p of c.pages()) { const t = await p.locator('.notice, .sheet').allInnerTexts().catch(() => []); if (t.length) console.error('page', p.url(), t.join(' | ').slice(0, 600)); }
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
