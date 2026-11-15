// Writes the synthetic sample CSVs to /sample. Run: node scripts/generate-sample.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { generate } from '../src/generate.js';
import { toCSV } from '../src/csv.js';

const out = new URL('../sample/', import.meta.url);
mkdirSync(out, { recursive: true });
const d = generate(42);
for (const t of ['customers', 'rates', 'usage', 'invoices', 'payments', 'costs']) {
  writeFileSync(new URL(`${t}.csv`, out), toCSV(d[t]));
  console.log(t.padEnd(10), d[t].length, 'rows');
}
writeFileSync(new URL('planted_issues.json', out), JSON.stringify({ note: 'Synthetic data. These problems were planted on purpose.', asOf: d.meta.asOf, planted: d.planted, feedDuplicateIds: d.meta.feedDuplicateIds, collidingPairs: d.meta.collidingPairs }, null, 2));
console.log('planted   ', d.planted.length, 'issues');
