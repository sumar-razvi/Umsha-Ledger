# 02. Product requirements (v1)

Scope for v1: core ledger and reports, sales and receivables, purchases and payables, inventory and job costing, tax capture. **Out of scope:** payroll, FBR POS real-time integration (hook field only), multi-company consolidation, bank feeds.

Priority: **P0** must ship in v1, **P1** should ship, **P2** later.

---

## M1. Foundation: setup, users, audit

| ID | Story | Pri |
|---|---|---|
| M1.1 | As Owner, I can run a one-time **Setup** that creates all tabs with headers and loads seed data from `seed/`. | P0 |
| M1.2 | As Owner, I can add users by Google email and assign one role (Owner, Finance, Studio, Store, Viewer). | P0 |
| M1.3 | As any user, I sign in with Google; unknown emails are rejected. | P0 |
| M1.4 | Every write is recorded in `AuditLog`. Owner can view and filter it. | P0 |
| M1.5 | As Owner, I set company settings: name, NTN/STRN, fiscal year start, base currency, default brand allocation key. | P0 |

**Acceptance:** fresh Sheet + Setup = working system with chart of accounts, tax codes, one Owner user. Second run of Setup is a no-op (does not duplicate).

## M2. Chart of accounts and general ledger

| ID | Story | Pri |
|---|---|---|
| M2.1 | View chart of accounts grouped by type, with balances as at a date, filterable by brand. | P0 |
| M2.2 | Finance/Owner can add accounts and deactivate unused ones. Accounts with postings cannot be deleted or change type. | P0 |
| M2.3 | Finance/Owner can post a **manual journal** (multi-line, each line with brand). Must balance. | P0 |
| M2.4 | Any posted entry can be **reversed** (creates mirror entry dated on a chosen date, links both). | P0 |
| M2.5 | **Account ledger view**: every line for an account in a date range with running balance, click-through to source document. | P0 |
| M2.6 | Recurring journals (e.g. monthly depreciation, rent accrual). | P2 |

## M3. Sales and receivables

### MTO (UMSHA)
| ID | Story | Pri |
|---|---|---|
| M3.1 | Studio creates a **customer** (name, phone in `92xxxxxxxxxx` format, city, notes). Duplicate phone warns. | P0 |
| M3.2 | Studio creates an **MTO order** = Job with quoted price, promised delivery date, line items (e.g. "Bridal lehenga", "Dupatta", "Shirt"). | P0 |
| M3.3 | Record **advance received** against an order (cash, bank, card, wallet, foreign currency). Generates receipt. | P0 |
| M3.4 | Add **extra charges** or **discounts** to an order before delivery. | P1 |
| M3.5 | **Deliver order**: creates invoice from order lines, applies tax code, applies all advances, releases WIP to COGS, closes job. Shows margin. | P0 |
| M3.6 | Record **balance payment** against invoice. Partial payments allowed. | P0 |
| M3.7 | **Cancel order**: refund all/part of advance; forfeited part goes to cancellation income; WIP written off or returned to stock. | P1 |

### RTW (Mirae)
| ID | Story | Pri |
|---|---|---|
| M3.8 | Store staff record a **store sale**: scan/pick SKUs, quantity, discount, payment split (cash + card + wallet). One screen, phone-friendly. | P0 |
| M3.9 | Record **return / exchange** against an original sale. Refund to original method or store credit. | P0 |
| M3.10 | **Daily cash-up**: expected cash by method vs counted; difference posts to over/short. | P1 |
| M3.11 | **Card/wallet settlement**: match bank deposit to clearing balance, fees post to expense. | P1 |
| M3.12 | Online/exhibition sales use the same sale document with channel field. | P1 |
| M3.13 | Gift vouchers / store credit: issue and redeem. | P2 |

### Shared
| ID | Story | Pri |
|---|---|---|
| M3.14 | **Receipt/invoice PDF-style printable view** and a **WhatsApp share** button (`https://wa.me/92xxxxxxxxxx?text=...` with summary + link/attachment instructions). | P0 |
| M3.15 | **AR ageing**: per customer, buckets current / 1–30 / 31–60 / 61–90 / 90+. | P0 |
| M3.16 | Customer statement (all orders, advances, invoices, payments). | P1 |

## M4. Purchases and payables

| ID | Story | Pri |
|---|---|---|
| M4.1 | Create **vendors**, with type: `SUPPLIER` (fabric/trims), `KARIGAR`, `SERVICE` (dyer, courier, landlord), `OTHER`. Capture CNIC/NTN, filer status (affects WHT). | P0 |
| M4.2 | Enter a **bill**: lines are either stock items (qty × rate into inventory), job costs (charged to a Job), or expenses (account + brand). Attach photo of the bill. | P0 |
| M4.3 | Record **bill payment**: full or partial, from bank/cash, with **withholding tax** deducted per vendor tax code. | P0 |
| M4.4 | **Karigar work log**: quick entry "karigar X, job Y, n pieces × rate" that creates a bill against the job. | P0 |
| M4.5 | **Expense (paid immediately)**: one-step bill + payment for petty purchases. | P0 |
| M4.6 | **Advance to vendor/karigar** and later adjust against bills. | P1 |
| M4.7 | **AP ageing** and vendor statement. | P0 |
| M4.8 | **Petty cash** account with top-ups from bank and expenses out. | P0 |

## M5. Inventory and job costing

