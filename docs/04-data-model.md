# 04. Data model (Google Sheets)

One spreadsheet. One tab per table. **Row 1 = headers exactly as listed** (camelCase). `Db.gs` maps headers to object keys, so column order can change but names cannot.

Conventions:
- `id` is the primary key in column A of every tab.
- Amounts suffixed `Paisa` are integers.
- Rates suffixed `Bps` are integer basis points.
- Dates `YYYY-MM-DD` (stored as text, force with a leading format `@` on the column, to stop Sheets auto-converting).
- Timestamps ISO 8601 with offset (`2026-10-06T14:05:00+05:00`).
- Booleans `TRUE`/`FALSE`.
- Soft delete only via `isActive` / `status`. No row deletion anywhere.
- `createdBy`, `createdAt` on every document tab.

## ID formats (`core/ids.js`)

All IDs are allocated server-side from the `Sequences` tab under the script lock.

| Kind | Format | Sequence key | Example |
|---|---|---|---|
| Documents and ledger | `PREFIX-YYYY-NNNNN` (year of the document date, see D-18) | `PREFIX-YYYY` | `INV-2026-00042` |
| Master data | `PREFIX-` + zero-padded number, width per prefix | `PREFIX` | `CUS-00001`, `FAB-0001`, `FAM-001` |
| Child rows (lines) | parent ID + `-` + 2-digit line no. | none | `JE-2026-00981-01` |

Document prefixes: `JE` journal, `INV` invoice, `BILL` bill, `JOB` job, `PAY` payment, `SALE` sale/return/exchange, `SM` stock move, `CNT` stock count, `CUP` cash-up, `REC` bank rec, `ATT` attachment, `AUD` audit log.
Master prefixes and widths: `CUS` 5, `VEN` 5, `FAM` 3, `FAB` 4, `TRM` 4, `PKG` 4, `SKU` 6 (SKUs may instead use `SKU-<style>-<size>-<colour>`), `USR` 3.
Numbers widen past the pad width rather than wrap (`INV-2026-100000`).

---

## Configuration tabs

