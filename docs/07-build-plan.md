# 07. Build plan

Build in this order. Each milestone ends with passing tests and a short demo checklist. Do not start the next milestone until the current one is green. Each milestone has a **ready-to-paste prompt** for Claude Code.

| # | Milestone | Depends on | Scenarios to pass |
|---|---|---|---|
| 0 | Repo scaffold, core money/ids, build script | none | T00 |
| 1 | Posting engine core (pure JS) | 0 | T01–T12 |
| 2 | Apps Script I/O, setup, auth, write pipeline | 1 | T13–T15 |
| 3 | Front-end shell + Orders (MTO) end to end | 2 | T01–T05 via UI |
| 4 | Purchases, karigars, expenses, WHT | 3 | T03, T06, T07 |
| 5 | Inventory: items, issue/return, RTW batch, stock count | 3 | T04, T08, T11 |
| 6 | Store (RTW) sales, returns, cash-up, settlements | 5 | T09, T10, T12 |
| 7 | Reports + period close | 4, 6 | T16–T18 |
| 8 | Banking rec, QuickBooks export, backups | 7 | T19, T20 |
| 10 | Dashboard and KPIs | 7 | T23–T25 |
| 9 | Hardening: offline queue, performance, audit views | all | load test |

---

## M0. Scaffold
**Prompt:**
> Read CLAUDE.md and docs/. Scaffold the repo layout in CLAUDE.md. Implement `core/money.js` (parse rupee strings incl. `1.25L`, `125k`, commas, to paisa; format paisa to `Rs 125,000.50`; `roundHalfEven`; `applyBps`; `splitProRata(total, weights)` with residual on last), `core/ids.js` (format `PREFIX-YYYY-NNNNN`), `scripts/build-core.js`, and tests. Add `package.json` with `"test": "node --test"`, `"build": "node scripts/build-core.js"`. No dependencies.

**Done when:** `npm test` passes T00; `npm run build` produces `apps-script/Core.gs` that has no `module.exports`.

## M1. Posting engine (pure)
**Prompt:**
> Implement `core/posting.js` and `core/validate.js` exactly per docs/03-accounting-rules.md rules R1–R23. Each builder takes plain input + a `ctx` object (`accountsBySystemKey`, `taxCodes`, `itemBalances`, `jobWip`, `settings`, `periods`) and returns `{journal, lines, stockMoves, itemBalanceUpdates, docUpdates}`. No I/O. Implement `core/inventory.js` (weighted average with avgCostMicro) and `core/reports.js` (trial balance, P&L by brand with allocation, balance sheet, ageing, job profitability) as pure functions over arrays of lines. Write tests for every scenario T01–T12 in docs/08-test-scenarios.md using the exact numbers given.

**Done when:** all T01–T12 pass, every builder's output passes `validate`, and a property test posts 500 random valid documents and confirms the trial balance nets to zero.

## M2. Apps Script back end
**Prompt:**
> Implement apps-script/: `Db.gs` (header-mapped read/append, typed tab accessors, batch writes), `Lock.gs`, `Auth.gs` (ID token verification + Users lookup + permission matrix from docs/05), `Setup.gs` (create tabs from docs/04 with headers and text-formatted date columns, load seed CSVs embedded as constants, idempotent), `Api.gs` (`doPost` router implementing the write pipeline in docs/05, idempotency via Requests tab, error envelope). Wire actions for session.me, setup.run, contacts, items, jobs.create, payments.receiveAdvance, journal.create, journal.reverse, ledger.account. Add a nightly backup trigger. Provide a `README-deploy.md` with clasp steps, Script Properties (SHEET_ID, OAUTH_CLIENT_ID), and deployment settings.

**Done when:** T13 (idempotency), T14 (locked period), T15 (role denied) pass using a test harness that runs `Api` functions against an in-memory fake of `Db` in Node.

## M3. Front-end shell + MTO orders
**Prompt:**
> Build `index.html`: CONFIG block, Google sign-in, `api(action, payload)` helper with requestId, pending-queue and retry, hash router, role-based nav, shared components (money input, contact picker, item picker, brand pill, data table with CSV export, toast). Then the full Orders module per docs/06: list, new order, order detail with live cost sheet, receive advance, deliver (R8), receive balance, receipt view, WhatsApp share. Mobile-first.

**Done when:** on a phone you can create a customer, book an order, take an advance, deliver it and take the balance; the JE for each step is visible and matches T01/T02.

## M4. Purchases
> Implement bills (stock/job/expense lines, photo attachment to Drive), karigar log work, pay bills with WHT preview, quick expense with Personal/family toggle, vendor and karigar balances, AP ageing.

## M5. Inventory
> Implement items, stock in via bills, issue/return to job, item movement ledger, RTW batch create/complete with weighted split, stock count with blind entry, stock valuation report that reconciles to GL.

## M6. Store
> Implement the phone-first New sale screen with split payments, tax-inclusive pricing, receipt; returns and exchanges at original price and cost; Today view; cash-up; card/wallet settlement.

## M7. Reports and close
> Implement all reports in docs/05 with drill-down and CSV/print, P&L allocation toggle, period close checklist and lock/reopen, year-end close entry.

## M8. Banking and export
> Implement bank statement CSV import (configurable column mapping per bank, saved in Settings), matching UI, reconciliation report. QuickBooks journal export per docs/05. Backup now button.

## M10. Dashboard and KPIs
**Prompt:**
> Read docs/10-dashboard-kpis.md. Add the KpiTargets, MonthlySummary and DailySales tabs and Jobs.budgetCostPaisa to Setup and docs/04. Update summaries incrementally inside the write pipeline and add a nightly full rebuild with drift logging. Implement every KPI in `core/kpis.js` as pure functions with tests (T23–T25). Implement `dashboard.get` with 5-minute caching and role filtering. Build the tabbed dashboard in index.html with Chart.js from cdnjs: tiles with delta, RAG and sparkline, the charts listed per KPI, alerts strip, drill-down links, auto-refresh every 5 minutes while visible. Mobile: tiles stack in one column, charts scroll horizontally.

**Done when:** T23–T25 pass, every tile drills down to a report or document list, and the Overview tab loads in < 2 s on 20k journal lines.

## M9. Hardening
> Seed 20k journal lines of synthetic data and measure every screen; optimise reads and caching until targets in docs/02 are met. Add audit log viewer. Review every action for server-side role checks. Write `docs/USER-GUIDE.md` in plain English for Store and Studio staff.

---

## Go-live checklist (for Umar, not Claude Code)
1. Decide all items in `09-open-decisions.md` with the accountant.
2. Pick go-live date = first day of a month (ideally 1 July for a clean fiscal year).
3. Load opening balances as at go-live: trial balance from current books, stock count per item with cost, open MTO orders with advances held and WIP to date, open customer and vendor balances.
4. Run 2 weeks in parallel with current method; reconcile daily.
5. Train Store and Studio staff on their 3–4 screens only.
