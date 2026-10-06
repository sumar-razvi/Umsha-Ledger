# 10. Dashboard and KPIs

Module **M10**. A tabbed dashboard with tiles, trends and alerts, all derived from the ledger and documents. No KPI is ever typed in by hand. Every number is clickable down to the report or documents behind it.

## Layout

| Tab | Audience | Purpose |
|---|---|---|
| Overview | Owner, Finance | One-screen health check: cash, profit, order book, store, alerts |
| Cash | Owner, Finance | Liquidity, forecast, advance coverage, payables |
| UMSHA (MTO) | Owner, Finance, Studio (no company P&L) | Order book, margins, delivery performance |
| Mirae (RTW) | Owner, Finance, Store (own store, sales KPIs only) | Sales, basket, stock, collections |
| Operations | Owner, Finance, Studio | Karigars, materials, purchasing |
| Customers | Owner, Finance | Repeat, concentration, top clients |
| Controls | Owner, Finance | Tax, reconciliation, governance |

Global controls: **period** (Today, WTD, MTD, QTD, YTD fiscal, Last 12 months, custom), **brand** (All, UMSHA, MIRAE), **compare to** (previous period, same period last year, target). Auto-refresh every 5 minutes while the tab is visible, plus a manual refresh button and "updated hh:mm" stamp.

Each tile shows: value, change vs comparison (▲/▼ and %), RAG colour against target, sparkline (12 points). Charts use Chart.js from cdnjs.

## KPI catalogue

Notation: all money in paisa internally. "Period" = selected period. Fiscal year starts July.

### A. Cash and liquidity

| # | KPI | Formula | Visual | Target/RAG |
|---|---|---|---|---|
| A1 | Cash on hand | Σ balances of `isMoney` accounts excl. STORE_CREDIT | Tile + 90-day line | Red below `minCash` |
| A2 | Net cash flow | Σ movements on money accounts in period | Tile, monthly bars (in vs out) | |
| A3 | Cash runway (days) | A1 ÷ average daily cash outflow over last 90 days | Tile | Red < 30, amber < 60 |
| A4 | Advance coverage ratio | A1 ÷ customer advances held (2100) | Tile | **Red < 1.0** (deposits are being spent on other things) |
| A5 | 30 / 60-day cash forecast | A1 + balances due on MTO orders promised in window + AR due + unsettled card clearing − AP due − average monthly opex (pro-rata) | Line chart with daily projected balance | Red if any day < 0 |
| A6 | Unsettled card/wallet clearing | Balance of 1210 and items older than 3 days | Tile | Amber if any > 3 days |
| A7 | Payables due | AP due in 7 days, and overdue | Tile pair | Red if overdue > 0 |
| A8 | Receivables due | AR due in 7 days, and overdue | Tile pair | |

### B. Profitability (company and brand)

| # | KPI | Formula | Visual |
|---|---|---|---|
| B1 | Net revenue | Revenue accounts net of 4900, by brand | Tile per brand + 12-month stacked bars |
| B2 | Gross profit and GM % | Net revenue − COGS (5xxx), by brand | Tile + 12-month line per brand |
| B3 | Operating expenses and % of revenue | Σ 6xxx ÷ net revenue | Tile + trend |
| B4 | Net profit | P&L bottom line | Tile + trend |
| B5 | Brand contribution after shared costs | Brand GP − brand opex − allocated shared (per allocation key) | Waterfall chart |
| B6 | Break-even monthly revenue | Average monthly fixed opex ÷ GM % (trailing 3 months) | Tile, with % of break-even achieved MTD |
| B7 | Revenue vs target | Net revenue ÷ `KpiTargets` monthly target, by brand | Progress bar |
| B8 | Cost mix | Fabric, trims, embroidery, stitching, outsourced, RTW COGS as % of revenue | 100% stacked bar by month |

### C. UMSHA made-to-order

