import { parseCSV, toCSV } from './src/csv.js';
import { reconcile, SCHEMAS, EXCEPTION_TYPES, AGE_BUCKETS, fmtUSD } from './src/recon.js';

const TABLES = ['customers', 'rates', 'usage', 'invoices', 'payments', 'costs'];
const TABLE_INFO = {
  customers: 'One row per customer: monthly platform fee, payment terms, and any other names they pay under.',
  rates: 'List prices (customer_id = *) plus contract prices that override them for a customer.',
  usage: 'Metered quantity per customer, month and SKU, exported from the metering system.',
  invoices: 'Invoices raised, one per customer and month, with issue and due dates.',
  payments: 'Bank receipts. Remittance text is searched for invoice numbers.',
  costs: 'Optional. Unit cost per SKU (GPU and serving cost) for gross margin.',
};
const ACTIONS = {
  MISSING_INVOICE: 'Raise the invoice for this month. Check why the billing run skipped this customer.',
  UNDER_BILLED: 'Raise a supplementary invoice for the gap, then check the meter cutoff and the invoice template for dropped lines.',
  OVER_BILLED: 'Issue a credit note and fix the contract price in the billing system before the next run.',
  DUPLICATE_INVOICE: 'Void the duplicate and tell the customer which invoice to pay.',
  UNRATED_USAGE: 'Add this SKU to the rate card (list or contract), then rebill the month.',
  INVOICE_NO_USAGE: 'Check with sales whether this was a manual or one off charge. Void it if raised in error.',
  DUPLICATE_PAYMENT: 'Refund the extra payment or, with the customer\'s OK, hold it as credit against the next invoice.',
  OVERPAID: 'Hold the excess as customer credit and confirm with the customer.',
  SHORT_PAID: 'Ask for the TDS certificate or bank charge advice. If neither, chase the balance.',
  UNAPPLIED_CASH: 'Identify the payer and ask for a remittance advice, then apply the cash to the right invoice.',
};
const KIND_COLOR = { leakage: 'var(--critical)', dispute: 'var(--serious)', refund: 'var(--info)', unapplied: 'var(--warn)', collect: 'var(--warn)' };
const ICONS = {
  leakage: '<svg viewBox="0 0 16 16"><path d="M8 2v9M4.5 7.5L8 11l3.5-3.5M3 14h10"/></svg>',
  dispute: '<svg viewBox="0 0 16 16"><path d="M8 1.5l6.5 12h-13z"/><path d="M8 6v3.5M8 11.5v.01"/></svg>',
  refund: '<svg viewBox="0 0 16 16"><path d="M5 4L2 7l3 3"/><path d="M2 7h8a4 4 0 010 8H8"/></svg>',
  unapplied: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M6 6.2a2 2 0 113 1.7c-.6.4-1 .8-1 1.5M8 11.5v.01"/></svg>',
  collect: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
};

const state = {
  tables: {}, // name -> { rows, source: 'sample' | 'user', filename }
  result: null,
  asOf: '2026-11-15',
  ex: { side: 'all', kind: '', type: '', customer: '', q: '', sortKey: 'amountCents', sortDir: -1 },
  ar: { bucket: '' },
  cust: { sortKey: 'expectedCents', sortDir: -1 },
};

// ---------- utils ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = c => {
  const v = Math.abs(c) / 100, s = c < 0 ? '-' : '';
  if (v >= 1e6) return `${s}$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${s}$${(v / 1e3).toFixed(1)}k`;
  return s + '$' + v.toLocaleString('en-US', { minimumFractionDigits: v < 100 ? 2 : 0, maximumFractionDigits: v < 100 ? 2 : 0 });
};
const pct = x => (x * 100).toFixed(1) + '%';
const monthLabel = p => { if (!p) return ''; const [y, m] = p.split('-'); return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }); };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const pill = (kind, label) => `<span class="pill ${kind}">${ICONS[kind] ?? ''}${esc(label)}</span>`;
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

// ---------- data ----------
async function loadSample() {
  const texts = await Promise.all(TABLES.map(t => fetch(`sample/${t}.csv`).then(r => { if (!r.ok) throw new Error(t); return r.text(); })));
  TABLES.forEach((t, i) => { state.tables[t] = { rows: parseCSV(texts[i]), source: 'sample', filename: `${t}.csv` }; });
  state.asOf = '2026-11-15';
  run();
}

function run() {
  const data = Object.fromEntries(TABLES.map(t => [t, state.tables[t]?.rows ?? []]));
  state.result = reconcile(data, { asOf: state.asOf });
  const userCount = TABLES.filter(t => state.tables[t]?.source === 'user').length;
  $('#datasetLabel').textContent = userCount ? `Your data (${userCount} of 6 files)` : 'Synthetic sample';
  $('#datasetPill').classList.toggle('user', userCount > 0);
  const banner = $('.synthetic-banner');
  banner.classList.toggle('user', userCount > 0);
  $('#bannerText').innerHTML = userCount
    ? `<b>Your files are loaded</b> (${userCount} of 6). Tables you did not replace still use the synthetic sample. Nothing was uploaded to a server.`
    : `<b>Synthetic demo data.</b> Made-up customers, prices and payments shaped like a GenAI inference platform's billing (token, image, audio minute and GPU hour meters). Not Simplismart's data or prices.`;
  const n = state.result.errors?.length ? 0 : state.result.exceptions.length;
  $('#navExCount').textContent = n || '';
  render();
}

