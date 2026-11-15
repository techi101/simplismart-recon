// Usage -> invoice -> cash reconciliation engine.
// Pure functions, no DOM. All money is held in integer cents.

export const SCHEMAS = {
  customers: { required: ['customer_id', 'customer_name', 'platform_fee', 'terms_days'], optional: ['aliases'] },
  rates: { required: ['customer_id', 'sku', 'unit', 'unit_price'], optional: ['meter'] },
  usage: { required: ['customer_id', 'period', 'sku', 'quantity'], optional: [] },
  invoices: { required: ['invoice_id', 'customer_id', 'period', 'issue_date', 'due_date', 'amount'], optional: [] },
  payments: { required: ['payment_id', 'received_date', 'bank_ref', 'payer_name', 'amount'], optional: ['remittance', 'customer_id'], mayBeEmpty: true },
  costs: { required: ['sku', 'unit_cost'], optional: [], mayBeEmpty: true },
};

export const DEFAULT_OPTIONS = {
  asOf: null,          // 'YYYY-MM-DD'; defaults to the latest date seen in the data
  tolAbsCents: 100,    // differences under $1.00 are ignored...
  tolRel: 0.005,       // ...or under 0.5% of expected, whichever is larger
};

export const EXCEPTION_TYPES = {
  MISSING_INVOICE:   { label: 'Missing invoice',   side: 'billing', kind: 'leakage',  help: 'Usage was metered for this customer and month, but no invoice exists.' },
  UNDER_BILLED:      { label: 'Under billed',      side: 'billing', kind: 'leakage',  help: 'Invoice total is below what the metered usage is worth at the contract rate.' },
  OVER_BILLED:       { label: 'Over billed',       side: 'billing', kind: 'dispute',  help: 'Invoice total is above the rated usage. Likely a contract rate not applied; expect a dispute or credit note.' },
  DUPLICATE_INVOICE: { label: 'Duplicate invoice', side: 'billing', kind: 'dispute',  help: 'More than one invoice was raised for the same customer and month.' },
  UNRATED_USAGE:     { label: 'Unrated usage',     side: 'billing', kind: 'leakage',  help: 'Usage on a SKU with no list or contract price, so it cannot be billed until a rate is set.' },
  INVOICE_NO_USAGE:  { label: 'Invoice without usage', side: 'billing', kind: 'dispute', help: 'An invoice exists for a customer and month with no metered usage and no platform fee.' },
  DUPLICATE_PAYMENT: { label: 'Duplicate payment', side: 'cash',    kind: 'refund',   help: 'The same invoice was paid twice. The extra amount is owed back or should be applied elsewhere.' },
  OVERPAID:          { label: 'Overpaid',          side: 'cash',    kind: 'refund',   help: 'Cash applied to the invoice exceeds its amount.' },
  SHORT_PAID:        { label: 'Short paid',        side: 'cash',    kind: 'collect',  help: 'A payment was applied but left a balance. Often a deducted fee or withheld tax.' },
  UNAPPLIED_CASH:    { label: 'Unapplied cash',    side: 'cash',    kind: 'unapplied', help: 'Money is in the bank but could not be tied to an invoice.' },
};

// ---------- parsing helpers ----------