| # | KPI | Formula | Visual |
|---|---|---|---|
| C1 | Order book | Count and quoted value of jobs `OPEN/IN_PRODUCTION/READY` | Tile |
| C2 | Bookings vs deliveries | Quoted value of jobs booked in period vs invoiced in period | Paired monthly bars |
| C3 | Average order value | Invoiced net ÷ jobs delivered | Tile + trend |
| C4 | Average job margin % | Σ (net − cost) ÷ Σ net, jobs delivered in period | Tile + histogram of job margins (bands <30%, 30–50, 50–70, >70) |
| C5 | Cost overrun rate | % of delivered jobs where actual cost > `budgetCostPaisa`; average overrun % | Tile + list of worst 5 |
| C6 | On-time delivery % | Jobs delivered on or before `promisedDate` ÷ jobs delivered | Tile + trend |
| C7 | Average lead time | Mean days booked → delivered | Tile |
| C8 | Overdue orders | Open jobs past `promisedDate` | Tile + list |
| C9 | Advance at booking % | First advance ÷ quoted gross, average | Tile; amber below `minAdvancePct` |
| C10 | WIP value and age | WIP balance; value of jobs open > 60 days | Tile + aged bar (0–30, 31–60, 61–90, 90+) |
| C11 | Balance outstanding after delivery | AR on delivered MTO invoices; DSO = AR ÷ (trailing 90-day credit sales ÷ 90) | Tile |
| C12 | Cancellation rate | Jobs cancelled ÷ jobs booked; forfeited income | Tile |
| C13 | Pipeline by stage | Count of jobs by status | Funnel / horizontal bar |

### D. Mirae ready-to-wear

| # | KPI | Formula | Visual |
|---|---|---|---|
| D1 | Sales today / WTD / MTD | Net RTW revenue by store and channel | Tiles + daily bars |
| D2 | Transactions | Count of `SALE` documents | Tile |
| D3 | Average transaction value | Sales net of tax, before returns ÷ transactions | Tile + trend |
| D4 | Units per transaction | Units sold ÷ transactions | Tile |
| D5 | Sell-through % by collection | Units sold ÷ units produced (batch output), per collection | Bar per collection |
| D6 | GM % by collection and SKU | (Net − cost) ÷ net | Table: top 10 and bottom 10 SKUs |
| D7 | Stock value and stock cover | FG value at cost; cover days = FG value ÷ average daily RTW COGS (90 days) | Tile |
| D8 | Aged stock | FG value of SKUs with no sale in 90+ days | Tile + list |
| D9 | Return rate | Returned net ÷ gross net sales | Tile; amber > `maxReturnPct` |
| D10 | Discount rate | Discounts ÷ sales before discount | Tile |
| D11 | Payment mix | % cash / card / bank / wallet | Donut |
| D12 | Sales by channel | Store / online / exhibition | Stacked bar |
| D13 | Shrinkage % | Shrinkage (5900, MIRAE) ÷ net RTW sales | Tile |
| D14 | Cash-up variance | Σ over/short in period, count of days with variance | Tile |
| D15 | Sales heatmap | Net sales by weekday × hour (from `createdAt`) | Heatmap (P2) |

### E. Operations and purchasing

| # | KPI | Formula | Visual |
|---|---|---|---|
| E1 | Karigar spend | Σ EMBROIDERY + STITCHING job costs in period | Tile + top 10 karigars bar |
| E2 | Average rate per piece by component | Karigar bill amount ÷ pieces, by component, trailing 90 days | Table with change vs prior 90 days |
| E3 | Material stock value and cover | Fabric + trims value; cover = value ÷ average daily issue value | Tiles |
| E4 | Low-stock items | Items below `reorderLevel` | Count + list |
| E5 | Purchase spend by supplier | Top 10 suppliers by bills in period | Bar |
| E6 | Days payable outstanding | AP ÷ (trailing 90-day purchases ÷ 90) | Tile |
| E7 | Material price trend | Average purchase cost per metre for top 5 fabrics, monthly | Line |

### F. Customers

