import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCSV, toCSV } from '../src/csv.js';
import { reconcile, cleanPayments, toCents, normName, ageReceivables } from '../src/recon.js';
import { generate } from '../src/generate.js';

// ---------- tiny fixture builder ----------
function base() {
  return {
    customers: [
      { customer_id: 'A', customer_name: 'Acme Voice', aliases: 'Acme Voice Pvt Ltd', platform_fee: '100.00', terms_days: '30' },
      { customer_id: 'B', customer_name: 'Beta Docs', aliases: '', platform_fee: '0', terms_days: '15' },
    ],
    rates: [
      { customer_id: '*', sku: 'tok', unit: '1M tokens', unit_price: '0.50' },
      { customer_id: '*', sku: 'gpu', unit: 'GPU hour', unit_price: '4.00' },
      { customer_id: 'A', sku: 'gpu', unit: 'GPU hour', unit_price: '3.00' },
    ],
    usage: [
      { customer_id: 'A', period: '2026-09', sku: 'tok', quantity: '1000' }, // 500.00
      { customer_id: 'A', period: '2026-09', sku: 'gpu', quantity: '100' },  // 300.00 at contract
      { customer_id: 'B', period: '2026-09', sku: 'tok', quantity: '200' },  // 100.00
    ],
    invoices: [
      { invoice_id: 'INV-2026-0001', customer_id: 'A', period: '2026-09', issue_date: '2026-10-01', due_date: '2026-10-31', amount: '900.00' },
      { invoice_id: 'INV-2026-0002', customer_id: 'B', period: '2026-09', issue_date: '2026-10-01', due_date: '2026-10-16', amount: '100.00' },
    ],
    payments: [],
    costs: [],
  };
}
const types = r => r.exceptions.map(e => e.type).sort();
const run = (d, asOf = '2026-11-15') => reconcile(d, { asOf });

test('clean books produce no exceptions', () => {
  const d = base();
  d.payments = [
    { payment_id: 'P1', received_date: '2026-10-30', bank_ref: 'U1', payer_name: 'Acme Voice Pvt Ltd', amount: '900.00', remittance: 'INV-2026-0001' },
    { payment_id: 'P2', received_date: '2026-10-15', bank_ref: 'U2', payer_name: 'Beta Docs', amount: '100.00', remittance: '' },
  ];
  const r = run(d);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.exceptions, []);
  assert.equal(r.summary.openARCents, 0);
});

test('contract price beats list price when rating usage', () => {
  const r = run(base());
  const a = r.billingRows.find(x => x.customer_id === 'A');
  assert.equal(a.expectedCents, 90000); // 100 fee + 500 tokens + 300 gpu at 3.00 (not 4.00)
});

test('missing invoice is flagged with the full expected amount as leakage', () => {
  const d = base();
  d.invoices = d.invoices.filter(i => i.customer_id !== 'B');
  const r = run(d);
  assert.deepEqual(types(r), ['MISSING_INVOICE']);
  assert.equal(r.exceptions[0].amountCents, 10000);
  assert.equal(r.summary.leakageCents, 10000);
});

test('under and over billing respect tolerance', () => {
  const d = base();
  d.invoices[0].amount = '899.50'; // 50 cents short: under the $1 tolerance
  assert.deepEqual(types(run(d)), []);
  d.invoices[0].amount = '600.00';
  let r = run(d);
  assert.deepEqual(types(r), ['UNDER_BILLED']);
  assert.equal(r.exceptions[0].amountCents, 30000);
  d.invoices[0].amount = '1000.00'; // gpu billed at list 4.00
  r = run(d);
  assert.deepEqual(types(r), ['OVER_BILLED']);
  assert.equal(r.exceptions[0].amountCents, 10000);
});

test('duplicate invoice is flagged and kept out of receivables', () => {
  const d = base();
  d.invoices.push({ ...d.invoices[1], invoice_id: 'INV-2026-0003', issue_date: '2026-10-03' });
  const r = run(d);
  assert.deepEqual(types(r), ['DUPLICATE_INVOICE']);
  assert.equal(r.exceptions[0].invoice_id, 'INV-2026-0003');
  assert.ok(!r.invoices.has('INV-2026-0003'));
});

test('usage on a SKU with no rate is flagged as unrated', () => {
  const d = base();
  d.usage.push({ customer_id: 'B', period: '2026-09', sku: 'new-model', quantity: '50' });
  const r = run(d);
  assert.deepEqual(types(r), ['UNRATED_USAGE']);
});

test('invoice with no usage and no fee is flagged', () => {
  const d = base();
  d.invoices.push({ invoice_id: 'INV-2026-0009', customer_id: 'B', period: '2026-08', issue_date: '2026-09-01', due_date: '2026-09-16', amount: '40.00' });
  assert.ok(types(run(d)).includes('INVOICE_NO_USAGE'));
});

test('payments dedupe on payment_id only; colliding bank refs are kept', () => {
  const pays = [
    { payment_id: 'P1', bank_ref: 'UTR9', amount: '10.00' },
    { payment_id: 'P1', bank_ref: 'UTR9', amount: '10.00' }, // exported twice
    { payment_id: 'P2', bank_ref: 'UTR9', amount: '25.00' }, // different payment, same ref
  ];
  const c = cleanPayments(pays);
  assert.equal(c.kept.length, 2);
  assert.equal(c.feedDuplicates.length, 1);
  assert.equal(c.refCollisions.length, 1);
  assert.deepEqual(c.refDedupeWouldDrop, { count: 1, cents: 2500 });
});

