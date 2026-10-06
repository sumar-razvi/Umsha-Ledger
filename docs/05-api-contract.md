# 05. API contract (Apps Script web app)

Single endpoint: the deployed web app URL. All calls are `POST` with body as JSON text and header `Content-Type: text/plain;charset=utf-8` (avoids CORS preflight). `doGet` returns only a health check.

Deployment: **Execute as: Me (company account). Who has access: Anyone.** Security is enforced in code by verifying the Google ID token on every request; the Sheet itself is never shared.

## Envelope

Request:
```json
{
  "action": "sale.create",
  "idToken": "<Google ID token from GIS>",
  "requestId": "c3a1e2f0-…",   // uuid v4, client-generated, required for writes
  "payload": { }
}
```

Response:
```json
{ "ok": true,  "data": { }, "meta": { "ms": 412 } }
{ "ok": false, "code": "E_UNBALANCED", "message": "Debits 10,000 ≠ credits 9,500", "field": "lines[2]" }
```
`field` is present when the error is about one input. A replayed write (same `requestId`) returns the stored response with `meta.replayed: true`. `requestId` must be 8–100 characters of `A-Z a-z 0-9 _ -` (a UUID works).

## Auth flow

1. Front end uses Google Identity Services (`accounts.google.com/gsi/client`) to get an ID token.
2. Server `Auth.gs#verify(idToken)`: fetch `https://oauth2.googleapis.com/tokeninfo?id_token=…`, check `aud === OAUTH_CLIENT_ID`, `email_verified`, `exp` in future. Cache result in `CacheService` for 5 min keyed by SHA-256 of token.
3. Look up email in `Users`; reject inactive/unknown with `E_AUTH`.
4. Role check against the permission matrix below. Reject with `E_ROLE`.

## Write pipeline (every write action)

```
verify token → check role → check Requests for requestId (return stored response if found)
→ acquire ScriptLock (wait ≤ 20 s, else E_BUSY)
→ load needed data → core.build<Doc>(input, context) → core.validate(entry)
→ allocate IDs from Sequences → append rows (doc, lines, stock moves, journal, journal lines)
→ write AuditLog + Requests → invalidate caches → release lock → return
```
If any step after allocation throws, nothing has been appended yet because all `setValues` happen at the end in one batch per tab. Write order: StockMoves/ItemBalances, Journal, JournalLines, document tabs, AuditLog, Requests.

## Actions

Permission key: O=Owner F=Finance S=Studio T=Store V=Viewer.

### Session & setup
| action | roles | payload → data |
|---|---|---|
| `session.me` | all | `{}` → `{email, name, role, store, settings, accounts[], taxCodes[]}` (bootstrap data) |
| `setup.run` | O | `{}` → `{created: [tabs], seeded: n}` (idempotent) |
| `settings.update` | O | `{key, value}` |
| `users.list` / `users.upsert` | O | |
| `periods.list` | O F V | |
| `periods.close` / `periods.reopen` | O | `{periodId, reason?}` |

### Master data
| action | roles | payload |
|---|---|---|
| `contacts.search` | all except V | `{q, kind?}` → top 20 by name/phone |
| `contacts.upsert` | O F S T | contact fields (T: customers only) |
| `items.search` / `items.get` | all | `{q, category?}` / `{id}` → includes qty, avgCost |
| `items.upsert` | O F S | |
| `accounts.upsert` / `accounts.deactivate` | O F | |
| `taxCodes.upsert` | O | |

