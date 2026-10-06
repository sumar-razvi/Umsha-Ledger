# 03. Accounting rules and posting engine

This is the most important document. `core/posting.js` implements exactly these rules. Each rule has a test in `docs/08-test-scenarios.md`.

## 1. Fundamentals

- Double entry. Each document produces exactly one journal entry (`JE-…`) with two or more lines. Exception: a delivery produces one entry containing revenue, advance application and COGS lines together.
- Amounts in **paisa** (integer). Each line has either `debit > 0` or `credit > 0`, never both, never negative.
- Every line has: `accountCode`, `brand` (`UMSHA|MIRAE|SHARED`), optional `jobId`, `contactId`, `itemId`, `qty`, `costComponent`, `memo`.
- Normal balances: Assets, Expenses, COGS = debit. Liabilities, Equity, Revenue = credit. Contra accounts (sales returns, accumulated depreciation) flagged in `Accounts.isContra`.

### Rounding
- Tax computed per document (not per line) using banker's rounding to the nearest paisa: `roundHalfEven(netPaisa * rateBps / 10000)`. Rates stored as **basis points** (18% = 1800).
- Weighted-average cost stored as **paisa per unit with 4 decimal places of precision** (`avgCostMicro` = paisa × 10,000) to avoid drift; issue values are rounded to paisa per movement. Any residual from batch cost splits goes to the last SKU line so totals match exactly.
- When a movement takes an item's quantity to exactly zero, its value is the item's **entire remaining value** (not qty × avg), so no paisa are stranded in stock.
- Tax-inclusive documents compute N and T at document level, then split N and T to lines with `splitProRata` weighted by line gross (needed for per-SKU margin).
- WHT on partial payments with `whtBase = EXCL_SALES_TAX`: `base = round(paid × billNet / billGross)`.

## 2. Chart of accounts structure

Full seed in `seed/chart_of_accounts.csv`. Ranges:

| Range | Type |
|---|---|
| 1000–1999 | Assets |
| 2000–2999 | Liabilities |
| 3000–3999 | Equity |
| 4000–4999 | Revenue |
| 5000–5999 | Cost of sales |
| 6000–6999 | Operating expenses |
| 7000–7999 | Other income / expense |
| 8000–8999 | Taxation |

**System accounts** (the posting engine references them by `systemKey`, never by hard-coded code number, so the CoA can be renumbered):

| systemKey | Default code | Name |
|---|---|---|
| `AR` | 1200 | Accounts receivable |
| `CARD_CLEARING` | 1210 | Card & wallet clearing |
| `INV_FABRIC` | 1300 | Inventory: raw fabric |
| `INV_TRIMS` | 1310 | Inventory: trims & embellishments |
| `INV_PACKAGING` | 1320 | Inventory: packaging |
| `WIP` | 1330 | Work in progress: jobs |
| `INV_FG` | 1340 | Finished goods: RTW |
| `VENDOR_ADV` | 1400 | Advances to vendors & karigars |
| `INPUT_TAX` | 1500 | Input sales tax |
| `AP` | 2010 | Accounts payable |
| `CUSTOMER_ADV` | 2100 | Customer advances (MTO deposits) |
| `STORE_CREDIT` | 2110 | Gift vouchers & store credit |
| `OUTPUT_TAX` | 2200 | Output sales tax |
| `WHT_PAYABLE` | 2210 | Withholding tax payable |
| `OWNER_DRAWINGS` | 3020 | Owner drawings |
| `RETAINED_EARNINGS` | 3030 | Retained earnings |
| `SALES_RETURNS` | 4900 | Sales returns & discounts |
| `CANCEL_INCOME` | 4040 | Order cancellation income |
| `COGS_RTW` | 5100 | Cost of goods sold: RTW |
| `SHRINKAGE` | 5900 | Inventory adjustments & shrinkage |
| `CARD_FEES` | 6210 | Payment processing fees |
| `CASH_OVER_SHORT` | 6810 | Cash over / short |
| `FX_GAIN_LOSS` | 7010 | Exchange gain / loss |
| `ROUNDING` | 7030 | Rounding differences |

