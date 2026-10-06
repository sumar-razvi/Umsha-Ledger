# UMSHA Ledger

In-house double-entry accounting and operations system for UMSHA (made-to-order couture) and Mirae (ready-to-wear). Job costing for MTO orders, RTW store sales and inventory, payables with withholding tax, brand-level P&L, and a QuickBooks journal export for the external accountant.

**Stack:** single-file HTML on GitHub Pages · Google Apps Script API · Google Sheets ledger · zero running cost.

| File | Purpose |
|---|---|
| `CLAUDE.md` | Standing instructions for Claude Code (read first, every session) |
| `KICKOFF-PROMPT.md` | How to start, and the first prompt to paste |
| `docs/01-business-context.md` | The business and its money flows |
| `docs/02-prd.md` | Modules, user stories, priorities, non-functional requirements |
| `docs/03-accounting-rules.md` | Chart of accounts logic and all posting rules (R1–R23) |
| `docs/04-data-model.md` | Every Sheets tab and column |
| `docs/05-api-contract.md` | Apps Script actions, auth, write pipeline, roles |
| `docs/06-ui-spec.md` | Screens by role |
| `docs/07-build-plan.md` | Milestones M0–M9 with paste-ready prompts, go-live checklist |
| `docs/08-test-scenarios.md` | Golden acceptance tests with exact expected journals |
| `docs/09-open-decisions.md` | Questions for the family and tax advisor, with build defaults |
| `docs/10-dashboard-kpis.md` | Dashboard tabs and 60+ KPI definitions with formulas |
| `docs/USER-GUIDE.md` | Plain-English guide for store and studio staff |
| `seed/` | Chart of accounts (with QuickBooks mapping), tax codes, settings, dashboard targets |

Deployment: see [`README-deploy.md`](README-deploy.md).

## Development

Needs Node 20+. No dependencies.

```
npm test        # node --test: all golden scenarios for completed milestones
npm run build   # regenerate apps-script/Core.gs, Seed.gs and core.bundle.js (commit the result)
npm run serve   # demo at http://localhost:8000: the real server code, in memory, "sign in as" any role
npm run test:ui # browser test of index.html (needs Playwright with Chromium; CHART_JS=path/to/chart.umd.js to test real charts offline)
npm run perf    # ~20k journal lines through the server code; time and cells read per screen (several minutes)
```