### Jobs (MTO and RTW batch)
| action | roles | payload |
|---|---|---|
| `jobs.list` | O F S V | `{type?, status?, from?, to?, contactId?}` |
| `jobs.get` | O F S V | `{id}` → job, lines, cost sheet by component, advances, margin |
| `jobs.create` | O F S | `{type, contactId?, title, promisedDate?, lines[], taxCodeId}` |
| `jobs.update` | O F S | non-financial fields + lines while not delivered |
| `jobs.issueStock` | O F S | `{jobId, date, lines:[{itemId, qty}]}` → R7 |
| `jobs.returnStock` | O F S | `{jobId, date, issueMoveId, qty}` |
| `jobs.deliver` | O F S | `{jobId, date, extraLines[], taxOverride?}` → R8, returns invoice |
| `jobs.completeBatch` | O F S | `{jobId, date, outputs:[{itemId, qty, weight?}]}` → R10 |
| `jobs.cancel` | O F | `{jobId, date, refundPaisa, moneyAccountCode, wipTreatment:'RETURN'|'WRITE_OFF'}` → R17 |

### Sales & receivables
| action | roles | payload |
|---|---|---|
| `payments.receiveAdvance` | O F S T | `{jobId, date, amountPaisa, moneyAccountCode, currency?, fxAmount?, fxRate?, reference}` → R1 |
| `payments.receive` | O F S T | `{contactId, date, moneyAccountCode, amountPaisa, allocations:[{docType:'INVOICE', docId, amountPaisa}]}` → R9 |
| `sale.create` | O F T | `{date, channel, store, lines:[{itemId, qty, unitPricePaisa, discountPaisa}], payments:[{method, accountCode, amountPaisa, reference}], contactId?, fbrInvoiceNo?}` → R11 |
| `sale.return` | O F T | `{originalSaleId, date, lines:[{saleLineId, qty, restock}], refund:[{method, accountCode, amountPaisa}]}` → R12 |
| `sale.exchange` | O F T | `{originalSaleId, returnLines[], newLines[], payments[]}` |
| `cashup.submit` | O F T | `{date, store, countedCashPaisa, notes}` → R16 |
| `invoices.get` / `invoices.list` | O F S V | |
| `receipts.render` | all except V | `{docType: 'PAYMENT'|'INVOICE', docId}` → receipt/invoice content (`core/receipts.js`: company, to, lines, totals, balance) + `{whatsappText, whatsappUrl}`; the page renders the printable view |

### Purchases & payables
| action | roles | payload |
|---|---|---|
| `bills.create` | O F (S: JOB lines only) | `{contactId, date, vendorRef, dueDate, lines:[…BillLines]}` → R2/R3/R4 |
| `karigar.logWork` | O F S | `{contactId, jobId, date, costComponent, pieces, ratePaisa, description}` → creates bill, R3 |
| `payments.pay` | O F | `{contactId, date, moneyAccountCode, allocations:[{docType:'BILL', docId, amountPaisa}], applyWht:true}` → R5 |
| `expenses.create` | O F (T: petty only) | `{date, moneyAccountCode, contactId?, lines:[{accountCode, brand, netPaisa, taxCodeId}], isDrawings?}` → R6 / R18 |
| `payments.vendorAdvance` | O F | |

### Banking & tax
| action | roles | payload |
|---|---|---|
| `transfers.create` | O F | `{date, fromCode, toCode, amountPaisa}` → R14 |
| `settlements.create` | O F | `{date, clearingCode, bankCode, grossPaisa, feePaisa}` → R13 |
| `bankrec.import` | O F | `{accountCode, csvText, mapping?, statementDate, statementBalancePaisa}` → `{recId, lines}` |
| `bankrec.match` | O F | `{recId, matches:[{statementLineId, jeLineId}], finish?}` |
| `bankrec.list` / `bankrec.get` | O F | `{accountCode?}` / `{recId}` → `{rec, account, statementLines, ledgerLines, suggestions, summary}` |
| `tax.settleSalesTax` | O F | R20 |
| `tax.depositWht` | O F | R21 |

### Ledger
| action | roles | payload |
|---|---|---|
| `journal.create` | O F | `{date, memo, lines:[{accountCode, brand, debitPaisa, creditPaisa, contactId?, jobId?, memo}]}` |
| `journal.reverse` | O F | `{jeId, date, reason}` → R22 |
| `journal.get` | O F V | `{jeId}` |
| `ledger.account` | O F V | `{accountCode, from, to, brand?}` → lines with running balance |

