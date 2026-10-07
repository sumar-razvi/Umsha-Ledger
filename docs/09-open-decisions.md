# 09. Open decisions

Claude Code: use the **Default** column and leave `TODO(decision-Dxx)` in code where it matters. Umar resolves these with the family and the tax advisor, then updates this file.

| ID | Question | Default used in build | Owner | Why it matters |
|---|---|---|---|---|
| D-01 | Go-live date and opening balance source | 1st of a month; opening TB entered as one manual journal `OPENING` | Umar + accountant | Clean cut-over |
| D-02 | Is UMSHA / Mirae sales tax registered (FBR and/or SRB)? Under which regime is the Mirae store (e.g. Tier-1 retailer with POS integration)? | Tax codes configurable; `fbrInvoiceNo` field present but not integrated | Tax advisor | Determines output tax on sales and POS obligations |
| D-03 | Is sales tax due on MTO advances at receipt, or at delivery/invoice? | At delivery invoice | Tax advisor | Changes R1 |
| D-04 | WHT base (gross vs excl. sales tax) and rates per vendor type and filer status | Configurable per tax code; default `EXCL_SALES_TAX` | Tax advisor | Changes R5 |
| D-05 | Are karigars paid per piece through bills (vendor model) or on payroll? | Vendor/bill model | Umar | Payroll out of v1 |
| D-06 | Post discounts gross (to 4900) or net in revenue? | Net in revenue, gross + discount stored on document | Accountant | Margin reporting |
| D-07 | Shared cost allocation key | `REVENUE` | Owners | Brand P&L presentation |
| D-08 | Foreign currency: revalue open FX balances at month end? | No revaluation in v1 | Accountant | R19 |
| D-09 | Inventory costing method | Weighted average | Accountant | Changing later requires restatement |
| D-10 | One store or multiple locations for Mirae stock? | Single location, `store` field kept for future | Umar | Stock per location |
| D-11 | Who can approve/close periods (one owner or any owner)? | Any OWNER role | Family | Governance |
| D-12 | Are family members' personal expenses currently paid by the business? Policy for drawings vs salary? | Separate `Drawings` flow, all visible to Owners | Family | Professionalisation, clean P&L |
| D-13 | Bank accounts and wallets in use (names, numbers last 4) | Placeholder Bank 1, Bank 2, JazzCash, Easypaisa, Raast | Umar | Seed CoA |
| D-14 | Depreciation policy and rates for machinery/fit-out | Manual monthly journal | Accountant | Fixed assets out of v1 automation |
| D-16 | KPI targets: monthly revenue per brand, minimum cash, minimum advance %, drawings limit | Seeded placeholders, RAG off until set | Owners | Dashboard colours are meaningless without real targets |
| D-15 | Does the external accountant use QuickBooks Online (which edition supports Class tracking)? | QBO with Class. Built to the documented QBO "Journal entries" import headers (`Journal No., Journal Date, Account, Debits, Credits, Description, Name, Class, Currency`), dates per `Settings.qbDateFormat`; check against the accountant's downloaded template before first use (`TODO(decision-D-15)` in `core/export.js`) | Accountant | Export format |
| D-17 | A bill can carry lines for several brands (e.g. one landlord bill for store, studio and shared rent). When it is paid, which brand do the AP, bank and WHT lines take? | Split the payment pro-rata across the bill's AP balance per brand (`splitProRata`, residual on last brand), so AP by brand clears exactly | Accountant | R5 says "[bill brand]" but a bill has no single brand |
| D-18 | Are document IDs numbered per calendar year or per fiscal year (July–June)? | Calendar year of the document date, Asia/Karachi (`INV-2026-00042`); master data IDs are not year-scoped | Umar + accountant | Numbering restarts every January rather than every July |
| D-19 | How precise are stock quantities (fabric in metres, trims in grams)? | Up to 3 decimal places; core does quantity arithmetic in integer thousandths so it never drifts | Umar | Weighted-average cost and stock counts |
| D-20 | Is an MTO quoted price net of sales tax (tax added on top at delivery) or tax-inclusive? | Net of tax, as in T01/T06 (`quotedPricePaisa` is net; gross = net + tax) | Owners + tax advisor | What the client is told vs what is invoiced |
| D-21 | Card/wallet fees on UMSHA advances: R1 lets an MTO advance go to card clearing [UMSHA], but R13 always charges settlement fees to MIRAE | Follow R13 as written (fees MIRAE); revisit if UMSHA takes meaningful card volume | Accountant | Brand P&L accuracy |
| D-22 | A cost arrives after an RTW batch is completed (late karigar bill). Spread it over the batch's SKUs still in stock, expense it, or refuse? | Refused with `E_JOB_CLOSED`; post it as an expense | Accountant | Batch unit costs vs simplicity |
| D-23 | Break-even (KPI B6) needs fixed vs variable running costs. Which 6xxx accounts are fixed? | All running costs are fixed except card fees (6210) and cash over/short (6810) | Accountant | Break-even revenue on the dashboard |
| D-24 | KPI G7 counts "negative-stock attempts", but a refused posting saves nothing, including its audit row | G7 shows months reopened only; logging refused postings would need a separate write after the failed one | Umar | Controls tab |
