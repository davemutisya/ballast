// Extract the workflow return value from the task-output envelope and materialise
// it into the repo (catalog JSON + strategy/architecture docs), printing only a
// compact summary so we never load 360K chars into the main context.

import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
const root = path.resolve(process.argv[3] ?? '.');
const raw = fs.readFileSync(src, 'utf8');
const env = JSON.parse(raw);

// Find the object that carries our return shape ({catalog, gtm, arch}).
function findReturn(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const x of node) { const r = findReturn(x, depth + 1); if (r) return r; }
    return null;
  }
  if ('catalog' in node && ('gtm' in node || 'arch' in node)) return node;
  // common wrapper: JSON string in a text/content/result field
  for (const k of ['result', 'output', 'return', 'value', 'content', 'text']) {
    if (typeof node[k] === 'string' && node[k].includes('"catalog"')) {
      try { const parsed = JSON.parse(node[k]); const r = findReturn(parsed, depth + 1); if (r) return r; } catch {}
    }
  }
  for (const v of Object.values(node)) { const r = findReturn(v, depth + 1); if (r) return r; }
  return null;
}

const ret = findReturn(env);
if (!ret) {
  console.error('Could not locate return value. Top-level keys:', Object.keys(env));
  // Dump one level of structure to help.
  for (const [k, v] of Object.entries(env)) {
    console.error(`  ${k}: ${Array.isArray(v) ? `array[${v.length}]` : typeof v}`);
  }
  process.exit(1);
}

const write = (rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return `${rel} (${content.length.toLocaleString()} chars)`;
};

// ── Catalog ─────────────────────────────────────────────────────────────────
const families = ret.catalog ?? [];
const pgEntries = [];
console.log('\n══ Postgres catalog (author → adversarial verify) ══');
for (const f of families) {
  const entries = f.entry?.entries ?? [];
  const v = f.verdict ?? {};
  for (const e of entries) pgEntries.push({ ...e, _verdict: v.verdict, _confidence: v.confidence });
  const corr = (v.corrections ?? []).length;
  console.log(
    `  ${(f.entry?.operationFamily ?? f.family ?? '?').slice(0, 52).padEnd(52)} ` +
    `${String(entries.length).padStart(2)} entries  ${(v.verdict ?? '?').padEnd(9)} ${(v.confidence ?? '?').padEnd(6)} ` +
    `${corr ? `${corr} corrections` : 'clean'}`,
  );
}
const written = [];
written.push(write('src/catalog/postgres.generated.json', JSON.stringify(pgEntries, null, 2)));
written.push(write('docs/catalog/verification.json', JSON.stringify(
  families.map((f) => ({ family: f.entry?.operationFamily ?? f.family, verdict: f.verdict })), null, 2)));

// ── Breadth (MySQL / SQL Server) ────────────────────────────────────────────
if (ret.mysql) written.push(write('docs/catalog/mysql.json', JSON.stringify(ret.mysql, null, 2)));
if (ret.sqlserver) written.push(write('docs/catalog/sqlserver.json', JSON.stringify(ret.sqlserver, null, 2)));

// ── Strategy / architecture (text) ──────────────────────────────────────────
if (ret.gtm) written.push(write('docs/strategy/GTM.md', String(ret.gtm)));
if (ret.arch) written.push(write('docs/architecture/DESIGN.md', String(ret.arch)));

console.log('\n══ Materialised ══');
for (const w of written) console.log('  ' + w);
console.log(`\nPostgres: ${pgEntries.length} verified catalog entries across ${families.length} families.`);
console.log(`Corrections flagged in: ${families.filter((f) => (f.verdict?.corrections ?? []).length).length} families.`);