### Inventory
| action | roles | payload |
|---|---|---|
| `stock.count.create` / `stock.count.post` | O F S T | R15 |
| `stock.valuation` | O F V | `{asOf}` |
| `stock.movements` | O F S V | `{itemId, from, to}` |

### Reports
All O F V (S sees job reports only; T sees own store's daily sales only).
| action | payload |
|---|---|
| `reports.pnl` | `{from, to, allocate: 'REVENUE'|'FIXED'|'NONE', compareTo?: {from,to}}` |
| `reports.balanceSheet` | `{asOf}` |
| `reports.trialBalance` | `{asOf}` |
| `reports.jobProfitability` | `{from, to, status?}` |
| `reports.skuMargin` | `{from, to, collection?}` |
| `reports.arAgeing` / `reports.apAgeing` | `{asOf}` |
| `reports.cashPosition` | `{asOf}` |
| `reports.salesTax` | `{from, to}` |
| `reports.whtRegister` | `{from, to}` |
| `reports.dailySales` | `{date, store}` |
| `reports.auditLog` | `{from, to, user?, docType?}` |

### Export
| action | roles | payload |
|---|---|---|
| `export.quickbooksJournals` | O F V | `{from, to}` → `{csv, filename, unmappedAccounts[]}` |
| `export.table` | O F | `{tab}` → CSV |

QuickBooks export: one row per journal line. Columns follow the QuickBooks Online "Journal entries" import template (Journal No., Journal Date, Account, Debits, Credits, Description, Name, Class, Currency). **Claude Code: before finalising, download the current template from QuickBooks Online and match its headers and date format exactly.** Brand → QBO Class (`UMSHA`, `Mirae`, `Shared`). Amounts exported in rupees with 2 decimals. Fail with a list if any account has no `qbAccountName`.

## Implementation notes (M2)

- The permission matrix lives in `core/permissions.js` (`Permissions.MATRIX`) and is checked server-side before any handler runs. Payload rules: Store may upsert customers only and pay expenses only from a `PETTY` account (never drawings); Studio bills may contain `JOB` lines only; Store sees its own store's daily sales only.
- Extra read actions beyond the tables above: `contacts.get`, `sales.list`, `sales.get`, `bills.list`, `bills.get`, `journal.list`; extra write: `backup.now` (Owner).
- Writes are buffered and committed in one batch per tab in this order: Sequences, StockMoves, ItemBalances, Journal, JournalLines, document tabs, AuditLog, Requests. Sequences go first so a failure can leave a gap in numbering but never reuse a number.
- `Db.gs` refuses any change to posted Journal, JournalLines, StockMoves or AuditLog rows except `Journal.reversedByJeId` and `JournalLines.reconciled`/`reconciledDate`, and only from empty.
- Editor-only functions: `setupRun` (first setup), `installTriggers`, `nightly`. See `README-deploy.md`.
- M3 adds: `jobs.update` (details, status OPEN → IN_PRODUCTION → READY, `addLines` for extra charges, `lineDiscounts`), `jobs.deliver` (R8; creates the invoice), `payments.receive` (R9), `invoices.get/list`, `receipts.render`, `jobs.issueStock`/`jobs.returnStock` (R7), `karigar.logWork` (R3 bill), `jobs.cancel` (R17; a refund is recorded as a `REFUND` payment), `bills.create` (R2–R4). `jobs.get` returns the cost sheet, advances held, balance due and a timeline of journal entries.
- M4 adds: `bills.list` (with `state` OPEN/PART_PAID/PAID/VOID and `UNPAID` filter), `bills.get`, `vendors.list` (balances owed and advances), `payments.pay` (allocation-level `whtPaisa` override needs `whtOverrideReason`, else `E_TAX_OVERRIDE_NO_REASON`), `payments.vendorAdvance`, `expenses.create` (with `isDrawings`), `reports.apAgeing`, `reports.arAgeing`, `taxCodes.list`, `taxCodes.upsert` (same `effectiveFrom` edits a version; a later one starts a new version and closes the previous one the day before), `attachments.upload` (`{docType, docId, fileName, mimeType, dataBase64}`, photo or PDF up to 5 MB, saved in `Settings.attachmentsFolderId`) and `attachments.get` (returns the file as base64, so staff never need access to the Drive folder). `receipts.render` for a vendor payment returns a `VOUCHER` with bills settled and WHT.
- M5 adds: `stock.movements` (item movement ledger with running qty/value/average, `Inventory.movementLedger`), `stock.valuation` (`{asOf}` → per-account stock vs GL with differences and per-item rows, `Reports.inventoryReconciliation`), `jobs.completeBatch` (R10), `stock.count.post` (R15; one step: the page keeps counting blind and reviews differences before posting; `stock.count.create` for saved drafts is not built). `jobs.get` lists the job's material issues with the quantity still returnable.
- M6 adds: `sale.create`, `sale.return`, `sale.exchange` (Store staff always sell and refund in their own store; another store's sale is `E_ROLE`), `sales.list` (find by receipt no., customer name or mobile, date), `sales.get`, `receipts.render` for `SALE` (80 mm receipt, brand from `Settings.rtwBrandName`), `cashup.preview` (expected cash = store cash account balance at the end of the day; card/wallet takings) and `cashup.submit` (once per day per store), `reports.dailySales` (cost and margin hidden from Store), `settlements.create` (R13), `transfers.create` (R14).
- M7 adds every report above (`reports.pnl` returns `{current, previous?}`; allocation defaults to `Settings.allocationKey`; `reports.salesTax` leaves sales-tax settlement entries out so a settled period still shows what arose in it; `reports.jobProfitability` adds customer, budget and on-time flags), `journal.list`, `periods.checklist` (trial balance and control accounts are blocking; cash-ups, stock count, bank reconciliation and previous month are warnings), `periods.close` now runs the checklist and needs `acknowledgeWarnings: true` when any warning is open (the acknowledged items go into the audit log), `year.close` (R23, Owner), `tax.settleSalesTax` (R20) and `tax.depositWht` (R21).
- M8 adds: `bankrec.import` (`mapping` = `{dateColumn, dateFormat, descriptionColumn, amountColumn, amountSign?}` or `{..., debitColumn, creditColumn}`; date formats `DD/MM/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`, `DD-MMM-YYYY`; amounts may carry `Rs`, commas, brackets or `Dr`/`Cr`; the mapping is saved per account in `Settings` as `bankMapping:<code>` and reused when omitted), `bankrec.list`, `bankrec.get` (suggested matches: same amount within 5 days, closest date first, each line used once), `bankrec.match` (matches must have equal amounts; `finish: true` fails unless every statement line is matched and the difference is zero), `export.quickbooksJournals` (`Settings.qbDateFormat`; returns `{csv, filename, journalCount, rowCount, debitsPaisa, unmappedAccounts}`, `csv` empty when any account is unmapped), `export.table` (any tab as CSV, Owner/Finance), `accounts.list` (with balances), `accounts.upsert` (`id` edits an existing account; without it the code must be new; system accounts keep their type) and `accounts.deactivate` (refused for system accounts and accounts with a balance).
- Reversing any entry that posted payments voids those payments and gives their amounts (and WHT) back to the bills or invoices they paid (`Posting.reverseEntry` with `ctx.paymentsByJe`).

## Error codes
`E_AUTH, E_ROLE, E_BUSY, E_VALIDATION (with field), E_NOT_FOUND, E_UNBALANCED, E_EMPTY_BRAND, E_NEG_AMOUNT, E_PERIOD_LOCKED, E_INACTIVE_ACCOUNT, E_NEG_STOCK, E_JOB_CLOSED, E_OVERPAY, E_TAX_OVERRIDE_NO_REASON, E_INTERNAL`