### `Settings` (key/value)
| key | example | notes |
|---|---|---|
| companyName | UMSHA | |
| rtwBrandName | Mirae | name printed on store receipts |
| ntn | | |
| strn | | sales tax registration |
| baseCurrency | PKR | |
| fiscalYearStartMonth | 7 | July |
| timezone | Asia/Karachi | |
| allocationKey | REVENUE | REVENUE / FIXED / NONE |
| allocationUmshaPctBps | 6000 | used when FIXED |
| currencyGrouping | STANDARD | STANDARD (`Rs 125,000`) or INDIAN (`Rs 1,25,000`) |
| rtwPricesIncludeTax | TRUE | |
| allowNegativeStock | FALSE | |
| defaultMtoRevenueAccount | 4010 | |
| storeCashAccount | 1020 | store cash drawer (sales, refunds, cash-up) |
| walletAccount | 1120 | where "Wallet" payments at the till go |
| backupFolderId | | Drive folder |
| attachmentsFolderId | | Drive folder |
| qbDateFormat | DD/MM/YYYY | date format in the QuickBooks export (`DD/MM/YYYY`, `MM/DD/YYYY` or `YYYY-MM-DD`; match the QuickBooks company's region) |
| bankMapping:&lt;code&gt; | `{"dateColumn":"Date",...}` | written by the statement import: the column mapping last used for that bank account, so the next import is pre-filled |
| whatsappReceiptTemplate | `Dear {name}, thank you. Received Rs {amount} for {docId}. Balance Rs {balance}. UMSHA` | |

### `Users`
`id, email, name, role, store, isActive, createdAt`
IDs `USR-001`. Emails are stored lower case. There is always at least one active Owner.
role ∈ `OWNER, FINANCE, STUDIO, STORE, VIEWER`. `store` used for STORE role (e.g. `MIRAE-KHI-01`).

### `Accounts`
`id, code, name, type, subType, normalBalance, isContra, systemKey, defaultBrand, isMoney, moneyKind, qbAccountName, isActive, sortOrder`
- type ∈ `ASSET, LIABILITY, EQUITY, REVENUE, COGS, EXPENSE, OTHER, TAX`
- isMoney = TRUE for accounts selectable as "paid from / received into"; moneyKind ∈ `CASH, BANK, WALLET, CLEARING, PETTY`
- `id` = code as string (simple).

### `TaxCodes`
`id, name, kind, rateBps, claimable, whtBase, appliesTo, vendorFilerStatus, effectiveFrom, effectiveTo, isActive, notes`
- kind ∈ `SALES_OUTPUT, PURCHASE_INPUT, WHT, EXEMPT, ZERO`
- appliesTo ∈ `GOODS, SERVICES, ANY`
- vendorFilerStatus ∈ `FILER, NON_FILER, ANY` (for WHT)
- Lookup by (id, document date) picks the row whose effective range contains the date.

### `Periods`
`id (YYYY-MM), startDate, endDate, status, closedBy, closedAt, reopenReason`
status ∈ `OPEN, CLOSED`.

### `Sequences`
`id (prefix-year e.g. INV-2026), next`
Incremented only under script lock.

---

## Master data

### `Contacts`
`id, kind, name, phone, email, city, address, cnic, ntn, strn, filerStatus, vendorType, whtTaxCodeId, defaultBrand, openingBalancePaisa, notes, isActive, createdBy, createdAt`
- kind ∈ `CUSTOMER, VENDOR, BOTH, FAMILY`
- vendorType ∈ `SUPPLIER, KARIGAR, SERVICE, OTHER`
- phone normalised to `92XXXXXXXXXX` (no plus, no leading zero).
- FAMILY = owner/family members for drawings (R18).
- IDs: `CUS-00001`, `VEN-00001`, `FAM-001`. A contact of kind `BOTH` gets a `CUS-` ID. Kind can change only between CUSTOMER/VENDOR and BOTH.

### `Items`
`id, category, name, unit, style, size, colour, collection, barcode, salePricePaisa, taxCodeId, reorderLevel, isActive, createdAt`
- category ∈ `FABRIC, TRIM, PACKAGING, SKU`
- unit ∈ `M, PC, G, SET`
- IDs: `FAB-0001`, `TRM-0001`, `PKG-0001`, `SKU-<style>-<size>-<colour>` or `SKU-000001`.

### `ItemBalances` (cache, rebuildable)
`itemId, qty, avgCostMicro, valuePaisa, lastMoveId, updatedAt`
Maintained on every stock move under lock **and** fully rebuildable from `StockMoves` by `rebuildItemBalances()`. Needed so average cost is O(1) to read. A nightly check compares it to a rebuild and logs any drift to `AuditLog`.
The rebuild replays moves in **row (posting) order**, not date order: weighted average depends on the order stock was actually received and issued, so a back-dated entry does not re-cost later movements.
Quantities are decimals with up to 3 places (D-19); `core/inventory.js` does the arithmetic in integer thousandths.

---

## Jobs

### `Jobs`
`id, type, brand, contactId, title, description, quotedPricePaisa, taxCodeId, bookedDate, promisedDate, deliveredDate, status, revenueAccount, invoiceId, collection, notes, createdBy, createdAt`
- type ∈ `MTO_ORDER, RTW_BATCH`
- status ∈ `OPEN, IN_PRODUCTION, READY, DELIVERED, CANCELLED` (MTO); `OPEN, COMPLETED, CANCELLED` (RTW)
- brand: `UMSHA` for MTO, `MIRAE` for RTW (set by type, not user-editable)

### `JobLines` (quoted items for MTO; planned output for RTW)
`id, jobId, description, itemId, qty, unitPricePaisa, discountPaisa, weight, sortOrder`
- MTO: e.g. "Bridal lehenga, red, with dupatta" × 1 @ price.
- RTW: SKU itemId × planned qty, weight for cost split.

---

## Documents

All documents share header fields: `id, date, contactId, brand, status, memo, jeId, attachmentIds, requestId, createdBy, createdAt`. `attachmentIds` is a JSON list of `Attachments` IDs.
status ∈ `DRAFT, POSTED, VOID` (VOID = reversed).

### `Invoices` (MTO delivery invoices and other customer invoices)
header + `jobId, dueDate, netPaisa, taxPaisa, grossPaisa, taxCodeId, taxOverrideReason, advanceAppliedPaisa, paidPaisa, balancePaisa`

### `InvoiceLines`
`id, invoiceId, description, itemId, qty, unitPricePaisa, discountPaisa, netPaisa, revenueAccount`

### `Sales` (RTW store / online / exhibition sales)
header + `kind, channel, store, netPaisa, taxPaisa, grossPaisa, discountPaisa, pricesIncludeTax, fbrInvoiceNo, originalSaleId` (originalSaleId set for returns)
- `kind` ∈ `SALE, RETURN, EXCHANGE`; `channel` ∈ `STORE, ONLINE, EXHIBITION`

### `SaleLines`
`id, saleId, itemId, qty, unitPricePaisa, discountPaisa, netPaisa, taxPaisa, unitCostMicro, costPaisa, restock, returnedQty, returnedNetPaisa, returnedTaxPaisa, returnedCostPaisa, originalLineId`
Lines of a RETURN (and the returned part of an EXCHANGE) are stored with negative qty and amounts and point to the sold line in `originalLineId`. `SalePayments` of refunds are negative, so a day's takings by method net them off.
`unitCostMicro` snapshot at time of sale, so returns use original cost (R12). The `returned*` columns on a sale's lines are updated by each return or exchange against it (docUpdate `SALE_LINE`), so a partial return is valued pro rata and the last piece returned takes exactly what is left.

### `SalePayments`
`id, saleId, method, accountCode, amountPaisa, reference`
method ∈ `CASH, CARD, BANK, WALLET, STORE_CREDIT`.

### `Bills`
header + `vendorRef (their invoice no.), dueDate, netPaisa, taxPaisa, grossPaisa, paidPaisa, whtPaisa, balancePaisa`

### `BillLines`
`id, billId, lineKind, accountCode, itemId, qty, unitCostPaisa, jobId, costComponent, brand, taxCodeId, netPaisa, taxPaisa, description`
lineKind ∈ `STOCK, JOB, EXPENSE`.
`brand` is the line's brand after posting rules (SHARED for raw stock, the job's brand for job lines, chosen for expenses). A bill's gross per brand (Σ `netPaisa + taxPaisa` by `brand`) is what payments are split by (D-17); the server passes it to the posting engine as `bills[id].grossByBrand`.
`paidPaisa` on Bills counts everything settled against the bill, cash **plus** WHT withheld; `balancePaisa = grossPaisa − paidPaisa`.