// ---------- router ----------
const VIEWS = { overview, exceptions, ar, customers, data: dataView, method };
function render() {
  const view = (location.hash.slice(1).split('?')[0]) || 'overview';
  const fn = VIEWS[view] ?? overview;
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.view === (VIEWS[view] ? view : 'overview')));
  const r = state.result;
  if (!r) { $('#view').innerHTML = `<div class="card empty"><h3>Loading sample data…</h3></div>`; return; }
  if (r.errors?.length && fn !== dataView && fn !== method) { $('#view').innerHTML = errorState(r.errors); return; }
  $('#view').innerHTML = fn(r);
  bind(view);
}
window.addEventListener('hashchange', () => { closeDrawer(); render(); window.scrollTo(0, 0); });

function errorState(errors) {
  return `<div class="card empty">
    <div class="e-icon"><svg viewBox="0 0 24 24"><path d="M12 3l9 17H3z"/><path d="M12 10v4M12 17v.01"/></svg></div>
    <h3>Can't reconcile yet</h3>
    <p>${errors.map(esc).join('<br>')}</p>
    <a class="btn primary" href="#data">Fix in Data sources</a>
  </div>`;
}

function asOfField() {
  return `<label class="field" title="Ageing and overdue are measured on this date">
    <svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="13" rx="2"/><path d="M3 8h14M7 2.5v3M13 2.5v3"/></svg>
    As of <input type="date" id="asOf" value="${esc(state.asOf)}"></label>`;
}

// ---------- overview ----------
function overview(r) {
  const s = r.summary;
  const periods = [...new Set(r.billingRows.map(x => x.period))].sort();
  const range = periods.length ? `${monthLabel(periods[0])} to ${monthLabel(periods[periods.length - 1])}` : '';
  const count = k => r.exceptions.filter(e => e.kind === k).length;
  const notInvoiced = s.expectedCents - s.invoicedCents;
  const notCollected = s.invoicedCents - s.appliedCents;
  const max = Math.max(s.expectedCents, s.invoicedCents, s.collectedCents, 1);

  const byType = Object.keys(EXCEPTION_TYPES).map(t => {
    const list = r.exceptions.filter(e => e.type === t);
    return { t, n: list.length, cents: list.reduce((a, e) => a + e.amountCents, 0), kind: EXCEPTION_TYPES[t].kind };
  }).filter(x => x.n).sort((a, b) => b.cents - a.cents);
  const maxType = Math.max(...byType.map(x => x.cents), 1);

  const h = r.paymentHygiene;
  return `
  <div class="page-head">
    <div><h1>Month end reconciliation</h1><p>${esc(range)}. Metered usage is priced at each customer's contract rate, compared with what was invoiced, then matched to cash in the bank.</p></div>
    <div class="head-actions">${asOfField()}
      <button class="btn" id="exportBtn" type="button"><svg viewBox="0 0 20 20"><path d="M10 3v10M6 9l4 4 4-4M4 16h12"/></svg>Export exceptions</button>
      <a class="btn primary" href="#exceptions"><svg viewBox="0 0 20 20"><path d="M4 10h12M11 5l5 5-5 5"/></svg>Review ${plural(s.exceptionCount, 'exception')}</a>
    </div>
  </div>

  <div class="card flow">
    <div class="flow-step">
      <div class="f-label"><b>1</b>Usage, priced at contract rates</div>
      <div class="f-value">${short(s.expectedCents)}</div>
      <div class="f-note">${r.billingRows.filter(x => x.lines.length).length} customer months metered</div>
      <div class="flow-bar"><span style="width:${(s.expectedCents / max) * 100}%"></span></div>
    </div>
    <div class="flow-step">
      <div class="f-label"><b>2</b>Invoiced</div>
      <div class="f-value">${short(s.invoicedCents)}</div>
      <div class="f-note">${r.invoices.size} invoices, duplicates excluded</div>
      <div class="flow-bar"><span style="width:${(s.invoicedCents / max) * 100}%"></span></div>
      <span class="flow-gap ${notInvoiced <= 0 ? 'ok' : ''}" data-tip="Rated usage minus invoiced. Missing invoices and under billing push this up; over billing pulls it down.">${notInvoiced > 0 ? short(notInvoiced) + ' net not invoiced' : 'Fully invoiced'}</span>
    </div>
    <div class="flow-step">
      <div class="f-label"><b>3</b>Cash applied to invoices</div>
      <div class="f-value">${short(s.appliedCents)}</div>
      <div class="f-note">${short(s.collectedCents)} received in the bank in total</div>
      <div class="flow-bar"><span style="width:${(s.appliedCents / max) * 100}%"></span></div>
      <span class="flow-gap" data-tip="Invoiced minus cash applied. Includes invoices not yet due.">${short(notCollected)} still open on invoices</span>
    </div>
  </div>

  <div class="grid kpis section">
    ${kpi('leakage', 'Revenue leakage', s.leakageCents, count('leakage'), 'Usage not billed: missing invoices, under billing, unpriced SKUs')}
    ${kpi('dispute', 'Billing disputes risk', s.disputeCents, count('dispute'), 'Over billed or duplicate invoices a customer will push back on')}
    ${kpi('unapplied', 'Unapplied cash', s.unappliedCents, count('unapplied'), 'Money in the bank not tied to any invoice')}
    ${kpiAR(s, r)}
  </div>

  <div class="grid two section">
    <div class="card">
      <div class="card-head"><h2>Exceptions by type</h2><span class="sub">Amount at stake</span></div>
      <div class="card-body">
        ${byType.length ? `<div class="hbars">${byType.map(x => `
          <div class="hbar" data-goto-type="${x.t}" data-tip="<b>${esc(EXCEPTION_TYPES[x.t].label)}</b><br>${plural(x.n, 'item')}, ${fmtUSD(x.cents)}<br>${esc(EXCEPTION_TYPES[x.t].help)}" tabindex="0" role="button">
            <span class="name">${esc(EXCEPTION_TYPES[x.t].label)}<small>${x.n}</small></span>
            <span class="hbar-track"><span style="width:${(x.cents / maxType) * 100}%;background:${KIND_COLOR[x.kind]}"></span></span>
            <span class="val">${x.cents ? short(x.cents) : 'unpriced'}</span>
          </div>`).join('')}</div>
          <div class="legend" style="margin-top:14px">
            <span><i style="background:var(--critical)"></i>Leakage</span><span><i style="background:var(--serious)"></i>Dispute</span><span><i style="background:var(--info)"></i>Refund owed</span><span><i style="background:var(--warn)"></i>Cash to chase or apply</span>
          </div>` : emptyMini('No exceptions', 'Usage, invoices and cash all agree within tolerance.')}
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Receivables ageing</h2><a class="sub" href="#ar">Open AR ${short(s.openARCents)} →</a></div>
      <div class="card-body">${ageingChart(r)}</div>
    </div>
  </div>

  <div class="card section callout">
    <div class="c-icon"><svg viewBox="0 0 20 20"><path d="M4 4h12v12H4z"/><path d="M7 8h6M7 11h4"/></svg></div>
    <div>
      <h3>Payment feed checked before matching</h3>
      <p>Rows are de-duplicated on <span class="mono">payment_id</span> only. Bank reference numbers can repeat across different payers, so using them as a key silently deletes real money. I learned this auditing a collections dataset where exactly that had happened.</p>
      <div class="facts">
        <span><b>${h.raw}</b> rows in feed</span>
        <span><b>${h.feedDuplicates.length}</b> exported twice, removed</span>
        <span><b>${h.refCollisions.length}</b> bank refs shared by different payers, kept</span>
        <span>A bank ref dedupe would have dropped <b>${h.refDedupeWouldDrop.count}</b> genuine payments worth <b>${fmtUSD(h.refDedupeWouldDrop.cents)}</b></span>
      </div>
    </div>
  </div>`;
}

