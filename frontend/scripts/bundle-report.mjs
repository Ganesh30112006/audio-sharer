// Reports gzip sizes of the production build and enforces the initial-shell budget.
// "Initial" = the entry script plus everything index.html preloads; route chunks
// and the LiveKit SDK load later and are reported separately.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = Number(process.env.INITIAL_JS_BUDGET_KB ?? 250);
const dist = new URL('../dist/', import.meta.url).pathname;
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const initial = new Set(
  [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]),
);

const rows = readdirSync(join(dist, 'assets'))
  .filter((f) => /\.(js|css)$/.test(f))
  .map((f) => {
    const buf = readFileSync(join(dist, 'assets', f));
    return { file: `assets/${f}`, raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
  })
  .sort((a, b) => b.gzip - a.gzip);

const kb = (n) => (n / 1024).toFixed(1).padStart(7);
let initialJs = 0;
console.log('  gzip KB    raw KB  load     file');
for (const r of rows) {
  const isInitial = initial.has(r.file);
  if (isInitial && r.file.endsWith('.js')) initialJs += r.gzip;
  console.log(`${kb(r.gzip)}  ${kb(r.raw)}  ${isInitial ? 'initial' : 'lazy   '}  ${r.file}`);
}
console.log(`\nInitial JS (gzip): ${(initialJs / 1024).toFixed(1)} KB — budget ${BUDGET_KB} KB`);
if (initialJs / 1024 > BUDGET_KB) {
  console.error('Initial JS budget exceeded');
  process.exit(1);
}