export function toCents(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export const fmtUSD = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function normName(s) {
  return String(s ?? '').toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|inc|llc|technologies|technology|labs|ai)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function validateTable(name, rows) {
  const schema = SCHEMAS[name];
  if (!schema) return [`Unknown table "${name}"`];
  if (!rows || rows.length === 0) return schema.mayBeEmpty ? [] : [`${name}.csv has no rows`];
  const cols = Object.keys(rows[0]);
  const missing = schema.required.filter(c => !cols.includes(c));
  return missing.length ? [`${name}.csv is missing column(s): ${missing.join(', ')}`] : [];
}

// ---------- step 1: payment feed hygiene ----------
// Dedupe ONLY on payment_id. bank_ref (UTR) values can repeat across different
// payers, so deduping on them deletes genuine money. We report how much a
// bank_ref dedupe would have wrongly removed.

export function cleanPayments(payments) {
  const seen = new Map();
  const kept = [];
  const feedDuplicates = [];
  for (const p of payments) {
    const id = p.payment_id;
    if (seen.has(id)) { feedDuplicates.push(p); continue; }
    seen.set(id, p);
    kept.push(p);
  }
  const byRef = new Map();
  for (const p of kept) {
    if (!p.bank_ref) continue;
    if (!byRef.has(p.bank_ref)) byRef.set(p.bank_ref, []);
    byRef.get(p.bank_ref).push(p);
  }
  const refCollisions = [];
  for (const [ref, list] of byRef) if (list.length > 1) refCollisions.push({ bank_ref: ref, payments: list });
  const wronglyDropped = refCollisions.flatMap(c => c.payments.slice(1));
  return {
    kept,
    feedDuplicates,
    refCollisions,
    refDedupeWouldDrop: { count: wronglyDropped.length, cents: wronglyDropped.reduce((s, p) => s + toCents(p.amount), 0) },
  };
}

// ---------- step 2: rate usage and compare to invoices ----------

export function rateUsage(data) {
  const custById = new Map(data.customers.map(c => [c.customer_id, c]));
  const rateKey = (cust, sku) => cust + '\u0000' + sku;
  const rates = new Map(data.rates.map(r => [rateKey(r.customer_id, r.sku), r]));
  const costs = new Map((data.costs ?? []).map(c => [c.sku, Number(c.unit_cost)]));

  const groups = new Map(); // customer|period -> {lines, expected, cost}
  const unrated = [];
  for (const u of data.usage) {
    const key = u.customer_id + '|' + u.period;
    if (!groups.has(key)) groups.set(key, { customer_id: u.customer_id, period: u.period, lines: [], expectedCents: 0, costCents: 0 });
    const g = groups.get(key);
    const qty = Number(u.quantity);
    const rate = rates.get(rateKey(u.customer_id, u.sku)) ?? rates.get(rateKey('*', u.sku));
    const unitCost = costs.get(u.sku);
    const costCents = Number.isFinite(unitCost) ? Math.round(qty * unitCost * 100) : 0;
    g.costCents += costCents;
    if (!rate) {
      g.lines.push({ sku: u.sku, quantity: qty, unit_price: null, cents: 0, source: 'none', costCents });
      unrated.push({ customer_id: u.customer_id, period: u.period, sku: u.sku, quantity: qty });
      continue;
    }
    const price = Number(rate.unit_price);
    const cents = Math.round(qty * price * 100);
    g.lines.push({ sku: u.sku, unit: rate.unit, quantity: qty, unit_price: price, cents, source: rate.customer_id === '*' ? 'list' : 'contract', costCents });
    g.expectedCents += cents;
  }
  for (const g of groups.values()) {
    const fee = toCents(custById.get(g.customer_id)?.platform_fee);
    g.platformFeeCents = Number.isFinite(fee) ? fee : 0;
    g.expectedCents += g.platformFeeCents;
  }
  return { groups, unrated };
}

export function checkBilling(data, opts = DEFAULT_OPTIONS) {
  const { groups, unrated } = rateUsage(data);
  const exceptions = [];
  const invByKey = new Map();
  for (const inv of data.invoices) {
    const key = inv.customer_id + '|' + inv.period;
    if (!invByKey.has(key)) invByKey.set(key, []);
    invByKey.get(key).push(inv);
  }
  const custById = new Map(data.customers.map(c => [c.customer_id, c]));
  const keys = new Set([...groups.keys(), ...invByKey.keys()]);
  const rows = [];

  for (const key of keys) {
    const [customer_id, period] = key.split('|');
    const g = groups.get(key);
    const invs = (invByKey.get(key) ?? []).slice().sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.invoice_id.localeCompare(b.invoice_id));
    const expected = g ? g.expectedCents : 0;
    const primary = invs[0];
    const invoiced = primary ? toCents(primary.amount) : 0;
    const row = { customer_id, period, expectedCents: expected, invoicedCents: invoiced, costCents: g?.costCents ?? 0, invoiceIds: invs.map(i => i.invoice_id), lines: g?.lines ?? [], platformFeeCents: g?.platformFeeCents ?? 0 };
    rows.push(row);
    const base = { customer_id, period, customer_name: custById.get(customer_id)?.customer_name ?? customer_id };

    if (!g) {
      exceptions.push({ ...base, type: 'INVOICE_NO_USAGE', amountCents: invoiced, invoice_id: primary.invoice_id, detail: `Invoice ${primary.invoice_id} for ${fmtUSD(invoiced)} has no metered usage behind it.` });
      continue;
    }
    if (!primary) {
      exceptions.push({ ...base, type: 'MISSING_INVOICE', amountCents: expected, detail: `Usage worth ${fmtUSD(expected)} (incl. platform fee) was never invoiced.`, evidence: g.lines });
      continue;
    }
    for (const dup of invs.slice(1)) {
      exceptions.push({ ...base, type: 'DUPLICATE_INVOICE', amountCents: toCents(dup.amount), invoice_id: dup.invoice_id, detail: `${dup.invoice_id} repeats ${primary.invoice_id} for the same customer and month.` });
    }
    const diff = invoiced - expected;
    const tol = Math.max(opts.tolAbsCents ?? 100, Math.round(Math.abs(expected) * (opts.tolRel ?? 0.005)));
    if (diff < -tol) {
      exceptions.push({ ...base, type: 'UNDER_BILLED', amountCents: -diff, invoice_id: primary.invoice_id, detail: `Invoiced ${fmtUSD(invoiced)} against ${fmtUSD(expected)} of rated usage.`, evidence: g.lines });
    } else if (diff > tol) {
      exceptions.push({ ...base, type: 'OVER_BILLED', amountCents: diff, invoice_id: primary.invoice_id, detail: `Invoiced ${fmtUSD(invoiced)}, but rated usage at contract prices is ${fmtUSD(expected)}.`, evidence: g.lines });
    }
  }
  for (const u of unrated) {
    exceptions.push({ customer_id: u.customer_id, period: u.period, customer_name: custById.get(u.customer_id)?.customer_name ?? u.customer_id, type: 'UNRATED_USAGE', amountCents: 0, sku: u.sku, detail: `${u.quantity.toLocaleString('en-US')} units of ${u.sku} have no price on the rate card.` });
  }
  return { rows, exceptions };
}