function kpi(kind, label, cents, n, tip) {
  return `<button class="card kpi" type="button" data-goto-kind="${kind}" data-tip="${esc(tip)}">
    <span class="k-label"><i style="background:${KIND_COLOR[kind]}"></i>${esc(label)}</span>
    <span class="k-value">${short(cents)}</span>
    <span class="k-foot"><span>${plural(n, 'item')}</span><span>View →</span></span>
  </button>`;
}
function kpiAR(s, r) {
  const n = r.ageing.rows.filter(x => x.daysLate > 0).length;
  return `<a class="card kpi" href="#ar" data-tip="Open invoice balance past its due date on the as of date">
    <span class="k-label"><i style="background:var(--seq-4)"></i>Overdue receivables</span>
    <span class="k-value">${short(s.overdueCents)}</span>
    <span class="k-foot"><span>${plural(n, 'invoice')} past due</span><span>Ageing →</span></span>
  </a>`;
}
function emptyMini(title, text) {
  return `<div class="empty" style="padding:24px 8px"><div class="e-icon"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
}

const BUCKET_COLOR = { 'Not due': 'var(--seq-1)', '1-30': 'var(--seq-2)', '31-60': 'var(--seq-3)', '61-90': 'var(--seq-4)', '90+': 'var(--seq-5)' };
function ageingChart(r) {
  const t = r.ageing.totals;
  const total = AGE_BUCKETS.reduce((a, b) => a + t[b], 0);
  if (!total) return emptyMini('Nothing open', 'Every invoice is fully paid as of this date.');
  return `
    <div class="stack" role="img" aria-label="Open receivables by days past due">
      ${AGE_BUCKETS.filter(b => t[b]).map(b => `<span style="flex:${t[b]};background:${BUCKET_COLOR[b]}" data-tip="<b>${b === 'Not due' ? 'Not yet due' : b + ' days late'}</b><br>${fmtUSD(t[b])} (${pct(t[b] / total)})"></span>`).join('')}
    </div>
    <table><thead><tr><th style="padding-left:0">Bucket</th><th class="amt">Open</th><th class="amt">Share</th></tr></thead><tbody>
      ${AGE_BUCKETS.map(b => `<tr><td style="padding-left:0"><span class="legend"><span><i style="background:${BUCKET_COLOR[b]}"></i>${b === 'Not due' ? 'Not yet due' : b + ' days late'}</span></span></td><td class="amt">${fmtUSD(t[b])}</td><td class="amt muted">${pct(t[b] / total)}</td></tr>`).join('')}
    </tbody></table>`;
}

// ---------- exceptions ----------
function filteredExceptions(r) {
  const f = state.ex;
  const q = f.q.trim().toLowerCase();
  let list = r.exceptions.filter(e =>
    (f.side === 'all' || e.side === f.side) && (!f.kind || e.kind === f.kind) && (!f.type || e.type === f.type) && (!f.customer || e.customer_id === f.customer) &&
    (!q || [e.id, e.customer_name, e.customer_id, e.invoice_id, e.payment_id, e.sku, e.label, e.detail].join(' ').toLowerCase().includes(q)));
  const k = f.sortKey, d = f.sortDir;
  list = list.slice().sort((a, b) => (typeof a[k] === 'number' ? a[k] - b[k] : String(a[k] ?? '').localeCompare(String(b[k] ?? ''))) * d);
  return list;
}
function exceptions(r) {
  const f = state.ex;
  const list = filteredExceptions(r);
  const all = r.exceptions;
  const sideCount = s => all.filter(e => s === 'all' || e.side === s).length;
  const customers = [...new Map(all.filter(e => e.customer_id).map(e => [e.customer_id, e.customer_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const th = (key, label, cls = '') => `<th class="sortable ${cls}" data-sort="${key}">${label}${f.sortKey === key ? `<span class="arrow">${f.sortDir < 0 ? '↓' : '↑'}</span>` : ''}</th>`;
  const total = list.reduce((a, e) => a + e.amountCents, 0);
  const filtersOn = f.kind || f.type || f.customer || f.q || f.side !== 'all';
  return `
  <div class="page-head">
    <div><h1>Exceptions</h1><p>Every place where usage, invoices and cash disagree. Click a row for the evidence and the next step.</p></div>
    <div class="head-actions"><button class="btn" id="exportBtn" type="button"><svg viewBox="0 0 20 20"><path d="M10 3v10M6 9l4 4 4-4M4 16h12"/></svg>Export CSV</button></div>
  </div>
  <div class="card">
    <div class="toolbar">
      <div class="tabs" role="tablist">
        ${[['all', 'All'], ['billing', 'Billing'], ['cash', 'Cash']].map(([k, l]) => `<button class="tab ${f.side === k ? 'active' : ''}" data-side="${k}" role="tab" aria-selected="${f.side === k}">${l}<span class="c">${sideCount(k)}</span></button>`).join('')}
      </div>
      <label class="field"><select id="fType" aria-label="Exception type"><option value="">All types</option>
        ${Object.entries(EXCEPTION_TYPES).filter(([t]) => all.some(e => e.type === t)).map(([t, v]) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}
      </select></label>
      <label class="field"><select id="fCust" aria-label="Customer"><option value="">All customers</option>
        ${customers.map(([id, n]) => `<option value="${esc(id)}" ${f.customer === id ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select></label>
      ${f.kind ? `<button class="btn sm ghost" id="clearKind" type="button">${esc(f.kind)} only ✕</button>` : ''}
      <span class="spacer"></span>
      <label class="field"><svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="5.5"/><path d="M13.5 13.5L17 17"/></svg><input id="fQ" type="search" placeholder="Search invoice, payment, customer" value="${esc(f.q)}" aria-label="Search"></label>
    </div>
    ${list.length ? `
    <div class="table-wrap"><table>
      <thead><tr>${th('id', 'ID', 'hide-sm')}${th('label', 'Type')}${th('customer_name', 'Customer')}${th('period', 'Month', 'hide-sm')}<th class="hide-sm">Reference</th>${th('amountCents', 'At stake', 'amt')}</tr></thead>
      <tbody>${list.map(e => `
        <tr class="clickable" data-ex="${e.id}" tabindex="0">
          <td class="mono muted hide-sm">${e.id}</td>
          <td>${pill(e.kind, e.label)}</td>
          <td><div class="two"><span>${esc(e.customer_name || 'Unknown payer')}</span><small>${esc(e.detail)}</small></div></td>
          <td class="hide-sm nowrap">${esc(monthLabel(e.period)) || '<span class="muted">n/a</span>'}</td>
          <td class="mono hide-sm">${esc(e.invoice_id || e.payment_id || e.sku || '')}</td>
          <td class="amt">${e.amountCents ? fmtUSD(e.amountCents) : '<span class="muted">unpriced</span>'}</td>
        </tr>`).join('')}</tbody>
    </table></div>
    <div class="table-foot"><span>${plural(list.length, 'exception')}${filtersOn ? ' (filtered)' : ''}</span><span>Total at stake <b>${fmtUSD(total)}</b></span></div>`
    : `<div class="empty"><div class="e-icon"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg></div><h3>No exceptions match these filters</h3><p>Try clearing the search or picking a different type.</p><button class="btn" id="clearAll" type="button">Clear filters</button></div>`}
  </div>`;
}

function openDrawer(ex) {
  const r = state.result;
  const ev = ex.evidence ?? [];
  let evidence = '';
  if (ev.length && ev[0].sku !== undefined) {
    evidence = `<div class="d-section"><h4>Rated usage for ${esc(monthLabel(ex.period))}</h4><div class="mini table-wrap"><table>
      <thead><tr><th>SKU</th><th class="amt">Qty</th><th class="amt">Rate</th><th class="amt">Amount</th></tr></thead><tbody>
      ${ev.map(l => `<tr><td><div class="two"><span class="mono">${esc(l.sku)}</span><small>${l.source === 'contract' ? 'contract price' : l.source === 'list' ? 'list price' : 'no price'}${l.unit ? ' · per ' + esc(l.unit) : ''}</small></div></td><td class="amt">${Number(l.quantity).toLocaleString('en-US')}</td><td class="amt">${l.unit_price === null ? '—' : '$' + l.unit_price}</td><td class="amt">${fmtUSD(l.cents)}</td></tr>`).join('')}
      ${(() => { const row = r.billingRows.find(b => b.customer_id === ex.customer_id && b.period === ex.period); return row ? `<tr><td>Platform fee</td><td></td><td></td><td class="amt">${fmtUSD(row.platformFeeCents)}</td></tr><tr><td><b>Expected</b></td><td></td><td></td><td class="amt"><b>${fmtUSD(row.expectedCents)}</b></td></tr><tr><td>Invoiced</td><td></td><td></td><td class="amt">${row.invoiceIds.length ? fmtUSD(row.invoicedCents) : '—'}</td></tr>` : ''; })()}
      </tbody></table></div></div>`;
  } else if (ev.length && ev[0].method !== undefined) {
    evidence = `<div class="d-section"><h4>Payments applied to ${esc(ex.invoice_id)}</h4><div class="mini table-wrap"><table>
      <thead><tr><th>Payment</th><th>Received</th><th>Matched by</th><th class="amt">Amount</th></tr></thead><tbody>
      ${ev.map(p => `<tr><td class="mono">${esc(p.payment_id)}</td><td>${esc(p.received_date)}</td><td>${esc(p.method)}</td><td class="amt">${fmtUSD(p.cents)}</td></tr>`).join('')}
      <tr><td colspan="3">Invoice amount</td><td class="amt">${fmtUSD(r.invoices.get(ex.invoice_id)?.amountCents ?? 0)}</td></tr>
      </tbody></table></div></div>`;
  } else if (ev.length && ev[0].payment_id) {
    const p = ev[0];
    evidence = `<div class="d-section"><h4>Bank receipt</h4><dl class="kv">
      <dt>Payment ID</dt><dd class="mono">${esc(p.payment_id)}</dd><dt>Received</dt><dd>${esc(p.received_date)}</dd>
      <dt>Payer name</dt><dd>${esc(p.payer_name)}</dd><dt>Bank ref</dt><dd class="mono">${esc(p.bank_ref)}</dd>
      <dt>Remittance</dt><dd>${esc(p.remittance) || '<span class="muted">blank</span>'}</dd><dt>Amount</dt><dd>${fmtUSD(Math.round(Number(p.amount) * 100))}</dd></dl></div>`;
  }
  const open = ex.customer_id ? [...r.invoices.values()].filter(i => i.customer_id === ex.customer_id && i.amountCents > i.appliedCents) : [];
  if (ex.type === 'UNAPPLIED_CASH' && open.length) {
    evidence += `<div class="d-section"><h4>Open invoices for this customer</h4><div class="mini table-wrap"><table><thead><tr><th>Invoice</th><th>Month</th><th class="amt">Open</th></tr></thead><tbody>
      ${open.map(i => `<tr><td class="mono">${esc(i.invoice_id)}</td><td>${esc(monthLabel(i.period))}</td><td class="amt">${fmtUSD(i.amountCents - i.appliedCents)}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  $('#drawer').innerHTML = `
    <div class="d-head"><div>${pill(ex.kind, ex.label)}<h2 id="drawerTitle">${esc(ex.customer_name || 'Unknown payer')}</h2><div class="sub">${esc(ex.id)}${ex.period ? ' · ' + esc(monthLabel(ex.period)) : ''}${ex.invoice_id ? ' · ' + esc(ex.invoice_id) : ''}${ex.payment_id ? ' · ' + esc(ex.payment_id) : ''}</div></div>
      <button class="d-close" id="dClose" type="button" aria-label="Close"><svg viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15"/></svg></button></div>
    <div class="d-body">
      <div><div class="muted" style="font-size:12.5px">Amount at stake</div><div class="d-amount">${ex.amountCents ? fmtUSD(ex.amountCents) : 'Unpriced'}</div></div>
      <div class="d-section"><h4>What happened</h4><p>${esc(ex.detail)}</p></div>
      <div class="d-section"><h4>Why it matters</h4><p>${esc(EXCEPTION_TYPES[ex.type].help)}</p></div>
      <div class="d-action"><b>Suggested next step.</b> ${esc(ACTIONS[ex.type])}</div>
      ${evidence}
    </div>`;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  $('#dClose').focus();
  $('#dClose').onclick = closeDrawer;
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
}
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

// ---------- AR ----------
function ar(r) {
  const rows = r.ageing.rows.filter(x => !state.ar.bucket || x.bucket === state.ar.bucket);
  const name = id => r.customers.find(c => c.customer_id === id)?.customer_name ?? id;
  const t = r.ageing.totals;
  return `
  <div class="page-head">
    <div><h1>Receivables ageing</h1><p>Open balance on each invoice after cash is applied, bucketed by days past the due date.</p></div>
    <div class="head-actions">${asOfField()}</div>
  </div>
  <div class="card"><div class="card-body">${ageingChart(r)}</div></div>
  <div class="card section">
    <div class="toolbar">
      <div class="tabs">${['', ...AGE_BUCKETS].map(b => `<button class="tab ${state.ar.bucket === b ? 'active' : ''}" data-bucket="${b}">${b === '' ? 'All' : b === 'Not due' ? 'Not due' : b + 'd'}<span class="c">${b ? r.ageing.rows.filter(x => x.bucket === b).length : r.ageing.rows.length}</span></button>`).join('')}</div>
    </div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Customer</th><th class="hide-sm">Month</th><th class="hide-sm">Due</th><th class="amt">Days late</th><th class="amt">Open</th></tr></thead>
      <tbody>${rows.map(x => `<tr><td class="mono">${esc(x.invoice_id)}</td><td>${esc(name(x.customer_id))}</td><td class="hide-sm nowrap">${esc(monthLabel(x.period))}</td><td class="hide-sm nowrap">${esc(x.due_date)}</td>
        <td class="amt">${x.daysLate ? `<span class="pill ${x.daysLate > 30 ? 'leakage' : 'collect'}">${x.daysLate}d</span>` : '<span class="pill neutral">not due</span>'}</td><td class="amt">${fmtUSD(x.openCents)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="table-foot"><span>${plural(rows.length, 'open invoice')}</span><span>Total <b>${fmtUSD(rows.reduce((a, x) => a + x.openCents, 0))}</b></span></div>`
    : `<div class="empty"><div class="e-icon"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div><h3>Nothing in this bucket</h3><p>No open invoices are ${esc(state.ar.bucket)} days late on ${esc(state.asOf)}.</p></div>`}
  </div>`;
}

// ---------- customers ----------
function customers(r) {
  const hasCost = r.summary.costCents > 0;
  const c = state.cust;
  const rows = r.customers.map(x => ({ ...x, marginPct: x.expectedCents ? (x.expectedCents - x.costCents) / x.expectedCents : 0 }))
    .sort((a, b) => (typeof a[c.sortKey] === 'number' ? a[c.sortKey] - b[c.sortKey] : String(a[c.sortKey]).localeCompare(String(b[c.sortKey]))) * c.sortDir);
  const th = (key, label, cls = '') => `<th class="sortable ${cls}" data-csort="${key}">${label}${c.sortKey === key ? `<span class="arrow">${c.sortDir < 0 ? '↓' : '↑'}</span>` : ''}</th>`;
  const tot = r.summary;
  return `
  <div class="page-head">
    <div><h1>Customers</h1><p>Per customer view across all months: what usage was worth, what was billed, what was collected${hasCost ? ', and gross margin after serving cost' : ''}.</p></div>
  </div>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr>${th('customer_name', 'Customer')}${th('expectedCents', 'Rated usage', 'amt')}${th('invoicedCents', 'Invoiced', 'amt hide-sm')}${th('collectedCents', 'Collected', 'amt hide-sm')}${th('openCents', 'Open AR', 'amt')}${hasCost ? th('marginPct', 'Gross margin', 'amt hide-sm') : ''}${th('exceptions', 'Issues', 'amt')}</tr></thead>
    <tbody>${rows.map(x => `<tr class="clickable" data-cust="${esc(x.customer_id)}" tabindex="0">
      <td><div class="two"><span>${esc(x.customer_name)}</span><small class="mono">${esc(x.customer_id)}</small></div></td>
      <td class="amt">${fmtUSD(x.expectedCents)}</td><td class="amt hide-sm">${fmtUSD(x.invoicedCents)}</td><td class="amt hide-sm">${fmtUSD(x.collectedCents)}</td><td class="amt">${fmtUSD(x.openCents)}</td>
      ${hasCost ? `<td class="amt hide-sm"><div class="meter"><span>${pct(x.marginPct)}</span><span class="track"><span style="width:${Math.max(0, Math.min(1, x.marginPct)) * 100}%"></span></span></div></td>` : ''}
      <td class="amt">${x.exceptions ? `<span class="pill leakage">${x.exceptions}</span>` : '<span class="pill good">0</span>'}</td></tr>`).join('')}</tbody>
  </table></div>
  <div class="table-foot"><span>${plural(rows.length, 'customer')}. Click a row to see its exceptions.</span><span>${hasCost ? `Blended gross margin <b>${pct((tot.expectedCents - tot.costCents) / (tot.expectedCents || 1))}</b> on rated usage` : 'Upload costs.csv for margin'}</span></div></div>
  ${hasCost ? `<p class="muted" style="font-size:12.5px;margin-top:10px">Margin = (rated usage − serving cost) / rated usage, using the synthetic unit costs in costs.csv. It ignores idle GPU capacity and fixed costs, so treat it as a contribution margin.</p>` : ''}`;
}

// ---------- data sources ----------
function dataView(r) {
  return `
  <div class="page-head">
    <div><h1>Data sources</h1><p>Drop your own CSV exports on any card. Files are parsed in this browser tab and never uploaded. Cards you don't replace keep the synthetic sample.</p></div>
    <div class="head-actions">
      <button class="btn" id="resetBtn" type="button"><svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 106-6H6M6 1.5L3.5 4 6 6.5"/></svg>Reset to sample</button>
      <a class="btn primary" href="#overview">View results</a>
    </div>
  </div>
  <div class="errors">${(r.errors ?? []).map(esc).join('<br>')}</div>
  <div class="sources">${TABLES.map(t => {
    const s = state.tables[t];
    const sch = SCHEMAS[t];
    return `<div class="source" data-drop="${t}">
      <div class="s-top"><h3>${t}.csv</h3>${s?.source === 'user' ? '<span class="pill good">Your file</span>' : s?.rows?.length ? '<span class="pill neutral">Sample</span>' : '<span class="pill collect">Empty</span>'}</div>
      <p>${esc(TABLE_INFO[t])}</p>
      <div class="cols">${sch.required.join(', ')}${sch.optional.length ? `<span style="opacity:.7">, ${sch.optional.join(', ')} (optional)</span>` : ''}</div>
      <p class="muted">${s ? `${(s.rows?.length ?? 0).toLocaleString('en-US')} rows · ${esc(s.filename)}` : 'No file'}</p>
      <div class="s-actions">
        <label class="btn sm"><svg viewBox="0 0 20 20"><path d="M10 14V4M6 8l4-4 4 4M4 16h12"/></svg>Upload<input type="file" accept=".csv,text/csv" data-file="${t}" hidden></label>
        <a class="btn sm ghost" href="sample/${t}.csv" download>Sample</a>
      </div>
    </div>`;
  }).join('')}</div>
  <p class="muted" style="font-size:12.5px;margin-top:14px">Dates are YYYY-MM-DD, months are YYYY-MM, money is in one currency. Invoice numbers are found in remittance text if they look like <span class="mono">INV-2026-0001</span>.</p>`;
}

async function handleFile(table, file) {
  const text = await file.text();
  const rows = parseCSV(text);
  state.tables[table] = { rows, source: 'user', filename: file.name };
  run();
}

// ---------- method ----------
function method() {
  return `
  <div class="page-head"><div><h1>How it works</h1><p>The method, in the order the engine runs it, and what it does not do yet.</p></div></div>
  <div class="card"><div class="card-body prose">
    <h2>Why this exists</h2>
    <p>On a usage based inference platform, one customer's monthly bill can mix token meters for several models, per image and per audio minute meters, dedicated GPU hours, a platform fee and negotiated contract prices. Money can slip at three handoffs: usage that never reaches an invoice, invoices that don't match the contract, and cash that arrives without saying what it pays for. Finance usually catches these by hand at month end. This tool does that pass in one click and lists each gap with its evidence.</p>
    <h2>The four steps</h2>
    <ol>
      <li><b>Clean the bank feed.</b> Drop rows whose <code>payment_id</code> was exported twice. Never dedupe on <code>bank_ref</code>: different payers can share one, and deleting those rows deletes real receipts. The overview shows how much a bank ref dedupe would have wrongly removed.</li>
      <li><b>Rate the usage.</b> For every customer and month, price each SKU at the customer's contract rate if one exists, otherwise the list rate, and add the platform fee. SKUs with no price at all are flagged as unrated rather than silently billed at zero.</li>
      <li><b>Compare with invoices.</b> No invoice means a missing invoice. More than one means a duplicate. Otherwise the gap between invoice and rated usage is checked against a tolerance (the larger of $1 or 0.5%) and flagged as under or over billing.</li>
      <li><b>Apply cash.</b> First by an invoice number in the remittance text, then, for a recognised payer, by an exact match to an open invoice amount. Anything else stays as unapplied cash for a person to look at. After applying, invoices are checked for short pay, overpay and duplicate pay, and open balances are aged by days past due.</li>
    </ol>
    <h2>What I tested</h2>
    <p>The synthetic sample has known problems planted on purpose (missing and duplicate invoices, a dropped GPU line, late arriving token events, a contract price not applied, a withheld tax short pay, a double payment, unknown payers, feed duplicates and colliding bank refs). A test checks the engine finds exactly those and nothing else, plus unit tests for each rule. Run <code>npm test</code> in the repo.</p>
    <h2>Honest limits</h2>
    <ul>
      <li>Single currency. Real books would need FX at the invoice and receipt dates.</li>
      <li>Monthly postpaid only. Prepaid credit wallets, committed use drawdowns and mid month plan changes are not modelled.</li>
      <li>Cash matching is rule based. It will not split one payment across several invoices or guess at near matches; those land in unapplied cash on purpose.</li>
      <li>Usage is taken as given. If the meter itself is wrong, this can't see it.</li>
      <li>Margin uses per unit serving cost only, not idle GPU time or fixed cost.</li>
      <li>All sample data is synthetic and the prices are illustrative, not any real company's.</li>
    </ul>
  </div></div>`;
}

// ---------- export ----------
function exportCSV() {
  const rows = (location.hash.startsWith('#exceptions') ? filteredExceptions(state.result) : state.result.exceptions).map(e => ({
    id: e.id, type: e.type, label: e.label, customer_id: e.customer_id, customer_name: e.customer_name, period: e.period,
    invoice_id: e.invoice_id ?? '', payment_id: e.payment_id ?? '', sku: e.sku ?? '', amount: (e.amountCents / 100).toFixed(2), detail: e.detail, suggested_action: ACTIONS[e.type],
  }));
  const blob = new Blob([toCSV(rows, ['id', 'type', 'label', 'customer_id', 'customer_name', 'period', 'invoice_id', 'payment_id', 'sku', 'amount', 'detail', 'suggested_action'])], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `exceptions_${state.asOf}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- bindings ----------
function bind(view) {
  const r = state.result;
  $('#exportBtn')?.addEventListener('click', exportCSV);
  $('#asOf')?.addEventListener('change', e => { if (e.target.value) { state.asOf = e.target.value; run(); } });
  document.querySelectorAll('[data-goto-kind]').forEach(el => el.addEventListener('click', () => { state.ex = { ...state.ex, side: 'all', kind: el.dataset.gotoKind, type: '', customer: '', q: '' }; location.hash = 'exceptions'; }));
  document.querySelectorAll('[data-goto-type]').forEach(el => {
    const go = () => { state.ex = { ...state.ex, side: 'all', kind: '', type: el.dataset.gotoType, customer: '', q: '' }; location.hash = 'exceptions'; };
    el.addEventListener('click', go); el.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });

  if (view === 'exceptions') {
    document.querySelectorAll('[data-side]').forEach(b => b.addEventListener('click', () => { state.ex.side = b.dataset.side; render(); }));
    document.querySelectorAll('[data-sort]').forEach(th => th.addEventListener('click', () => { const k = th.dataset.sort; state.ex.sortDir = state.ex.sortKey === k ? -state.ex.sortDir : (k === 'amountCents' ? -1 : 1); state.ex.sortKey = k; render(); }));
    $('#fType')?.addEventListener('change', e => { state.ex.type = e.target.value; render(); });
    $('#fCust')?.addEventListener('change', e => { state.ex.customer = e.target.value; render(); });
    $('#clearKind')?.addEventListener('click', () => { state.ex.kind = ''; render(); });
    $('#clearAll')?.addEventListener('click', () => { state.ex = { ...state.ex, side: 'all', kind: '', type: '', customer: '', q: '' }; render(); });
    const q = $('#fQ');
    q?.addEventListener('input', e => {
      state.ex.q = e.target.value; const pos = e.target.selectionStart; render();
      const n = $('#fQ'); n.focus(); n.setSelectionRange(pos, pos);
    });
    document.querySelectorAll('[data-ex]').forEach(tr => {
      const go = () => openDrawer(r.exceptions.find(x => x.id === tr.dataset.ex));
      tr.addEventListener('click', go); tr.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  }
  if (view === 'ar') document.querySelectorAll('[data-bucket]').forEach(b => b.addEventListener('click', () => { state.ar.bucket = b.dataset.bucket; render(); }));
  if (view === 'customers') {
    document.querySelectorAll('[data-csort]').forEach(th => th.addEventListener('click', () => { const k = th.dataset.csort; state.cust.sortDir = state.cust.sortKey === k ? -state.cust.sortDir : (k === 'customer_name' ? 1 : -1); state.cust.sortKey = k; render(); }));
    document.querySelectorAll('[data-cust]').forEach(tr => {
      const go = () => { state.ex = { ...state.ex, side: 'all', kind: '', type: '', customer: tr.dataset.cust, q: '' }; location.hash = 'exceptions'; };
      tr.addEventListener('click', go); tr.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    });
  }
  if (view === 'data') {
    document.querySelectorAll('[data-file]').forEach(inp => inp.addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(inp.dataset.file, f); }));
    document.querySelectorAll('[data-drop]').forEach(card => {
      card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag'));
      card.addEventListener('drop', e => { e.preventDefault(); card.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) handleFile(card.dataset.drop, f); });
    });
    $('#resetBtn')?.addEventListener('click', () => loadSample());
  }
}

// ---------- tooltip ----------
const tip = $('#tooltip');
document.addEventListener('mousemove', e => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) { tip.hidden = true; return; }
  tip.innerHTML = el.dataset.tip;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
});
document.addEventListener('scroll', () => { tip.hidden = true; }, true);

// ---------- theme ----------
$('#themeBtn').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  lsSet('u2c-theme', root.dataset.theme);
});
void lsGet;

render();
loadSample().catch(err => { $('#view').innerHTML = `<div class="card empty"><h3>Could not load the sample data</h3><p>${esc(err.message)}. Open the Data sources page to upload your own CSVs.</p><a class="btn" href="#data">Data sources</a></div>`; });
