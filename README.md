# Usage to Cash Recon

A browser tool that reconciles **metered GenAI usage → invoices → bank receipts** and lists every gap with its evidence and a suggested next step.

Live demo: https://simplismart-recon.vercel.app (runs on a bundled synthetic sample, or drop in your own CSVs)

> **All sample data is synthetic.** Customer names, prices, quantities and payments are made up. The rate card is illustrative and is not any real company's pricing.

## The problem

A usage based inference platform bills each customer from several meters at once: tokens per model, images, audio minutes, dedicated GPU hours, a platform fee, and contract prices that override the list price. Revenue can leak at three handoffs:

1. **Usage → invoice.** A customer month never gets invoiced, a line drops off the invoice, late arriving usage events miss the billing run, a new SKU has no price, or a contract discount is not applied (which over bills and causes a dispute).
2. **Invoice → cash.** Customers short pay (withheld tax, bank charges), pay the same invoice twice, or pay a rounded figure with no invoice number.
3. **The bank feed itself.** Rows get exported twice, and bank reference numbers can repeat across different payers.

Finance usually finds these by hand in spreadsheets at month end. This does that pass in one click.

## What it checks

| Exception | Rule |
|---|---|
| Missing invoice | Usage exists for a customer month, no invoice |
| Under billed / Over billed | Invoice differs from rated usage by more than max($1, 0.5%) |
| Duplicate invoice | More than one invoice for the same customer month |
| Unrated usage | Usage on a SKU with no list or contract price |
| Invoice without usage | Invoice with no usage and no platform fee |
| Duplicate payment / Overpaid | Cash applied to an invoice exceeds its amount |
| Short paid | Cash applied but a balance remains |
| Unapplied cash | Receipt that can't be tied to an invoice |

Plus: AR ageing as of any date, a customer table (rated usage, invoiced, collected, open AR, gross margin after serving cost), and CSV export of exceptions.

## Method

1. **Clean the bank feed.** Dedupe on `payment_id` only. Never on `bank_ref`: different payers can share one, so a bank ref dedupe deletes genuine receipts. The overview shows how much that mistake would have removed. (I learned this on an earlier collections audit, where a pipeline deduped payments on a reference number that collided across accounts and quietly dropped real payments: [collections-data-analyst-assignment](https://github.com/techi101/collections-data-analyst-assignment).)
2. **Rate usage.** Contract price if the customer has one, else list price, plus the monthly platform fee. Money is held in integer cents.
3. **Compare with invoices** per customer month.
4. **Apply cash.** First by an invoice number found in the remittance text, then, for a recognised payer (name or alias), by an exact match to an open invoice amount. Anything else stays unapplied for a person to review. Then check each invoice for short pay, overpay or duplicate pay, and age open balances.

## Input files

| File | Required columns |
|---|---|
| `customers.csv` | customer_id, customer_name, platform_fee, terms_days (optional: aliases, `\|` separated) |
| `rates.csv` | customer_id (`*` = list price), sku, unit, unit_price |
| `usage.csv` | customer_id, period (YYYY-MM), sku, quantity |
| `invoices.csv` | invoice_id, customer_id, period, issue_date, due_date, amount |
| `payments.csv` | payment_id, received_date, bank_ref, payer_name, amount (optional: remittance, customer_id) |
| `costs.csv` | optional: sku, unit_cost |

Files are parsed in the browser. Nothing is uploaded.

## Tests

```
npm test
```

Unit tests cover each rule, the tolerance, contract vs list pricing, payment dedupe vs bank ref collisions, cash application order, ageing buckets, schema errors and the CSV parser. An end to end test generates the synthetic sample (`src/generate.js`, seeded) with known problems planted on purpose and checks the engine finds **exactly** those, with the right amounts, and nothing else. Another test checks the bundled CSVs in `sample/` match the generator.

No dependencies: plain ES modules, Node's built in test runner, static hosting.

```
npm run sample   # regenerate sample/*.csv
python -m http.server 8000   # then open http://localhost:8000
```

## Honest limits

- Single currency; no FX.
- Monthly postpaid only. Prepaid credit wallets, committed use drawdowns and mid month plan changes are not modelled.
- Rule based cash matching. It does not split one receipt across several invoices or fuzzy match amounts; those go to unapplied cash on purpose.
- Usage is taken as given. A wrong meter is invisible here.
- Margin uses unit serving cost only (no idle GPU time, no fixed cost).
- The test proves the engine finds the problems I planted. Real data will have problems I didn't think of.

## Layout

```
index.html, styles.css, app.js   UI
src/recon.js                     reconciliation engine (pure functions)
src/csv.js                       CSV parse/write
src/generate.js                  seeded synthetic data with planted issues
sample/                          bundled synthetic CSVs + planted_issues.json
tests/recon.test.mjs             tests
```

Built by Nitesh Kumar Yadav.
