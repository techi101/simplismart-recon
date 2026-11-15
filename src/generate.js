// Deterministic SYNTHETIC dataset shaped like a GenAI inference platform's billing.
// Customers, prices, quantities and payments are all made up. Known problems are
// planted on purpose and listed in `planted` so tests can check the engine finds
// exactly those and nothing else.

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Illustrative rate card. NOT Simplismart's real prices.
export const SKUS = [
  { sku: 'llm-llama-8b',      meter: 'Model API',   unit: '1M tokens',  list: 0.15,  cost: 0.07,  qty: [3000, 40000] },
  { sku: 'llm-llama-70b',     meter: 'Model API',   unit: '1M tokens',  list: 0.80,  cost: 0.46,  qty: [800, 12000] },
  { sku: 'llm-deepseek-r1',   meter: 'Model API',   unit: '1M tokens',  list: 4.00,  cost: 2.60,  qty: [100, 2500] },
  { sku: 'img-flux-dev',      meter: 'Image',       unit: 'image',      list: 0.03,  cost: 0.017, qty: [40000, 600000] },
  { sku: 'img-sdxl',          meter: 'Image',       unit: 'image',      list: 0.25,  cost: 0.15,  qty: [2000, 30000] },
  { sku: 'stt-whisper-turbo', meter: 'Speech',      unit: 'audio min',  list: 0.002, cost: 0.0011, qty: [200000, 4000000] },
  { sku: 'gpu-h100-hr',       meter: 'Dedicated GPU', unit: 'GPU hour', list: 4.50,  cost: 3.10,  qty: [700, 5800] },
  { sku: 'gpu-l40s-hr',       meter: 'Dedicated GPU', unit: 'GPU hour', list: 2.10,  cost: 1.35,  qty: [700, 2900] },
];

export const CUSTOMERS = [
  ['C01', 'Lumen Reels', 'Lumen Reels Pvt Ltd', 2000, 30, ['img-flux-dev', 'img-sdxl', 'gpu-h100-hr']],
  ['C02', 'Kestrel Voice', 'Kestrel Voice Technologies', 1500, 30, ['stt-whisper-turbo', 'llm-llama-8b', 'gpu-l40s-hr']],
  ['C03', 'Paperkite Docs', 'Paperkite', 500, 15, ['llm-llama-70b', 'llm-llama-8b']],
  ['C04', 'Tandem Health', 'Tandem Health Labs', 3000, 45, ['llm-llama-70b', 'stt-whisper-turbo', 'gpu-h100-hr']],
  ['C05', 'Brightloop Video', 'Brightloop', 2000, 30, ['img-sdxl', 'gpu-h100-hr', 'llm-llama-8b']],
  ['C06', 'Monsoon Commerce', 'Monsoon Commerce Pvt Ltd', 1000, 30, ['llm-llama-8b', 'llm-deepseek-r1']],
  ['C07', 'Quarry Analytics', 'Quarry Analytics Inc', 1000, 30, ['llm-deepseek-r1', 'llm-llama-70b']],
  ['C08', 'Fernway Learning', 'Fernway', 500, 15, ['llm-llama-8b', 'stt-whisper-turbo']],
  ['C09', 'Ostrich Pay', 'Ostrich Payments Pvt Ltd', 2500, 30, ['llm-llama-70b', 'gpu-l40s-hr']],
  ['C10', 'Halcyon Agents', 'Halcyon', 1500, 30, ['llm-deepseek-r1', 'llm-llama-8b']],
  ['C11', 'Cobalt Studio', 'Cobalt Studio LLC', 1000, 30, ['img-flux-dev', 'img-sdxl']],
  ['C12', 'Nimbus Hire', 'Nimbus Hire', 500, 30, ['llm-llama-8b', 'llm-llama-70b']],
  ['C13', 'Saffron Insure', 'Saffron Insurance Brokers', 3000, 30, ['llm-llama-70b', 'stt-whisper-turbo', 'gpu-l40s-hr']],
  ['C14', 'Vireo Logistics', 'Vireo Logistics Pvt Ltd', 1000, 30, ['llm-llama-8b', 'gpu-l40s-hr']],
];