Each item category maps to an inventory account (`FABRIC→INV_FABRIC`, `TRIM→INV_TRIMS`, `PACKAGING→INV_PACKAGING`, `SKU→INV_FG`).

### Job cost components → COGS accounts

When a job's WIP is released, each cost line keeps its `costComponent` and goes to the matching COGS account. This gives a COGS breakdown on the P&L for free.

| costComponent | COGS account |
|---|---|
| `FABRIC` | 5010 Fabric consumed |
| `TRIMS` | 5020 Trims & embellishments consumed |
| `EMBROIDERY` | 5030 Embroidery labour (karigar) |
| `STITCHING` | 5040 Stitching & tailoring labour |
| `OUTSOURCED` | 5050 Dyeing, printing & outsourced work |
| `PACKAGING` | 5060 Packaging |
| `OTHER` | 5070 Other direct costs |

## 3. Brand segment rules

| Document | Brand assigned |
|---|---|
| MTO order, its advances, its job costs, its invoice | `UMSHA` |
| RTW batch, store sales, returns, SKU stock moves | `MIRAE` |
| Raw fabric/trim purchases into stock | `SHARED` (stock is shared until issued to a job) |
| Issue from stock to job | Stock credit line `SHARED`, WIP debit line = job's brand |
| Expense bill lines | Chosen per line by the user; default from `Accounts.defaultBrand` |
| Bank, cash, AP, AR, tax lines | Brand of the document they belong to; transfers and tax settlements `SHARED` |

Because the issue-to-job entry has a `SHARED` credit and a branded debit on balance-sheet accounts, brand-level balance sheets don't balance. **That is expected.** Only the P&L is reported by brand. The trial balance and balance sheet are company-level.

### Shared cost allocation (reporting only, never posted)
P&L report option "Allocate shared costs" splits each `SHARED` P&L line between UMSHA and MIRAE using the key in `Settings.allocationKey`:
- `REVENUE` (default): by each brand's net revenue in the period
- `FIXED`: by `Settings.allocationUmshaPct` (e.g. 6000 bps = 60%)
- `NONE`: show SHARED column

This is a presentation choice, so it never creates journal entries. Defensible: it can be changed without restating the books.

## 4. Posting rules by document

Notation: `Dr ACCOUNT [brand] amount`. `N` = net amount, `T` = tax, `G` = gross = N + T.

### R1. Customer advance received (MTO)
```
Dr  Bank/Cash/CARD_CLEARING   [UMSHA]  A
  Cr CUSTOMER_ADV             [UMSHA]  A     (contactId, jobId)
```
No revenue, no tax at this point (default; see decision D-03).

### R2. Purchase bill: stock items
```
Dr  INV_FABRIC / INV_TRIMS / INV_PACKAGING  [SHARED]  N   (itemId, qty)
Dr  INPUT_TAX                                [SHARED]  T   (only if vendor STRN-registered and tax code is claimable)
  Cr AP                                      [SHARED]  G   (contactId)
```
Updates the item's weighted-average cost: `newAvg = (oldQty*oldAvg + N) / (oldQty + qty)`. Non-claimable tax is added to N (capitalised into stock cost).

### R3. Purchase bill: job cost (incl. karigar work log)
```
Dr  WIP        [job brand]  N   (jobId, costComponent)
Dr  INPUT_TAX  [job brand]  T   (if claimable)
  Cr AP        [job brand]  G
```

### R4. Purchase bill: expense line
```
Dr  6xxx expense  [user-chosen brand]  N
Dr  INPUT_TAX     [same brand]          T  (if claimable)
  Cr AP           [same brand]          G
```
A bill can mix R2, R3, R4 lines; the engine sums the AP credit per brand.