// ---------- step 3: apply cash to invoices ----------

export function matchCash(data, cleanedPayments) {
  const custById = new Map(data.customers.map(c => [c.customer_id, c]));
  const nameToCust = new Map();
  for (const c of data.customers) {
    nameToCust.set(normName(c.customer_name), c.customer_id);
    for (const a of String(c.aliases ?? '').split('|')) if (a.trim()) nameToCust.set(normName(a), c.customer_id);
  }
  // Duplicate invoices are excluded from cash application: they are not real receivables.
  const firstByKey = new Map();
  for (const inv of [...data.invoices].sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.invoice_id.localeCompare(b.invoice_id))) {
    const k = inv.customer_id + '|' + inv.period;
    if (!firstByKey.has(k)) firstByKey.set(k, inv.invoice_id);
  }
  const invoices = new Map();
  for (const inv of data.invoices) {
    if (firstByKey.get(inv.customer_id + '|' + inv.period) !== inv.invoice_id) continue;
    invoices.set(inv.invoice_id, { ...inv, amountCents: toCents(inv.amount), appliedCents: 0, payments: [] });
  }

  const applications = [];
  const unapplied = [];
  const sorted = [...cleanedPayments].sort((a, b) => a.received_date.localeCompare(b.received_date) || a.payment_id.localeCompare(b.payment_id));
  for (const p of sorted) {
    const cents = toCents(p.amount);
    const customer_id = p.customer_id && custById.has(p.customer_id) ? p.customer_id : nameToCust.get(normName(p.payer_name)) ?? null;
    const refs = String(p.remittance ?? '').toUpperCase().match(/[A-Z]+-\d{4}-\d{2,}/g) ?? [];
    const refInv = refs.map(r => invoices.get(r)).find(Boolean);

    let target = null, method = null;
    if (refInv) { target = refInv; method = 'remittance reference'; }
    else if (customer_id) {
      const open = [...invoices.values()].filter(i => i.customer_id === customer_id && i.amountCents - i.appliedCents === cents);
      if (open.length >= 1) { target = open.sort((a, b) => a.due_date.localeCompare(b.due_date))[0]; method = 'customer + exact open amount'; }
    }
    if (!target) {
      unapplied.push({ payment: p, customer_id, cents, reason: customer_id ? 'Payer recognised, but no open invoice matches this amount and there is no invoice number in the remittance.' : 'Payer name not recognised and no invoice number in the remittance.' });
      continue;
    }
    target.appliedCents += cents;
    target.payments.push({ payment_id: p.payment_id, cents, received_date: p.received_date, method });
    applications.push({ payment_id: p.payment_id, invoice_id: target.invoice_id, cents, method });
  }

  const exceptions = [];
  for (const inv of invoices.values()) {
    const base = { customer_id: inv.customer_id, period: inv.period, customer_name: custById.get(inv.customer_id)?.customer_name ?? inv.customer_id, invoice_id: inv.invoice_id };
    const over = inv.appliedCents - inv.amountCents;
    if (over > 0) {
      const dupPay = inv.payments.length > 1 && inv.payments.some(x => x.cents === inv.amountCents) && inv.payments.filter(x => x.cents === inv.amountCents).length > 1;
      exceptions.push({ ...base, type: dupPay ? 'DUPLICATE_PAYMENT' : 'OVERPAID', amountCents: over, detail: `${inv.payments.length} payment(s) totalling ${fmtUSD(inv.appliedCents)} applied to a ${fmtUSD(inv.amountCents)} invoice.`, evidence: inv.payments });
    } else if (inv.appliedCents > 0 && over < 0) {
      exceptions.push({ ...base, type: 'SHORT_PAID', amountCents: -over, detail: `Received ${fmtUSD(inv.appliedCents)} of ${fmtUSD(inv.amountCents)}; ${fmtUSD(-over)} still open.`, evidence: inv.payments });
    }
  }
  for (const u of unapplied) {
    exceptions.push({ customer_id: u.customer_id ?? '', period: '', customer_name: u.customer_id ? custById.get(u.customer_id)?.customer_name : u.payment.payer_name, type: 'UNAPPLIED_CASH', amountCents: u.cents, payment_id: u.payment.payment_id, detail: u.reason, evidence: [u.payment] });
  }
  return { invoices, applications, unapplied, exceptions };
}