test('cash is applied by remittance ref first, then by exact amount for a known payer', () => {
  const d = base();
  d.payments = [
    { payment_id: 'P1', received_date: '2026-10-20', bank_ref: 'U1', payer_name: 'someone else', amount: '900.00', remittance: 'Paid INV-2026-0001 thanks' },
    { payment_id: 'P2', received_date: '2026-10-20', bank_ref: 'U2', payer_name: 'BETA DOCS', amount: '100.00', remittance: '' },
  ];
  const r = run(d);
  assert.deepEqual(r.exceptions, []);
  assert.equal(r.applications.find(a => a.payment_id === 'P1').method, 'remittance reference');
  assert.equal(r.applications.find(a => a.payment_id === 'P2').method, 'customer + exact open amount');
});

test('short pay, duplicate pay and unapplied cash are each flagged', () => {
  const d = base();
  d.payments = [
    { payment_id: 'P1', received_date: '2026-10-20', bank_ref: 'U1', payer_name: 'Acme Voice', amount: '810.00', remittance: 'INV-2026-0001 less TDS' },
    { payment_id: 'P2', received_date: '2026-10-10', bank_ref: 'U2', payer_name: 'Beta Docs', amount: '100.00', remittance: 'INV-2026-0002' },
    { payment_id: 'P3', received_date: '2026-10-12', bank_ref: 'U3', payer_name: 'Beta Docs', amount: '100.00', remittance: 'INV-2026-0002' },
    { payment_id: 'P4', received_date: '2026-10-12', bank_ref: 'U4', payer_name: 'Mystery Corp', amount: '55.00', remittance: '' },
    { payment_id: 'P5', received_date: '2026-10-13', bank_ref: 'U5', payer_name: 'Acme Voice', amount: '77.00', remittance: '' },
  ];
  const r = run(d);
  assert.deepEqual(types(r), ['DUPLICATE_PAYMENT', 'SHORT_PAID', 'UNAPPLIED_CASH', 'UNAPPLIED_CASH']);
  assert.equal(r.exceptions.find(e => e.type === 'SHORT_PAID').amountCents, 9000);
  assert.equal(r.summary.unappliedCents, 13200);
});

test('ageing buckets by days past due as of the chosen date', () => {
  const inv = new Map([
    ['X1', { invoice_id: 'X1', customer_id: 'A', period: 'p', due_date: '2026-11-20', amountCents: 100, appliedCents: 0 }],
    ['X2', { invoice_id: 'X2', customer_id: 'A', period: 'p', due_date: '2026-11-01', amountCents: 200, appliedCents: 50 }],
    ['X3', { invoice_id: 'X3', customer_id: 'A', period: 'p', due_date: '2026-08-01', amountCents: 300, appliedCents: 0 }],
    ['X4', { invoice_id: 'X4', customer_id: 'A', period: 'p', due_date: '2026-08-01', amountCents: 300, appliedCents: 300 }],
  ]);
  const a = ageReceivables(inv, '2026-11-15');
  assert.deepEqual(a.totals, { 'Not due': 100, '1-30': 150, '31-60': 0, '61-90': 0, '90+': 300 });
  assert.equal(a.rows.length, 3);
});

test('missing columns give a readable error instead of a crash', () => {
  const d = base();
  d.invoices = [{ invoice_id: 'x', customer_id: 'A' }];
  const r = reconcile(d);
  assert.match(r.errors[0], /invoices\.csv is missing column\(s\): period/);
});

test('helpers: cents, names, csv round trip', () => {
  assert.equal(toCents('$1,234.565'), 123457);
  assert.ok(Number.isNaN(toCents('')));
  assert.equal(normName('Acme Voice Pvt. Ltd.'), normName('ACME VOICE'));
  const rows = parseCSV('a,b\r\n"x, y","say ""hi"""\n\n1,2\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"' }, { a: '1', b: '2' }]);
  assert.deepEqual(parseCSV(toCSV(rows)), rows);
});

// ---------- end to end on the synthetic sample ----------
test('engine finds exactly the planted issues in the synthetic sample, nothing more', () => {
  const g = generate(42);
  const r = reconcile(g, { asOf: g.meta.asOf });
  const key = e => [e.type, e.customer_id, e.invoice_id ?? e.payment_id ?? e.sku ?? e.period].join('|');
  const found = r.exceptions.map(e => ({ ...e, k: e.type === 'MISSING_INVOICE' || e.type === 'UNDER_BILLED' || e.type === 'OVER_BILLED' ? [e.type, e.customer_id, e.period].join('|') : key(e) }));
  const want = g.planted.map(p => (p.type === 'MISSING_INVOICE' || p.type === 'UNDER_BILLED' || p.type === 'OVER_BILLED') ? [p.type, p.customer_id, p.period].join('|') : key(p));
  assert.deepEqual(found.map(f => f.k).sort(), [...want].sort());
  for (const p of g.planted) {
    if (p.amountCents === undefined) continue;
    const f = found.find(x => x.k === want[g.planted.indexOf(p)]);
    assert.equal(f.amountCents, p.amountCents, p.type + ' amount');
  }
  assert.equal(r.paymentHygiene.feedDuplicates.length, g.meta.feedDuplicateIds.length);
  assert.equal(r.paymentHygiene.refCollisions.length, g.meta.collidingPairs);
});

test('bundled sample CSVs are the same as the generator output', () => {
  const g = generate(42);
  for (const t of ['customers', 'rates', 'usage', 'invoices', 'payments', 'costs']) {
    const onDisk = readFileSync(new URL(`../sample/${t}.csv`, import.meta.url), 'utf8');
    assert.equal(onDisk, toCSV(g[t]), t + '.csv is stale; run npm run sample');
  }
});