### R5. Bill payment (with withholding tax)
WHT = `roundHalfEven(base * whtRateBps / 10000)`, where rate comes from the vendor's WHT tax code and filer status, and `base` is the amount being paid either including or excluding sales tax per `TaxCodes.whtBase` (`GROSS` or `EXCL_SALES_TAX`, decision D-04).
```
Dr  AP           [bill brand]  P            (P = amount of bill being settled)
  Cr Bank/Cash   [bill brand]  P − W
  Cr WHT_PAYABLE [bill brand]  W
```
Partial payments allowed; WHT computed on each payment. Paying against vendor advance: `Dr AP / Cr VENDOR_ADV`.

### R6. Expense paid immediately
Equivalent to R4 + R5 in one entry with no AP line:
```
Dr  6xxx expense  [brand]  N
Dr  INPUT_TAX     [brand]  T
  Cr Bank/Cash    [brand]  G − W
  Cr WHT_PAYABLE  [brand]  W     (if applicable)
```

### R7. Issue stock to job
```
Dr  WIP                      [job brand]  V   (jobId, costComponent = item category)
  Cr INV_FABRIC/INV_TRIMS    [SHARED]     V   (itemId, qty negative)
```
`V = round(qty * avgCost)`. Return to stock is the exact reverse at the **original issue cost** (look up the issue movement), not current average.

### R8. MTO delivery (invoice + advance application + cost release), one entry
Given job J with net price N, tax T, advances held A, WIP balance C (by component):
```
Dr  AR                [UMSHA]  G                    (contactId, jobId)
  Cr 4010/4020 Revenue [UMSHA]  N   (per invoice line revenue account)
  Cr OUTPUT_TAX        [UMSHA]  T
Dr  CUSTOMER_ADV      [UMSHA]  min(A, G)
  Cr AR               [UMSHA]  min(A, G)
Dr  50xx COGS by component [UMSHA]  C_component    (one line per component)
  Cr WIP              [UMSHA]  C                    (jobId)
```
- If `A > G` (overpaid), the excess stays in CUSTOMER_ADV and the order shows "refund due".
- Job status → `DELIVERED`. Margin = N − C.
- Any WIP posted to the job after delivery (late karigar bill) posts as R3 and then **immediately** releases to COGS in the same entry, flagged `lateCost = true`.

### R9. Customer payment against invoice
```
Dr  Bank/Cash/CARD_CLEARING  [doc brand]  P
  Cr AR                      [doc brand]  P
```

### R10. RTW batch completion
Batch WIP total C, output SKUs `s` with qty `q_s` and weight `w_s` (default 1):
```
Dr  INV_FG  [MIRAE]  C_s   (itemId = s, qty = q_s)   for each SKU
  Cr WIP    [MIRAE]  C     (jobId)
```
`C_s = round(C * q_s*w_s / Σ(q*w))`; rounding residual added to the last line. Each SKU's average cost updates as in R2.

### R11. RTW store sale
For each line: unit price, qty, line discount. N = Σ(price×qty − discount). Tax per tax code (prices may be **tax-inclusive**, see `Settings.rtwPricesIncludeTax`; if so, `N = round(G * 10000 / (10000 + rateBps))`, `T = G − N`).
```
Dr  Cash/CARD_CLEARING/Bank/STORE_CREDIT  [MIRAE]  per payment method split, Σ = G
  Cr 4100/4110/4120 RTW sales by channel  [MIRAE]  N
  Cr OUTPUT_TAX                           [MIRAE]  T
Dr  COGS_RTW   [MIRAE]  K   (K = Σ qty × avgCost per SKU)
  Cr INV_FG    [MIRAE]  K   (itemId, qty negative)
```
Discounts are recorded net in revenue **and** the gross/discount are stored on the document for reporting. (Option: post discounts to SALES_RETURNS; decision D-06.)

### R12. RTW return / exchange
Reverse of R11 for returned lines, **at the original sale's price and cost**, revenue side to SALES_RETURNS:
```
Dr  SALES_RETURNS  [MIRAE]  N_r
Dr  OUTPUT_TAX     [MIRAE]  T_r
  Cr Cash/CARD_CLEARING/STORE_CREDIT  [MIRAE]  G_r
Dr  INV_FG    [MIRAE]  K_r     (if restockable; else Dr SHRINKAGE)
  Cr COGS_RTW [MIRAE]  K_r
```
An exchange = return + new sale in one transaction; only the difference moves cash.