| ID | Story | Pri |
|---|---|---|
| M5.1 | **Items** master: `FABRIC` (unit meter), `TRIM` (unit pc/gram/meter), `PACKAGING`, `SKU` (finished RTW: style, size, colour, barcode, price). | P0 |
| M5.2 | Stock in via bills; stock valued at **weighted-average cost** per item. | P0 |
| M5.3 | **Issue to job**: move qty of fabric/trims from stock into a Job's WIP at current average cost. Return unused to stock. | P0 |
| M5.4 | **Job cost sheet**: every cost line on a job grouped by component (fabric, trims, embroidery labour, stitching labour, outsourced, other), quoted price, margin %. | P0 |
| M5.5 | **Complete RTW batch**: output qty per SKU; total batch WIP divided across SKUs (equal unit cost by default, or weighted by a per-SKU factor). FG enters stock. | P0 |
| M5.6 | **Stock count**: enter counted qty, system posts adjustment to shrinkage. | P1 |
| M5.7 | **Stock valuation report** at a date; must equal inventory GL balances. | P0 |
| M5.8 | Low-stock flags per item (reorder level). | P2 |
| M5.9 | Negative stock: **blocked by default**; Owner setting can allow with warning. | P0 |

## M6. Banking

| ID | Story | Pri |
|---|---|---|
| M6.1 | Multiple bank, cash, wallet and clearing accounts. | P0 |
| M6.2 | **Transfers** between them (bank → petty cash, clearing → bank). | P0 |
| M6.3 | **Bank reconciliation**: import statement CSV, tick matching ledger lines, show unreconciled differences. Mark lines reconciled with statement date. | P1 |

## M7. Tax capture (no filing)

| ID | Story | Pri |
|---|---|---|
| M7.1 | `TaxCodes` table: sales tax output, input, WHT on purchases (by vendor type and filer status), exempt, zero. Rates editable by Owner, effective-dated. | P0 |
| M7.2 | Invoices and bills compute tax from code; user can override amount with reason (audited). | P0 |
| M7.3 | **Sales tax summary** for a period: output, input, net payable, by rate. | P0 |
| M7.4 | **WHT deducted register**: vendor, CNIC/NTN, gross, rate, deducted, payment date. For the accountant's filing. | P0 |
| M7.5 | Store sale carries optional `fbrInvoiceNo` field for future POS integration. | P1 |

## M8. Reports and exports

| ID | Story | Pri |
|---|---|---|
| M8.1 | **Profit & loss** for a date range, columns: UMSHA, MIRAE, SHARED, Total. Toggle "allocate shared" using allocation key. Comparison to previous period. | P0 |
| M8.2 | **Balance sheet** at a date. | P0 |
| M8.3 | **Trial balance** at a date; must balance. | P0 |
| M8.4 | **Job profitability** list: all MTO jobs delivered in range, revenue, cost, margin %, sortable. | P0 |
| M8.5 | **SKU/collection margin** for RTW. | P1 |
| M8.6 | **Cash position** dashboard: all bank/cash balances, AR due this week, AP due this week, advances held. | P0 |
| M8.7 | **QuickBooks export**: journals in a date range as CSV matching the QuickBooks Online journal import template, with our accounts mapped via `Accounts.qbAccountName` and brand mapped to QBO Class. | P0 |
| M8.8 | Any report → CSV download and print view. | P0 |

## M9. Period close

| ID | Story | Pri |
|---|---|---|
| M9.1 | Owner closes a month: checklist (bank reconciled, cash-up done, stock counted, TB balances) then lock. | P0 |
| M9.2 | Owner can reopen a closed period with reason (audited). | P0 |
| M9.3 | Year-end: close P&L to retained earnings via generated entry. | P1 |

## M10. Dashboard and KPIs

Full spec in `10-dashboard-kpis.md`.

| ID | Story | Pri |
|---|---|---|
| M10.1 | Tabbed dashboard (Overview, Cash, UMSHA, Mirae, Operations, Customers, Controls) with period, brand and comparison filters. | P0 |
| M10.2 | Tiles with value, change vs comparison, RAG against target, sparkline; drill-down to source. | P0 |
| M10.3 | Cash KPIs incl. advance coverage ratio and 30/60-day cash forecast. | P0 |
| M10.4 | MTO KPIs: order book, job margin distribution, on-time delivery, overdue, WIP ageing, cost overruns. | P0 |
| M10.5 | RTW KPIs: sales, ATV, UPT, sell-through, SKU margins, stock cover, aged stock, returns, payment mix. | P0 |
| M10.6 | Operations, customer and control KPIs (karigar spend, repeat rate, concentration, reconciliation, drawings vs limit). | P1 |
| M10.7 | Owner-editable KPI targets and thresholds. | P0 |
| M10.8 | Alerts strip ranked by severity. | P0 |
| M10.9 | Sales heatmap by weekday and hour. | P2 |

---

## Non-functional requirements

| Area | Requirement |
|---|---|
| Performance | Any screen loads in < 3 s on 4G with 20k journal lines. Reports may take < 8 s. Use `CacheService` for account balances, invalidated on write. |
| Reliability | Idempotent writes; client shows "Saving…/Saved/Failed: retry". No silent loss. |
| Security | Google sign-in; ID token verified server-side every request; role checks server-side (UI hiding is cosmetic only). Sheet shared only with the company account. |
| Auditability | Immutable journals, audit log, attachments linked to documents. |
| Usability | Store and Studio screens fully usable on a 375 px wide phone. Big tap targets. Rupee amounts with grouping. |
| Backup | Nightly time-driven trigger copies the Sheet to a dated backup in Drive; keep 30. |
| Portability | Everything exportable to CSV. |