### `Payments` (money in/out not tied to a sale)
header + `direction, kind, moneyAccountCode, amountPaisa, whtPaisa, whtTaxCodeId, currency, fxAmount, fxRate, reference`
- direction ∈ `IN, OUT`
- kind ∈ `CUSTOMER_ADVANCE, CUSTOMER_PAYMENT, VENDOR_PAYMENT, VENDOR_ADVANCE, REFUND, EXPENSE_PAID, DRAWINGS, TRANSFER, SETTLEMENT, TAX_PAYMENT, OTHER`

### `PaymentAllocations`
`id, paymentId, docType, docId, amountPaisa, whtPaisa`
docType ∈ `INVOICE, BILL, JOB` (JOB for advances against an MTO order). For bills, `amountPaisa` is what was settled (cash + WHT) and `whtPaisa` the tax withheld on it, so a reversed payment can give both back to the bill.

**Quick expenses (R6)** are stored as a fully paid bill (`Bills` + `BillLines`, lineKind `EXPENSE`, balance 0) plus a `Payments` row of kind `EXPENSE_PAID` allocated to it. Both point to the same journal entry (docType `EXPENSE`, docId = the bill ID); reversing it voids both. **Drawings (R18)** are a `Payments` row of kind `DRAWINGS`. **Vendor advances** are `VENDOR_ADVANCE` payments; a bill paid from an advance credits `VENDOR_ADV` instead of cash.

### `StockMoves`
`id, date, itemId, qty (signed), unitCostMicro, valuePaisa (signed), moveType, docType, docId, jobId, sourceMoveId, jeId, createdAt`
moveType ∈ `PURCHASE, ISSUE, RETURN_TO_STOCK, BATCH_OUTPUT, SALE, SALE_RETURN, ADJUSTMENT, OPENING, REVERSAL`.
- `sourceMoveId`: for `RETURN_TO_STOCK`, the `ISSUE` move it returns (so the return is valued at the original issue cost, R7); for `REVERSAL`, the move it reverses (R22).
- An `ADJUSTMENT` with qty 0 clears value left behind when a reversal empties an item (R22).

### `StockCounts` / `StockCountLines`
`id, date, location, status, jeId, createdBy` / `id, countId, itemId, systemQty, countedQty, diffQty, valuePaisa`

### `CashUps`
`id, date, store, expectedCashPaisa, countedCashPaisa, diffPaisa, expectedCardPaisa, notes, jeId, createdBy`

### `BankRecs` / `BankStatementLines`
`id, accountCode, statementDate, statementBalancePaisa, status, createdBy, createdAt, reconciledBy, reconciledAt` / `id, recId, date, description, amountPaisa, matchedJeLineId`
- IDs `REC-2026-00003`; statement lines `REC-2026-00003-001`.
- `status` ∈ `OPEN, RECONCILED`. A reconciliation can only be finished when every statement line is matched and the difference is zero.
- `amountPaisa` is signed like the account's ledger (debit − credit): money in positive, money out negative.
- Matching writes `BankStatementLines.matchedJeLineId` and sets `JournalLines.reconciled`/`reconciledDate` (from empty, the only change ever made to a posted line).

---

## Ledger (append-only)