| # | KPI | Formula | Visual |
|---|---|---|---|
| F1 | Active customers | Distinct customers with a sale or delivery in period | Tile |
| F2 | New vs returning | First-ever purchase in period vs prior purchase (matched on phone) | Stacked bar |
| F3 | Repeat rate | Customers with 2+ purchases in last 12 months ÷ active customers (12 months) | Tile |
| F4 | Top customers | Lifetime net revenue, MTO + RTW | Table (Owner only) |
| F5 | Revenue concentration | Top 10 customers' share of trailing 12-month revenue | Tile; amber > `maxConcentrationPct` |
| F6 | Cross-brand customers | Customers who bought from both UMSHA and Mirae | Tile |

### G. Controls and governance

| # | KPI | Formula | Visual |
|---|---|---|---|
| G1 | Sales tax position | Output − input tax, period to date | Tile |
| G2 | WHT not yet deposited | Balance of 2210 and oldest item age | Tile |
| G3 | Reconciliation status | Days since last reconciled statement per bank | Tile per bank; red > 35 days |
| G4 | Last closed period | Most recent `CLOSED` month | Tile; red if more than one month behind |
| G5 | Document hygiene | Bills without attachment, tax overrides, manual journals, reversals in period | Counts with links |
| G6 | Owner drawings | Drawings MTD / YTD vs `drawingsLimitMonthly` | Tile, Owner only |
| G7 | Negative-stock attempts and audit flags | Count of blocked postings, period reopenings | Tile |

## Alerts strip (Overview tab)

Ranked list, max 8, each linking to the fix:
advance coverage < 1.0 · forecast goes negative · orders overdue · WIP > 90 days · card clearing > 3 days · AP overdue · bank not reconciled > 35 days · period not closed · low stock · return rate above limit · drawings above limit.

## Data model additions

### `KpiTargets`
`id, kpi, brand, period (YYYY-MM or ANY), target, amberAt, redAt, direction (HIGHER_BETTER|LOWER_BETTER), notes`
Seeded defaults (all editable by Owner): `minCash`, `minAdvancePct` 5000 bps, `maxReturnPct` 800 bps, `maxConcentrationPct` 4000 bps, `drawingsLimitMonthly`, monthly revenue targets per brand.

### `MonthlySummary` (cache, rebuildable)
`month, accountCode, brand, debitPaisa, creditPaisa, lineCount`
Updated incrementally inside the write pipeline (same lock) and fully rebuilt nightly; nightly job logs drift to AuditLog. Trends read this, never the full `JournalLines`.

### `DailySales` (cache, rebuildable)
`date, store, channel, netPaisa, taxPaisa, costPaisa, discountPaisa, transactions, units, returnsNetPaisa`

### `Jobs` new column
`budgetCostPaisa`: estimated cost entered at booking (needed for C5). Optional; C5 ignores jobs without it.

## API

| action | roles | payload → data |
|---|---|---|
| `dashboard.get` | per tab table above | `{tab, period, from?, to?, brand, compareTo}` → `{tiles:[{id, label, value, unit, delta, deltaPct, rag, spark[]}], charts:[{id, type, labels[], series[]}], tables:[…], alerts:[…], asOf}` |
| `kpiTargets.list` / `kpiTargets.upsert` | O | |
| `summaries.rebuild` | O | `{}` → rebuild MonthlySummary and DailySales |

Server caches each `dashboard.get` result in `CacheService` for 5 minutes, keyed by all parameters, cleared on any write. Target response time < 2 s.

KPI formulas live in `core/kpis.js` as pure functions over (summaries, documents, settings, targets) with unit tests.

## Tests (add to 08-test-scenarios.md)

- **T23.** Using state after T01–T12: C4 average job margin = 73.8%; D2 transactions = 1; D3 ATV = Rs 18,000; D9 return rate = 5,000 ÷ 18,000 = 27.78%; A4 advance coverage with advances held 0 → displays "n/a", not divide-by-zero.
- **T24.** `MonthlySummary` after incremental updates equals a full rebuild, for 500 random documents.
- **T25.** Store-role `dashboard.get` for the Overview tab → `E_ROLE`; for the Mirae tab returns only its own store and no cost or margin fields.
