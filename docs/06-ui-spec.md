# 06. UI specification

Single `index.html`. Hash routing (`#/sales/new`, `#/jobs/JOB-2026-00012`). Vanilla JS components as functions returning DOM. No framework.

## Global

- **Top bar**: company name, date, user + role, sync indicator (`Saved` / `Saving…` / `Offline: n pending`).
- **Navigation** depends on role (sidebar on desktop, bottom tab bar on mobile ≤ 768 px).
- **Money input**: rupee field that accepts `125000`, `1,25,000`, `125k`, `1.25L` and shows formatted `Rs 125,000`. Converts to paisa. Shared component.
- **Contact picker**: type-ahead by name or phone; "+ New" inline.
- **Item picker**: type-ahead by name/barcode; camera barcode scan (P2).
- **Brand pill**: coloured tag UMSHA / MIRAE / SHARED everywhere a line appears.
- **Pending queue**: if a write fails due to network, keep it in memory + `localStorage` with its `requestId`, retry with backoff; never re-generate the `requestId`. Show count in top bar.
- **Every document view** shows: status, linked JE (expandable debit/credit table for Finance/Owner), attachments, audit trail, actions (Print, WhatsApp, Reverse).
- Design: clean, quiet, luxury feel. Off-white background, near-black text, one accent colour, generous spacing, serif display font for headings (configurable), system sans for data. Tabular numerals for all amounts (`font-variant-numeric: tabular-nums`). Right-align amounts.

## Navigation by role

| Role | Tabs |
|---|---|
| Owner | Home, Orders (MTO), Store (RTW), Purchases, Inventory, Banking, Reports, Settings |
| Finance | Home, Orders, Store, Purchases, Inventory, Banking, Reports, Journals |
| Studio | Orders, Inventory (issue/return), Karigars |
| Store | New sale, Returns, Today, Cash-up |
| Viewer | Reports |

## Screens

### Home (Owner/Finance)
Cash position tiles (each bank/cash/wallet balance), "Advances held", "Customers owe", "We owe", "Due this week" lists, this month's P&L mini table by brand, orders due for delivery in next 14 days, alerts (unreconciled > 30 days, negative stock attempts, period not closed).

### Orders (MTO)
- **List**: filters status, due date, customer. Columns: Job ID, customer, title, promised date, quoted, advance held, cost to date, status. Overdue rows highlighted.
- **New order**: customer, title, lines (description, qty, price), tax code, promised date, notes, optional first advance in the same screen.
- **Order detail** (the key screen): header, quote lines, money panel (quoted / advances / balance due), **live cost sheet** grouped by component with % of quote and projected margin, timeline (booked, materials issued, karigar work, fittings, delivered). Actions: Receive advance, Issue materials, Log karigar work, Add charge/discount, Deliver, Cancel, WhatsApp customer.
- **Deliver**: preview of invoice, advances applied, balance due, margin; confirm; then offer "Receive balance now".

### Store (RTW): phone-first
- **New sale**: item search/scan, cart with qty steppers, discount per line or whole cart, total. Payment step: big buttons Cash / Card / Bank / Wallet, split allowed, change due for cash. Optional customer phone for WhatsApp receipt. Confirm → receipt screen with WhatsApp + Print.
- **Returns**: find original sale by receipt no./phone/date, pick lines and qty, restock toggle, refund method (original / store credit).
- **Today**: list of today's sales and returns for this store, totals by payment method.
- **Cash-up**: expected cash shown, enter counted, notes, submit.

### Purchases
- **Bills list** with status (open/part-paid/paid), due date, vendor.
- **New bill**: vendor, vendor ref, date, due date, attachment (photo upload from phone), line grid with line kind switch (Stock item / Job cost / Expense). Live totals, tax, and WHT preview.
- **Pay bills**: pick vendor, tick open bills, amount, WHT auto-calculated (editable with reason), paid from account.
- **Quick expense**: date, paid from, category (expense account), brand, amount, tax code, note, photo. Toggle **"Personal / family"** → drawings.
- **Karigars**: list karigars with balance owed; quick "Log work" form (karigar, job, component, pieces, rate).

### Inventory
- **Items** list by category with qty, avg cost, value; filter low stock.
- **Item detail**: movements ledger with running qty and value.
- **Issue to job / return** forms.
- **RTW batch**: create batch, issue materials, log work, complete batch (output SKUs and qty, weights).
- **Stock count**: pick category/location, enter counted qty in a grid (prefilled system qty hidden until submit to avoid bias), review differences, post.

### Banking
Account list with balances; account ledger; transfer form; card settlement form; bank reconciliation screen (statement lines left, ledger lines right, tick to match, difference shown live).

### Reports
Each report: parameter bar (dates, brand allocation toggle, compare), table, **Download CSV**, **Print**. Drill-down: click any amount → account ledger filtered → click line → source document.

P&L layout:
```
                      UMSHA     MIRAE    SHARED     TOTAL
Revenue
  MTO sales            …
  RTW sales                       …
  Returns & discounts             (…)
Net revenue
Cost of sales
  Fabric               …          …
  Trims …
  Labour: embroidery …
Gross profit
  GP %
Operating expenses
  Rent                                      …
  …
Operating profit
Other income/expense
Net profit before tax
```

### Journals (Finance/Owner)
List, filter by doc type/date/account; manual journal entry grid (account, brand, debit, credit, memo) with live balance check; reverse action.

### Settings (Owner)
Company, users and roles, chart of accounts (with QuickBooks mapping column), tax codes (effective-dated), periods (close/reopen with checklist), allocation key, backups (last backup time, "Back up now").

## Printable documents
Invoice, receipt, sale receipt (80 mm thermal-friendly CSS option), customer statement, vendor payment voucher with WHT. All via `@media print` on the same page. Show company NTN/STRN where set.

## Implementation notes (M3)

- The page loads `core.bundle.js` (generated, identical to `Core.gs`) so money parsing/formatting, tax previews and permission checks in the browser use the same tested code as the server.
- Writes go into a queue in `localStorage` with their `requestId` before they are sent; network failures and `E_BUSY` are retried with backoff (2 s doubling to 60 s), other errors are shown and dropped. The top bar shows `Saved` / `Saving…` / `Offline: n pending`.
- Form rows wrap plain inputs in `<label>`; composite controls (pickers) use a `<div>`, because a label forwards clicks to its first control.
- M4: Purchases (bills list + "Who we owe" ageing, new bill with stock/job/expense lines and live WHT preview, bill detail with photos, pay bills with per-bill WHT that can be changed only with a reason, quick expense with the Personal/family toggle, vendor advance), Vendors, Karigars (balances and "Log work"), and Tax codes in Settings. Store staff get a "Petty expense" tab limited to petty cash. Photos are downscaled on the phone (max 1600 px JPEG) before upload.
- Not yet built screens show a "arrives in milestone Mx" page rather than being hidden, so each role's navigation matches the table above.

## WhatsApp
`https://wa.me/<92XXXXXXXXXX>?text=<encoded>` from `Settings.whatsappReceiptTemplate`. Opens WhatsApp with prefilled text; user attaches the printed PDF if needed. No WhatsApp API integration in v1.