// Contract (negotiated) prices that override the list price.
export const CONTRACTS = [
  ['C01', 'gpu-h100-hr', 3.90], ['C01', 'img-flux-dev', 0.025],
  ['C02', 'stt-whisper-turbo', 0.0016], ['C02', 'gpu-l40s-hr', 1.80],
  ['C04', 'gpu-h100-hr', 4.00], ['C04', 'llm-llama-70b', 0.70],
  ['C09', 'llm-llama-70b', 0.72], ['C13', 'gpu-l40s-hr', 1.90],
];

export const PERIODS = ['2026-08', '2026-09', '2026-10'];
export const AS_OF = '2026-11-15';

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const nextMonthFirst = p => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };
const money = c => (c / 100).toFixed(2);

export function generate(seed = 42) {
  const rnd = mulberry32(seed);
  const skuBy = Object.fromEntries(SKUS.map(s => [s.sku, s]));
  const contract = new Map(CONTRACTS.map(([c, s, p]) => [c + '|' + s, p]));
  const priceOf = (c, s) => contract.get(c + '|' + s) ?? skuBy[s].list;
  const lineCents = (q, p) => Math.round(q * p * 100);

  const customers = CUSTOMERS.map(([id, name, alias, fee, terms]) => ({ customer_id: id, customer_name: name, aliases: alias, platform_fee: money(fee * 100), terms_days: terms }));
  const rates = [
    ...SKUS.map(s => ({ customer_id: '*', sku: s.sku, meter: s.meter, unit: s.unit, unit_price: s.list })),
    ...CONTRACTS.map(([c, s, p]) => ({ customer_id: c, sku: s, meter: skuBy[s].meter, unit: skuBy[s].unit, unit_price: p })),
  ];
  const costs = SKUS.map(s => ({ sku: s.sku, unit_cost: s.cost }));

  const usage = [], invoices = [], payments = [], planted = [];
  let invSeq = 0, paySeq = 0, utrSeq = 0;
  const utr = () => 'UTR' + String(604118200 + (++utrSeq) * 37).padStart(12, '0');
  const pay = (custName, date, cents, remittance) => {
    const p = { payment_id: 'PAY-' + String(++paySeq).padStart(5, '0'), received_date: date, bank_ref: utr(), payer_name: custName, amount: money(cents), remittance: remittance ?? '' };
    payments.push(p); return p;
  };

  for (const [cid, name, alias, fee, terms, skus] of CUSTOMERS) {
    for (const period of PERIODS) {
      // ---- usage
      let expected = fee * 100;
      const lines = [];
      for (const s of skus) {
        const [lo, hi] = skuBy[s].qty;
        const q = Math.round(lo + rnd() * (hi - lo));
        usage.push({ customer_id: cid, period, sku: s, quantity: q });
        const c = lineCents(q, priceOf(cid, s));
        lines.push({ sku: s, q, c, listC: lineCents(q, skuBy[s].list) });
        expected += c;
      }
      if (cid === 'C10' && period === '2026-10') {
        usage.push({ customer_id: cid, period, sku: 'llm-qwen3-235b', quantity: 1800 });
        planted.push({ type: 'UNRATED_USAGE', customer_id: cid, period, sku: 'llm-qwen3-235b' });
      }

      // ---- invoice
      if ((cid === 'C03' && period === '2026-09') || (cid === 'C11' && period === '2026-10')) {
        planted.push({ type: 'MISSING_INVOICE', customer_id: cid, period, amountCents: expected });
        continue;
      }
      let billed = expected;
      if (cid === 'C05' && period === '2026-08') { const gpu = lines.find(l => l.sku === 'gpu-h100-hr'); billed -= gpu.c; planted.push({ type: 'UNDER_BILLED', customer_id: cid, period, amountCents: gpu.c, why: 'GPU line left off the invoice' }); }
      if (cid === 'C08' && period === '2026-09') { const l = lines[0]; const late = Math.round(l.c * 0.2); billed -= late; planted.push({ type: 'UNDER_BILLED', customer_id: cid, period, amountCents: late, why: 'last 20% of token events arrived after the invoice run' }); }
      if (cid === 'C14' && period === '2026-10') { billed -= fee * 100; planted.push({ type: 'UNDER_BILLED', customer_id: cid, period, amountCents: fee * 100, why: 'platform fee not added' }); }
      if (cid === 'C02' && period === '2026-10') { const extra = lines.reduce((s, l) => s + (l.listC - l.c), 0); billed += extra; planted.push({ type: 'OVER_BILLED', customer_id: cid, period, amountCents: extra, why: 'list price used instead of contract price' }); }

      const issue = nextMonthFirst(period);
      const due = addDays(issue, terms);
      const inv = { invoice_id: `INV-2026-${String(++invSeq).padStart(4, '0')}`, customer_id: cid, period, issue_date: issue, due_date: due, amount: money(billed) };
      invoices.push(inv);
      if (cid === 'C07' && period === '2026-09') {
        const dup = { ...inv, invoice_id: `INV-2026-${String(++invSeq).padStart(4, '0')}`, issue_date: addDays(issue, 2) };
        invoices.push(dup);
        planted.push({ type: 'DUPLICATE_INVOICE', customer_id: cid, period, invoice_id: dup.invoice_id, amountCents: billed });
      }

      // ---- cash
      const unpaid = (cid === 'C13' && period !== '2026-10') || (period === '2026-10' && rnd() < 0.55) || (cid === 'C02' && period === '2026-10');
      if (unpaid) continue;
      const payDate = addDays(due, Math.round(rnd() * 12) - 8);
      if (payDate > AS_OF) continue;
      const withRef = rnd() < 0.7;
      const ref = withRef ? `Payment for ${inv.invoice_id}` : 'Monthly inference charges';

      if (cid === 'C06' && period === '2026-09') {
        const short = Math.round(billed * 0.1);
        pay(alias, payDate, billed - short, `${inv.invoice_id} less 10% TDS`);
        planted.push({ type: 'SHORT_PAID', customer_id: cid, period, invoice_id: inv.invoice_id, amountCents: short });
      } else if (cid === 'C12' && period === '2026-08') {
        pay(alias, payDate, billed - 2500, `Payment for ${inv.invoice_id}`);
        planted.push({ type: 'SHORT_PAID', customer_id: cid, period, invoice_id: inv.invoice_id, amountCents: 2500 });
      } else if (cid === 'C09' && period === '2026-09') {
        const rounded = Math.round(billed / 100000) * 100000; // paid a rounded figure, no reference
        const p = pay(alias, payDate, rounded, 'Sept services');
        planted.push({ type: 'UNAPPLIED_CASH', customer_id: cid, payment_id: p.payment_id, amountCents: rounded });
      } else if (cid === 'C04' && period === '2026-08') {
        pay(alias, payDate, billed, `Payment for ${inv.invoice_id}`);
        pay(alias, addDays(payDate, 6), billed, `Payment for ${inv.invoice_id}`);
        planted.push({ type: 'DUPLICATE_PAYMENT', customer_id: cid, period, invoice_id: inv.invoice_id, amountCents: billed });
      } else {
        pay(withRef ? alias : name, payDate, billed, ref);
      }
    }
  }

  // Unknown payer, no reference.
  const stray = pay('N ORBIT SYSTEMS', '2026-10-21', 431250, 'NEFT inward');
  planted.push({ type: 'UNAPPLIED_CASH', customer_id: '', payment_id: stray.payment_id, amountCents: 431250 });

  // Bank feed exported twice for two rows: exact duplicate payment_id. These must be removed.
  const feedDupes = [payments[3], payments[17]].map(p => ({ ...p }));
  payments.push(...feedDupes);

  // Different payers whose bank_ref happens to collide. These are real, separate payments
  // and must be kept. Deduping on bank_ref would wrongly delete one of each pair.
  const pairs = [[1, 9], [5, 13], [11, 19]];
  for (const [a, b] of pairs) {
    if (!payments[b] || payments[a].payer_name === payments[b].payer_name) throw new Error('bad collision pair ' + a + ',' + b);
    payments[b].bank_ref = payments[a].bank_ref;
  }

  payments.sort((x, y) => x.received_date.localeCompare(y.received_date) || x.payment_id.localeCompare(y.payment_id));
  return { customers, rates, usage, invoices, payments, costs, planted, meta: { feedDuplicateIds: feedDupes.map(p => p.payment_id), collidingPairs: 3, asOf: AS_OF } };
}
