# 08. Golden test scenarios

These are the acceptance tests. Implement each as a `node --test` case against `/core`. Amounts below are in **rupees for readability**; tests must use paisa (× 100).

**Tax rates here are TEST FIXTURES ONLY** (`TEST-ST-18` = 1800 bps, `TEST-WHT-SVC-10` = 1000 bps, `TEST-WHT-GOODS-4.5` = 450 bps, card fee 2%). Real rates are configured in `TaxCodes` by the Owner with the tax advisor. Never hard-code rates in `/core`.

Scenarios run **in sequence** on one shared state unless marked standalone. Brand shown in brackets.

---

### T00. Money utilities (standalone)
| Input | Expected |
|---|---|
| `parseRupees("1.25L")` | 12,500,000 paisa |
| `parseRupees("125k")` | 12,500,000 |
| `parseRupees("1,25,000")` | 12,500,000 |
| `parseRupees("Rs 1,250.50")` | 125,050 |
| `formatPaisa(12500050)` | `Rs 125,000.50` |
| `roundHalfEven(2.5)`, `(3.5)`, `(-2.5)` | 2, 4, −2 |
| `splitProRata(100, [1,1,1])` | [33, 33, 34] |
| `splitProRata(10000000, [10,20,6])` | [2777778, 5555556, 1666666] |

### T01. Customer advance (R1)
Customer CUS-00001 Ayesha. Job JOB-2026-00001 (MTO), quoted net Rs 500,000, tax `TEST-ST-18`. Advance Rs 300,000 into Bank.
```
Dr Bank          [UMSHA] 300,000
  Cr Cust. adv.  [UMSHA] 300,000
```
Customer shows: advance held 300,000, owes 0.

### T02. Stock purchases (R2)
a) Bill from registered supplier VEN-00001: FAB-0001 silk organza 50 m @ 2,000 = 100,000; tax claimable 18% = 18,000.
```
Dr Inv fabric  [SHARED] 100,000   (qty 50)
Dr Input tax   [SHARED]  18,000
  Cr AP        [SHARED] 118,000
```
b) Bill from unregistered supplier VEN-00002: TRM-0001 dabka 1,000 g @ 30 = 30,000, no tax.
```
Dr Inv trims [SHARED] 30,000 (qty 1000) / Cr AP [SHARED] 30,000
```
Item balances: FAB-0001 50 m, avg 2,000.00; TRM-0001 1,000 g, avg 30.00.

### T03. Issue to job (R7)
Issue to JOB-2026-00001: FAB-0001 12 m, TRM-0001 400 g.
```
Dr WIP        [UMSHA] 24,000  (FABRIC)
Dr WIP        [UMSHA] 12,000  (TRIMS)
  Cr Inv fabric [SHARED] 24,000
  Cr Inv trims  [SHARED] 12,000
```

### T04. Weighted average (R2 + R7)
Second purchase FAB-0001 30 m @ 2,400 = 72,000 (no tax, unregistered VEN-00002).
Before: 38 m, value 76,000. After: 68 m, value 148,000, `avgCostMicro` = 2,176,470,588.
Issue 10 m to a new job JOB-2026-00002 → value **21,764.71** (2,176,471 paisa). Remaining 58 m, value 126,235.29 (12,623,529 paisa).
Return 2 m from JOB-2026-00002 to stock → at original issue cost: 2 × 2,176.4705… → 4,352.94 (435,294 paisa), split from the issue move proportionally.

### T05. Karigar work and payment with WHT (R3, R5)
a) `karigar.logWork`: VEN-00003 (KARIGAR, `TEST-WHT-SVC-10`), JOB-2026-00001, EMBROIDERY, 40 pieces × 2,000 = 80,000. And VEN-00004 STITCHING 15,000 (no WHT code).
```
Dr WIP [UMSHA] 80,000 (EMBROIDERY) / Cr AP [UMSHA] 80,000
Dr WIP [UMSHA] 15,000 (STITCHING)  / Cr AP [UMSHA] 15,000
```
b) Pay VEN-00003 in full:
```
Dr AP          [UMSHA] 80,000
  Cr Bank      [UMSHA] 72,000
  Cr WHT pay.  [UMSHA]  8,000
```
c) Pay VEN-00001 bill (T02a, gross 118,000) in full, WHT code `TEST-WHT-GOODS-4.5`, `whtBase = EXCL_SALES_TAX` → base 100,000, WHT 4,500:
```
Dr AP [SHARED] 118,000 / Cr Bank [SHARED] 113,500 / Cr WHT pay. [SHARED] 4,500
```