### R13. Card / wallet settlement
```
Dr  Bank       [SHARED]  S − F
Dr  CARD_FEES  [MIRAE]   F
  Cr CARD_CLEARING [SHARED]  S
```

### R14. Transfer between money accounts
```
Dr  To account    [SHARED]  X
  Cr From account [SHARED]  X
```

### R15. Stock count adjustment
Diff = counted − system qty, valued at avg cost V:
- Shortfall: `Dr SHRINKAGE [item brand] V / Cr INV_x [item brand] V`
- Surplus: reverse.
Item brand = `MIRAE` for SKUs, `SHARED` for raw materials.

### R16. Daily cash-up difference
`Dr/Cr CASH_OVER_SHORT [MIRAE] / Cr/Dr Store cash [MIRAE]`

### R17. MTO order cancellation
Advance A, refund R, forfeited F = A − R:
```
Dr  CUSTOMER_ADV   [UMSHA]  A
  Cr Bank/Cash     [UMSHA]  R
  Cr CANCEL_INCOME [UMSHA]  F
```
WIP: either return materials to stock (reverse R7) or write off `Dr 5070 Other direct costs / Cr WIP`.

### R18. Owner drawings / family payments
```
Dr  OWNER_DRAWINGS  [SHARED]  X   (contactId = family member)
  Cr Bank/Cash      [SHARED]  X
```
The UI offers "Personal / family" as an explicit option on the expense screen so these are never misclassified as business expenses.

### R19. Foreign currency receipt
Amount in foreign currency `F`, rate `r` (PKR per unit, entered by user): PKR = round(F × r). Store `currency`, `fxAmount`, `fxRate` on the line. Posted in PKR only. No revaluation in v1 (decision D-08).

### R20. Sales tax settlement (manual, after return filed)
```
Dr  OUTPUT_TAX  [SHARED]  Out
  Cr INPUT_TAX  [SHARED]  In
  Cr Bank       [SHARED]  Out − In
```
### R21. WHT deposit
`Dr WHT_PAYABLE / Cr Bank` [SHARED].

### R22. Reversal
Mirror of the original: every debit becomes a credit, same accounts, brands, job/contact/item refs. `reversesJeId` and `reversedByJeId` link both. Inventory reversals restore qty at original cost and recompute average.

### R23. Year-end close
For fiscal year ending date D: for each P&L account, a line bringing its balance to zero, net to RETAINED_EARNINGS [SHARED]. Generated, dated D, flagged `isClosing = true`.

## 5. Validation rules (core/validate.js)

| Code | Rule |
|---|---|
| `E_UNBALANCED` | Σ debits ≠ Σ credits |
| `E_EMPTY_BRAND` | Line with missing/invalid brand |
| `E_NEG_AMOUNT` | Negative or both-sided line |
| `E_PERIOD_LOCKED` | Entry date in closed period |
| `E_INACTIVE_ACCOUNT` | Posting to deactivated account |
| `E_NEG_STOCK` | Movement would make item qty < 0 (unless allowed) |
| `E_JOB_CLOSED` | Cost posted to a cancelled job (delivered jobs allowed, see R8 late cost) |
| `E_OVERPAY` | Payment exceeds open balance of document (unless "on account" chosen) |
| `E_ROLE` | User role not permitted for action |
| `E_DUP_REQUEST` | Not an error: returns stored result |
| `E_TAX_OVERRIDE_NO_REASON` | Tax amount overridden without reason |

## 6. Derived balances

Account balances are **always derived** from `JournalLines`. `Balances` cache (CacheService, keyed by account+date bucket) is an optimisation that is invalidated on every write. Never store a running balance as the source of truth.

Sub-ledger balances:
- Customer balance = Σ AR lines for contactId − CUSTOMER_ADV lines for contactId (shown separately: "owes" vs "advance held").
- Vendor balance = Σ AP lines for contactId.
- Job cost = Σ WIP debits for jobId (+ released COGS after delivery).
- Item qty/value = Σ StockMoves for itemId.
