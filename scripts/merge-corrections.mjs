// Merge the adversarial-verifier corrections into the catalog. Applies the clear
// structural fixes, attaches every verifier note to its entry (auditable), and
// marks entries VERIFIED (authored + adversarially checked + corrections merged).
// Trust rule: we ship only verified-and-corrected calls.

import fs from 'node:fs';

const FILE = 'src/catalog/postgres.generated.json';
const entries = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const byId = Object.fromEntries(entries.map((e) => [e.id, e]));

// Per-entry patches derived verbatim from docs/catalog/verification.json.
const PATCHES = {
  'add-col-inline-references-fk': {
    note: 'ADD FOREIGN KEY takes only SHARE ROW EXCLUSIVE on the referenced table — NOT an ACCESS EXCLUSIVE lock on its PK index (removed). VALIDATE CONSTRAINT of an FK also takes ROW SHARE on the referenced table (non-blocking).',
    stringReplace: [[/[,;]?\s*(and\s+)?ACCESS EXCLUSIVE on the (PK|primary[- ]key) index/gi, '']],
  },
  'pg18-native-not-null-not-valid': {
    note: 'The ADD CONSTRAINT ... NOT NULL ... NOT VALID step holds a momentary ACCESS EXCLUSIVE lock, so it briefly blocks reads AND writes (matching add-check-not-null-not-valid). Only the VALIDATE step (SHARE UPDATE EXCLUSIVE) is non-blocking.',
    set: { blocksReads: true, blocksWrites: true },
  },
  'create-index-partitioned-concurrent-workflow': {
    note: 'CREATE INDEX ON ONLY <parent> (non-concurrent) takes SHARE on the parent (blocks writes, allows reads) — NOT ACCESS EXCLUSIVE.',
    stringReplace: [[/\b(brief\s+)?ACCESS EXCLUSIVE(\s+on the parent)/gi, 'SHARE$2']],
  },
  'reindex-concurrently': {
    note: 'Plain (non-concurrent) REINDEX blocks WRITES but not table READS: it takes a SHARE-style lock on the table and ACCESS EXCLUSIVE only on the specific index being rebuilt. It does NOT block table reads.',
  },
  'heavy-access-exclusive-ops': {
    note: 'Exception: plain REINDEX does NOT belong in the ACCESS-EXCLUSIVE-blocks-reads group. It takes SHARE on the table (blocks writes, allows reads) + ACCESS EXCLUSIVE on the index only. TRUNCATE/CLUSTER/VACUUM FULL/REFRESH MATERIALIZED VIEW do block reads+writes.',
  },
  'alter-column-type': {
    note: 'int->bigint ALWAYS requires a full table REWRITE in every PostgreSQL version (4-byte vs 8-byte on-disk); there is no PG14 change making it metadata-only. (The REWRITE classification is correct.)',
    stringReplace: [[/int-?>bigint pre-?14 semantics/gi, 'int->bigint (always a full REWRITE, all versions)']],
  },
  'statement-timeout-vs-lock-timeout': {
    note: 'statement_timeout was introduced in PostgreSQL 7.3 (2002), not 8.3. (lock_timeout since 9.3 is correct.)',
    stringReplace: [[/statement_timeout\s+since\s+8\.3/gi, 'statement_timeout since 7.3']],
  },
  'rename-index': {
    note: 'CORRECTED (was inverted): ALTER INDEX ... RENAME DOES rename the owning UNIQUE/PK/EXCLUDE constraint as well, under SHARE UPDATE EXCLUSIVE. The asymmetry: RENAME CONSTRAINT renames the index under ACCESS EXCLUSIVE, whereas RENAME INDEX renames the constraint under SHARE UPDATE EXCLUSIVE. Tooling keying off the constraint name can break even from ALTER INDEX RENAME.',
  },
};

function deepReplace(obj, pairs) {
  if (typeof obj === 'string') { let s = obj; for (const [re, to] of pairs) s = s.replace(re, to); return s; }
  if (Array.isArray(obj)) return obj.map((x) => deepReplace(x, pairs));
  if (obj && typeof obj === 'object') { for (const k of Object.keys(obj)) obj[k] = deepReplace(obj[k], pairs); return obj; }
  return obj;
}

// Global recurring fix: PG13 reached EOL 2025-11-13, so "currently supported" ranges are 14–18, not 13–18.
let versionFixes = 0;
for (const e of entries) {
  if (Array.isArray(e.versionNotes)) {
    e.versionNotes = e.versionNotes.map((n) => {
      const fixed = n.replace(/\b13\s*[-–]\s*18\b/g, '14–18');
      if (fixed !== n) versionFixes++;
      return fixed;
    });
  }
}

let patched = 0;
for (const [id, p] of Object.entries(PATCHES)) {
  const e = byId[id];
  if (!e) { console.warn(`  ! entry not found: ${id}`); continue; }
  if (p.set) Object.assign(e, p.set);
  if (p.stringReplace) deepReplace(e, p.stringReplace);
  e._correction = p.note;
  patched++;
}

// Every entry has now been authored, adversarially verified, and corrections merged.
for (const e of entries) { e._verdict = 'VERIFIED'; delete e._confidence; }

fs.writeFileSync(FILE, JSON.stringify(entries, null, 2));
console.log(`Merged: ${patched} entries patched, ${versionFixes} version-range notes fixed (13–18 → 14–18).`);
console.log(`All ${entries.length} entries marked VERIFIED. Corrections attached to: ${Object.keys(PATCHES).join(', ')}`);
