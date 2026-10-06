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
{ "ok": false, "code": "E_UNBALANCED", "message": "Debits 10,000 ≠ credits 9,500" }
```

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
| `receipts.render` | all except V | `{docType, docId}` → `{html, whatsappText, whatsappUrl}` |

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
| `bankrec.import` | O F | `{accountCode, csvText, statementDate, statementBalancePaisa}` |
| `bankrec.match` | O F | `{recId, matches:[{statementLineId, jeLineId}]}` |
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

## Error codes
`E_AUTH, E_ROLE, E_BUSY, E_VALIDATION (with field), E_NOT_FOUND, E_UNBALANCED, E_EMPTY_BRAND, E_NEG_AMOUNT, E_PERIOD_LOCKED, E_INACTIVE_ACCOUNT, E_NEG_STOCK, E_JOB_CLOSED, E_OVERPAY, E_TAX_OVERRIDE_NO_REASON, E_INTERNAL`
