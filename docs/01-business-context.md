# 01. Business context

## The business

UMSHA is a Karachi-based, family-owned luxury fashion house. It operates two lines that share people, premises and suppliers but have very different economics:

| | UMSHA (MTO) | Mirae (RTW) |
|---|---|---|
| Model | Made-to-order couture, bridal, formals | Ready-to-wear collections |
| Unit of work | One client order (often multi-piece) | SKU (style + size + colour) |
| Ticket size | High (lakhs per order) | Low to mid |
| Lead time | Weeks to months | Off the shelf |
| Cash pattern | Large advance at booking, balance at delivery | Paid at till (cash, card, bank transfer/Raast, wallets) |
| Costing question | "Did this order make money?" | "What is my margin per SKU and collection?" |
| Inventory | Fabric and trims consumed into jobs | Finished goods on shelves |
| Sales channel | Studio appointments, WhatsApp | Mirae Karachi store, online, exhibitions |

Both lines feed one set of management accounts. The owners need to see **each brand's P&L separately** and the **combined company P&L**, with shared overheads (rent, salaries of shared staff, utilities) shown either unallocated or allocated by a configurable key.

## Why build instead of buy

QuickBooks Online is the target for the external accountant, but it does not natively model:

- MTO job costing with fabric issued to karigars and labour billed per piece
- Customer advances held against a specific order and applied at delivery
- Brand-segmented P&L without paid class/location tiers
- WhatsApp-first receipts for Pakistani customers
- Store staff entering sales on a phone with minimal training

UMSHA Ledger is the operational book of record. It **exports journals in a QuickBooks-importable CSV** so the accountant can keep QuickBooks (or any GL) in sync without re-keying. See `02-prd.md` module M8.

## People and roles

| Role | Who (typical) | What they do in the system |
|---|---|---|
| Owner | CEO / founder, family directors | Everything. Approves, closes periods, sees all reports. |
| Finance | In-house accountant or outsourced bookkeeper | Bills, payments, manual journals, reconciliations, exports. |
| Studio | MTO production manager | Creates orders/jobs, issues fabric, logs karigar work. Sees job costs, not company P&L. |
| Store | Mirae store staff | Records sales, returns, card settlements, cash-up. Sees own store's day only. |
| Viewer | Advisors (e.g. external accountant) | Read-only reports and exports. |

Design for a **founder-led family business**: the Owner role must always be able to see and approve, but day-to-day entry should not depend on the founder. Approval steps should be light (one tap), not bureaucratic, or they will be bypassed.

## How money moves (core flows)

### MTO order lifecycle
1. Client books an order. Studio creates a **Job** (`MTO_ORDER`) with quoted price.
2. Client pays an **advance** (often 50%+). Recorded as a liability against that job.
3. Fabric and trims are **issued** from stock to the job (cost moves to WIP).
4. Karigars and outsourced vendors (dyeing, embroidery) do work and **bill** against the job (cost added to WIP).
5. Fittings, possible alterations, extra charges added to the order.
6. **Delivery**: invoice raised, revenue recognised, advance applied, WIP released to cost of sales.
7. Balance paid. Receipt sent on WhatsApp.
8. Job margin = invoice net revenue minus total job cost.

### RTW lifecycle
1. A **production batch** (`RTW_BATCH` job) consumes fabric, trims, labour.
2. Batch completes: finished goods enter stock at batch unit cost.
3. Goods sold at store/online/exhibition. Cost of goods sold at weighted-average cost.
4. Card and wallet payments settle to the bank later, net of fees.
5. Returns and exchanges handled at the store.
6. Periodic stock counts adjust shrinkage.

### Overheads and the owners
- Rent, utilities, salaries, marketing, courier, professional fees paid from bank or petty cash.
- Family/personal payments that run through the business must be recorded as **owner drawings**, never buried in expenses. This is a professionalisation goal in itself.

## Constraints

- Currency: **PKR** base. Occasional USD/GBP receipts (overseas clients) recorded with exchange rate.
- Fiscal year: **July to June** (Pakistan tax year). Configurable.
- Taxes: sales tax on sales and purchases, withholding tax on payments to vendors. Rates vary and change in each Budget, so **all rates live in the `TaxCodes` tab, never in code**. Payroll is out of scope for v1 (salaries posted as an expense journal).
- Connectivity: store and studio on mobile data. The UI must tolerate slow, flaky connections (idempotent writes, clear pending state).
- Scale: low thousands of transactions per month. Google Sheets is adequate; design reads efficiently anyway.
- Cost: zero running cost.

## Success measures

- Monthly management accounts (P&L by brand, balance sheet) produced within 5 working days of month end.
- Every MTO order shows a margin at delivery.
- Bank and cash balances in the system match statements at month end.
- External accountant can import the month into QuickBooks in one step.