### `Journal`
`id, date, docType, docId, memo, isManual, isClosing, reversesJeId, reversedByJeId, requestId, createdBy, createdAt`
- docType ∈ `PAYMENT, BILL, EXPENSE, INVOICE, SALE, STOCK_ISSUE, STOCK_RETURN, BATCH_COMPLETION, JOB_CANCELLATION, STOCK_COUNT, CASHUP, MANUAL, OPENING, CLOSING`. For `STOCK_ISSUE`, `STOCK_RETURN`, `BATCH_COMPLETION` and `JOB_CANCELLATION`, `docId` is the job ID.
- A reversal has the same docType/docId as the entry it reverses, plus `reversesJeId`.
- `reversedByJeId` is the one column of `Journal` written after posting: set once, from empty to the reversing entry's ID, in the same locked write as the reversal. It is a link, not an amount; nothing financial on `Journal` ever changes.

### `JournalLines`
`id, jeId, date, accountCode, brand, debitPaisa, creditPaisa, contactId, jobId, itemId, qty, costComponent, currency, fxAmount, fxRate, lateCost, reconciled, reconciledDate, memo`
- `date` duplicated from header so reports filter one tab.
- `reconciled`/`reconciledDate` are the **only** columns that may be updated after posting (bank rec). Everything else is immutable.
- `qty` is signed with the stock direction on inventory lines (negative when stock goes out).
- Every line on AR, AP, customer advances and vendor advances has a `contactId`; every WIP line has a `jobId`; every inventory line has an `itemId`. `core/validate.js` rejects entries that break this, which is what keeps control accounts equal to their sub-ledgers.
- Reports read `Journal.isClosing` joined onto each line as `isClosing`, so the P&L can leave year-end closing entries out.

---

## System

### `AuditLog`
`id, ts, userEmail, action, docType, docId, requestId, summary, before, after`
before/after are compact JSON (for settings/master data edits).

### `Requests` (idempotency)
`requestId, action, userEmail, ts, responseJson`
Pruned of rows older than 30 days by the nightly trigger (the one tab whose rows are ever removed; it is a retry log, not a record). A requestId replays only for the same user and action. Failed requests are not stored, so they can be retried with the same requestId.

### `Attachments`
`id, docType, docId, driveFileId, fileName, mimeType, uploadedBy, uploadedAt`

---

## Dashboard tabs (module M10)

`KpiTargets`, `MonthlySummary`, `DailySales`, and new column `Jobs.budgetCostPaisa`. Defined in `10-dashboard-kpis.md`; as built:

### `KpiTargets`
`id, kpi, brand, period, target, amberAt, redAt, direction, notes`
- Seeded from `seed/kpi_targets.csv` (`KT-001` …); new rows continue the numbering. `kpi` is one of `Kpis.TARGET_KEYS`. `target`, `amberAt`, `redAt` are whole numbers in the KPI's unit (paisa, bps, ratio × 10,000, days). Blank thresholds mean the tile is not coloured.
- One row per `kpi` + `brand` + `period` (`ANY` or `YYYY-MM`; a month row wins over `ANY`).

### `MonthlySummary` (cache, rebuildable, no key column)
`month, accountCode, brand, isClosing, debitPaisa, creditPaisa, lineCount`
- One row per month, account, brand and `isClosing` (year-end closing entries are kept apart so profit figures can leave them out, as the P&L does).
- Every write adds its own journal lines inside the same lock (`Summaries.apply` before `Db.commit`); `nightly` rebuilds it from `JournalLines` and logs any drift (`nightly.drift`, docType `SUMMARY`).

### `DailySales` (cache, rebuildable, no key column)
`date, store, channel, netPaisa, taxPaisa, costPaisa, discountPaisa, transactions, units, returnsNetPaisa, cardPaisa`
- From posted (not VOID) `Sales`/`SaleLines`, by the document's date. `netPaisa`, `taxPaisa`, `discountPaisa`, `units`: goods sold before returns; `returnsNetPaisa`: net value taken back on that date; `costPaisa`: cost of goods sold less cost of goods returned; `transactions`: `SALE` documents (returns and exchanges are not transactions); `cardPaisa`: money into card/wallet clearing accounts (refunds negative), used for the age of unsettled card takings.
- A write that adds or voids a sale recomputes that date and store's rows.

---

## Performance notes for Claude Code

- `JournalLines` will be the largest tab (≈ 5–15k rows/year). Reports read it once per request with `getDataRange().getValues()` and aggregate in memory. That is fine to ~200k rows.
- Cache per-account balances by month in `CacheService` (6 h TTL, key `bal:<yyyymm>`), cleared on any post.
- Sheets cell limit is 10M cells; at ~20 columns we have headroom for decades.
- Add an `Archive` strategy only if `JournalLines` exceeds 150k rows (P2).