### T06. MTO delivery (R8)
JOB-2026-00001 WIP = fabric 24,000 + trims 12,000 + embroidery 80,000 + stitching 15,000 = **131,000**. Deliver: N 500,000, T 90,000, G 590,000, advance 300,000.
```
Dr AR                 [UMSHA] 590,000
  Cr MTO sales 4010   [UMSHA] 500,000
  Cr Output tax       [UMSHA]  90,000
Dr Cust. adv.         [UMSHA] 300,000
  Cr AR               [UMSHA] 300,000
Dr 5010 Fabric        [UMSHA]  24,000
Dr 5020 Trims         [UMSHA]  12,000
Dr 5030 Embroidery    [UMSHA]  80,000
Dr 5040 Stitching     [UMSHA]  15,000
  Cr WIP              [UMSHA] 131,000
```
Totals: Dr 1,021,000 = Cr 1,021,000. Invoice balance 290,000. Job margin **369,000 (73.8%)**. Then receive 290,000 to Bank (R9) → AR for CUS-00001 = 0, job fully paid.

### T07. Expenses (R4, R6, R18)
a) Bill VEN-00005 landlord: store rent 150,000 [MIRAE], studio rent 100,000 [UMSHA], electricity 40,000 [SHARED], all 6xxx accounts. AP credited per brand: 150,000 / 100,000 / 40,000.
b) Quick expense: photo shoot 45,000 from Bank [MIRAE] → `Dr 6100 [MIRAE] / Cr Bank [MIRAE]`.
c) Personal/family payment 20,000 from Petty cash → `Dr 3020 Drawings [SHARED] 20,000 / Cr Petty cash [SHARED] 20,000`. Must NOT appear on the P&L.

### T08. RTW batch (R10)
JOB-2026-00003 (RTW_BATCH). Assume WIP total 100,000 has been built up via issues and labour. Complete with outputs: SKU-A ×10 (w1), SKU-B ×20 (w1), SKU-C ×3 (w2).
```
Dr Inv FG [MIRAE] 27,777.78  (SKU-A, qty 10)
Dr Inv FG [MIRAE] 55,555.56  (SKU-B, qty 20)
Dr Inv FG [MIRAE] 16,666.66  (SKU-C, qty 3)   ← residual line
  Cr WIP  [MIRAE] 100,000.00
```
Unit cost SKU-A and SKU-B: 277,777.8 paisa (Rs 2,777.78), i.e. `avgCostMicro` = 2,777,778,000. SKU-C: 555,555.33 paisa (Rs 5,555.55).

### T09. Store sale, tax-inclusive (R11)
`rtwPricesIncludeTax = TRUE`. Sale: SKU-A ×1 @ 9,440; SKU-B ×2 @ 5,900 = 11,800. G = 21,240. N = 18,000, T = 3,240. Lines: SKU-A N 8,000 T 1,440; SKU-B N 10,000 T 1,800. Payment: Cash 10,000 + Card 11,240.
COGS: SKU-A 1 × 2,777.778 → 2,777.78; SKU-B 2 × 2,777.778 → 5,555.56; K = 8,333.34.
```
Dr Store cash      [MIRAE] 10,000.00
Dr Card clearing   [MIRAE] 11,240.00
  Cr RTW sales 4100 [MIRAE] 18,000.00
  Cr Output tax     [MIRAE]  3,240.00
Dr COGS RTW        [MIRAE]  8,333.34
  Cr Inv FG        [MIRAE]  8,333.34
```