// ---------- step 4: AR ageing ----------

export const AGE_BUCKETS = ['Not due', '1-30', '31-60', '61-90', '90+'];

export function ageReceivables(invoices, asOf) {
  const rows = [];
  const totals = Object.fromEntries(AGE_BUCKETS.map(b => [b, 0]));
  for (const inv of invoices.values()) {
    const open = inv.amountCents - inv.appliedCents;
    if (open <= 0) continue;
    const late = daysBetween(inv.due_date, asOf);
    const bucket = late <= 0 ? 'Not due' : late <= 30 ? '1-30' : late <= 60 ? '31-60' : late <= 90 ? '61-90' : '90+';
    totals[bucket] += open;
    rows.push({ invoice_id: inv.invoice_id, customer_id: inv.customer_id, period: inv.period, due_date: inv.due_date, daysLate: Math.max(0, late), openCents: open, bucket });
  }
  return { rows: rows.sort((a, b) => b.daysLate - a.daysLate || b.openCents - a.openCents), totals };
}

// ---------- orchestration ----------

function latestDate(data) {
  const ds = [...data.invoices.map(i => i.issue_date), ...data.payments.map(p => p.received_date)].filter(Boolean).sort();
  return ds[ds.length - 1] ?? new Date().toISOString().slice(0, 10);
}

