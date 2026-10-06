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
| D-15 | Does the external accountant use QuickBooks Online (which edition supports Class tracking)? | QBO with Class | Accountant | Export format |