### T10. Return (R12)
Return 1 × SKU-B from T09, restock, refund to card. Uses original line values: N 5,000, T 900, G 5,900, cost 2,777.78.
```
Dr Sales returns 4900 [MIRAE] 5,000.00
Dr Output tax         [MIRAE]   900.00
  Cr Card clearing    [MIRAE] 5,900.00
Dr Inv FG             [MIRAE] 2,777.78
  Cr COGS RTW         [MIRAE] 2,777.78
```

### T11. Stock count (R15)
SKU-A system qty 9, counted 8. Shortfall 1 at avg → `Dr Shrinkage [MIRAE] 2,777.78 / Cr Inv FG [MIRAE] 2,777.78`.

### T12. Card settlement (R13)
Clearing balance 11,240 − 5,900 = 5,340. Bank receives 5,233.20, fee 106.80.
```
Dr Bank       [SHARED] 5,233.20
Dr Card fees  [MIRAE]    106.80
  Cr Card clearing [SHARED] 5,340.00
```
Clearing balance → 0.

### T13. Idempotency (standalone, API harness)
Call `payments.receiveAdvance` twice with the same `requestId`. Exactly one JE exists; both responses return the same `jeId`.

### T14. Locked period (standalone)
Close 2026-09. Post any document dated 2026-09-15 → `E_PERIOD_LOCKED`. Reopen with reason → succeeds; AuditLog has both events.

### T15. Role enforcement (standalone)
STORE user calls `journal.create` → `E_ROLE`. STUDIO user calls `bills.create` with an EXPENSE line → `E_ROLE`.

### T16. P&L by brand (after T01–T12)
Revenue: UMSHA 500,000; MIRAE 18,000 less returns 5,000 = 13,000 net.
With `allocationKey = REVENUE`, the SHARED electricity 40,000 splits UMSHA 38,986.35 / MIRAE 1,013.65 (residual to last brand). Drawings 20,000 absent from P&L. Assert every column total equals the sum of its lines and Total = UMSHA + MIRAE + SHARED (unallocated view).

### T17. Integrity (after T01–T12)
- Trial balance debits = credits.
- AR control (1200) balance = Σ customer balances = 0.
- AP control (2010) = Σ vendor balances (VEN-00002 30,000 + 72,000; VEN-00004 15,000; VEN-00005 290,000) = 407,000.
- Inventory GL (1300+1310+1340) = stock valuation report.
- WIP (1330) = Σ open job WIP.

### T18. Reversal (R22, standalone)
Reverse the T07b expense. Original and reversal linked; net effect on 6100 and Bank = 0; original status `VOID`; reversing a reversal is rejected.

### T19. QuickBooks export
Export the period. Row count = journal line count; Σ debits = Σ credits; every row has a Class; if any account lacks `qbAccountName`, response lists it and returns no CSV.

### T20. MTO cancellation (R17, standalone)
Job with advance 100,000; cancel with refund 60,000 → `Dr Cust. adv. 100,000 / Cr Bank 60,000 / Cr 4040 Cancellation income 40,000`. WIP of 10,000 written off → `Dr 5070 [UMSHA] 10,000 / Cr WIP [UMSHA] 10,000`.

### T21. Late cost after delivery (R8)
Karigar bill 5,000 STITCHING for JOB-2026-00001 after T06. Single entry: `Dr WIP 5,000 / Cr AP 5,000 / Dr 5040 5,000 / Cr WIP 5,000`, lines flagged `lateCost`. Job margin updates to 364,000.

### T22. Property test
Generate 500 random valid documents across all types with random dates in open periods. After each: entry balanced, no empty brand, no negative stock, TB nets to 0, `ItemBalances` equals a full rebuild from `StockMoves`.

### Dashboard KPIs (see 10-dashboard-kpis.md)

- **T23.** Using state after T01–T12: C4 average job margin = 73.8%; D2 transactions = 1; D3 ATV = Rs 18,000; D9 return rate = 5,000 ÷ 18,000 = 27.78%; A4 advance coverage with advances held 0 → displays "n/a", not divide-by-zero.
- **T24.** `MonthlySummary` after incremental updates equals a full rebuild, for 500 random documents.
- **T25.** Store-role `dashboard.get` for the Overview tab → `E_ROLE`; for the Mirae tab returns only its own store and no cost or margin fields.