export function reconcile(data, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const asOf = opts.asOf || latestDate(data);
  data = { ...data, payments: data.payments ?? [], costs: data.costs ?? [] };
  const errors = Object.keys(SCHEMAS).flatMap(k => validateTable(k, data[k]));
  if (errors.length) return { errors };

  const cash = cleanPayments(data.payments);
  const billing = checkBilling(data, opts);
  const matched = matchCash(data, cash.kept);
  const ageing = ageReceivables(matched.invoices, asOf);
  const exceptions = [...billing.exceptions, ...matched.exceptions]
    .map((e, i) => ({ id: 'EX-' + String(i + 1).padStart(3, '0'), ...e, ...EXCEPTION_TYPES[e.type] && { label: EXCEPTION_TYPES[e.type].label, side: EXCEPTION_TYPES[e.type].side, kind: EXCEPTION_TYPES[e.type].kind } }))
    .sort((a, b) => b.amountCents - a.amountCents);

  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const byKind = k => sum(exceptions.filter(e => e.kind === k), e => e.amountCents);

  // Customer level view: expected vs invoiced vs collected vs cost.
  const custName = new Map(data.customers.map(c => [c.customer_id, c.customer_name]));
  const cust = new Map();
  const get = id => { if (!cust.has(id)) cust.set(id, { customer_id: id, customer_name: custName.get(id) ?? id, expectedCents: 0, invoicedCents: 0, collectedCents: 0, openCents: 0, costCents: 0, exceptions: 0 }); return cust.get(id); };
  for (const r of billing.rows) { const c = get(r.customer_id); c.expectedCents += r.expectedCents; c.costCents += r.costCents; }
  for (const inv of matched.invoices.values()) { const c = get(inv.customer_id); c.invoicedCents += inv.amountCents; c.collectedCents += inv.appliedCents; c.openCents += Math.max(0, inv.amountCents - inv.appliedCents); }
  for (const e of exceptions) if (e.customer_id) get(e.customer_id).exceptions += 1;

  const overdue = sum(ageing.rows.filter(r => r.daysLate > 0), r => r.openCents);
  return {
    errors: [],
    asOf,
    options: opts,
    exceptions,
    billingRows: billing.rows,
    invoices: matched.invoices,
    applications: matched.applications,
    ageing,
    customers: [...cust.values()].sort((a, b) => b.expectedCents - a.expectedCents),
    paymentHygiene: { feedDuplicates: cash.feedDuplicates, refCollisions: cash.refCollisions, refDedupeWouldDrop: cash.refDedupeWouldDrop, kept: cash.kept.length, raw: data.payments.length },
    summary: {
      expectedCents: sum(billing.rows, r => r.expectedCents),
      invoicedCents: sum([...matched.invoices.values()], i => i.amountCents),
      collectedCents: sum(cash.kept, p => toCents(p.amount)),
      appliedCents: sum(matched.applications, a => a.cents),
      leakageCents: byKind('leakage'),
      disputeCents: byKind('dispute'),
      refundCents: byKind('refund'),
      unappliedCents: byKind('unapplied'),
      openARCents: sum(ageing.rows, r => r.openCents),
      overdueCents: overdue,
      costCents: sum(billing.rows, r => r.costCents),
      exceptionCount: exceptions.length,
    },
  };
}
