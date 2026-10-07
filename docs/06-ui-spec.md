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
- M5: Inventory (items by kind with qty, average cost, value and low-stock flags; new/edit item incl. SKU fields; item movement ledger), Stock valuation (stock vs ledger per account, must agree to the paisa), blind Stock count (system quantities hidden until "Review differences"), Mirae production batches (new batch with planned SKUs and cost weights, issue materials, log work, complete with a live per-SKU cost preview computed exactly as the server does), and "Return materials" on orders and batches. Studio gets a Batches tab.
- M6: New sale (scan a barcode or search; cart with steppers and line or whole-sale discounts spread pro-rata; tax-inclusive total computed as the server will post it; big Cash / Card / Bank / Wallet buttons with split amounts and change due; optional customer mobile, creating the customer if new), Returns and exchanges (find by receipt, mobile or name; refund value computed exactly as posted; refund to cash, card, bank or store credit; exchange pays or refunds only the difference), Today (takings by method, receipts), Cash-up (expected vs counted), and a Store page for Owner/Finance with card settlement and cash deposits. Sale receipts default to the 80 mm layout.
- M7: Reports hub; P&L by brand with the allocation toggle and an optional previous-period column; balance sheet; trial balance; cash position (warns when cash is below advances held); profit by order; Mirae margin by SKU and collection; customers owe / we owe ageing; sales tax (with "record payment of this return"); withholding tax register (with "record deposit"); audit log. Every report has a date bar with This month / Last month / Year to date, CSV and Print. Drill-down: P&L or balance sheet amount → account ledger → journal entry → source document. Journals: list and a manual journal form with a live balance check (stock accounts not offered). Settings: month close shows the checklist; warnings must be ticked before closing; year-end close.
- M9: Audit log (Reports): date range, search, person and document filters (kept in the URL), and a detail sheet per entry showing who, when, the request ID, a link to the document and a before/after table of the fields that changed. Any open sheet closes when the page changes. Staff guide: `docs/USER-GUIDE.md`.
- M10: Dashboard. Owner and Finance land on it (Home); Studio opens it from Orders (UMSHA and Operations tabs), Store from Today (Mirae tab, own store). Tabs, period (Today … 12 months, Custom), brand (Overview) and comparison selectors live in the URL (`#/dashboard?tab=CASH&period=MTD&brand=ALL&cmp=PREVIOUS`). Tiles show value, change with ▲/▼ (green when the change is good, so a fall in overdue bills is green), a left-edge colour from KpiTargets, a 12-month sparkline and a note; every tile links to its report or list. Charts use Chart.js from cdnjs (`CONFIG.CHART_JS_URL`); if it cannot load, each chart is shown as a table. Phones: two tiles per row, charts scroll sideways and open at the latest dates. Auto-refresh every 5 minutes while visible, plus Refresh and an "updated hh:mm" stamp. Settings: Dashboard targets (Owner) and System → Rebuild dashboard summaries.
- M8: Banking (Owner, Finance): money accounts with balances and last reconciled date, list of reconciliations, Transfer. Import statement: choose account and CSV, map columns (remembered per account), preview the first lines, enter statement end date and closing balance. Reconcile: statement and ledger side by side, suggested matches already paired, tap a statement line then a ledger line to pair (amounts must agree), tap again to undo; the running difference shows statement balance vs ledger balance less uncleared items plus items not yet in the ledger; "Record bank charge" posts an unmatched debit as a 6600 expense; Finish only when the difference is zero. QuickBooks export (Reports): date range, counts, download, or the list of accounts that still need a QuickBooks name. Chart of accounts (Reports, Banking, Settings): balances, add, edit name / brand / QuickBooks name, switch off. Settings → System: download any tab as CSV.
- Not yet built screens show a "arrives in milestone Mx" page rather than being hidden, so each role's navigation matches the table above.

## WhatsApp
`https://wa.me/<92XXXXXXXXXX>?text=<encoded>` from `Settings.whatsappReceiptTemplate`. Opens WhatsApp with prefilled text; user attaches the printed PDF if needed. No WhatsApp API integration in v1.
