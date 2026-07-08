// Statement classifier built on libpg_query — PostgreSQL's OWN parser (v17
// grammar) compiled to WASM. No regex recognition: dollar-quoted bodies, comments,
// multi-command ALTERs, and schema-qualified names are handled by the real
// grammar. Every statement lands in exactly one bucket:
//   • a risky-DDL kind the catalog binds to (findings),
//   • CREATE_TABLE / CREATE_MATVIEW (benign, feeds the same-file exemption),
//   • BENIGN (recognized, no lock risk to analyze), or
//   • UNANALYZED (we could not classify it — callers MUST surface these).
// Nothing is ever dropped silently: that's the contract.

import { loadModule, parseSync } from 'libpg-query';
import type { Statement } from './types.ts';

let ready: Promise<unknown> | undefined;

export async function parse(sql: string): Promise<Statement[]> {
  await (ready ??= loadModule());
  let stmts;
  try {
    stmts = parseSync(sql).stmts ?? [];
  } catch (e) {
    return [un(sql.trim().slice(0, 200), `SQL did not parse: ${(e as Error).message}`)];
  }
  // stmt_location/stmt_len are BYTE offsets; JS string indices are UTF-16 code
  // units. Slice on a byte buffer or any non-ASCII character in a comment shifts
  // every later raw slice (and raw drives e.g. NOT VALID catalog binding).
  const buf = Buffer.from(sql, 'utf8');
  const out: Statement[] = [];
  for (const rs of stmts) {
    const loc = rs.stmt_location ?? 0;
    const raw = (rs.stmt_len ? buf.subarray(loc, loc + rs.stmt_len) : buf.subarray(loc)).toString('utf8').trim();
    out.push(...classify(rs.stmt ?? {}, raw));
  }
  return out;
}

/** Statements that produce findings (everything except the bookkeeping buckets). */
export function isAnalyzable(s: Statement): boolean {
  return s.kind !== 'BENIGN' && s.kind !== 'UNANALYZED' && s.kind !== 'CREATE_TABLE' && s.kind !== 'CREATE_MATVIEW';
}

// ── node classification ───────────────────────────────────────────────────────

function classify(node: Record<string, any>, raw: string): Statement[] {
  const type = Object.keys(node)[0];
  const n = type ? node[type] : undefined;
  switch (type) {
    case 'IndexStmt':
      return [st(raw, 'CREATE_INDEX', rangeVar(n.relation), !!n.concurrent)];
    case 'AlterTableStmt':
      return alterTable(n, raw);
    case 'RenameStmt':
      return [renameStmt(n, raw)];
    case 'DropStmt':
      return dropStmt(n, raw);
    case 'TruncateStmt':
      return (n.relations ?? []).map((r: any) => st(raw, 'TRUNCATE', rangeVar(r.RangeVar ?? r), false));
    case 'VacuumStmt': {
      const full = (n.options ?? []).some((o: any) => o.DefElem?.defname === 'full');
      if (!full) return [benign(raw)];
      const rel = n.rels?.[0]?.VacuumRelation?.relation;
      return [st(raw, 'VACUUM_FULL', rangeVar(rel), false)];
    }
    case 'ClusterStmt':
      return [st(raw, 'CLUSTER', rangeVar(n.relation), false)];
    case 'ReindexStmt': {
      const conc = !!n.params?.some((o: any) => o.DefElem?.defname === 'concurrently');
      return [st(raw, 'REINDEX', rangeVar(n.relation), conc)];
    }
    case 'RefreshMatViewStmt':
      return [st(raw, 'REFRESH_MATVIEW', rangeVar(n.relation), !!n.concurrent)];
    case 'CreateStmt': // feeds the same-file new-relation exemption
      return [st(raw, 'CREATE_TABLE', rangeVar(n.relation), false)];
    case 'CreateTableAsStmt': {
      const kind = n.objtype === 'OBJECT_MATVIEW' ? 'CREATE_MATVIEW' : 'CREATE_TABLE';
      return [st(raw, kind, rangeVar(n.into?.rel), false)];
    }
    default:
      if (type && BENIGN_NODES.has(type)) return [benign(raw)];
      return [un(raw, `unmapped statement type ${type ?? '(empty)'}`)];
  }
}

function alterTable(n: any, raw: string): Statement[] {
  // ALTER INDEX/VIEW/SEQUENCE ... SET options etc. — no table-lock risk we model.
  if (n.objtype && n.objtype !== 'OBJECT_TABLE' && n.objtype !== 'OBJECT_MATVIEW') return [benign(raw)];
  const table = rangeVar(n.relation);
  const out: Statement[] = [];
  for (const c of n.cmds ?? []) {
    const cmd = c.AlterTableCmd ?? {};
    out.push(alterCmd(cmd, table, raw));
  }
  return out.length ? out : [benign(raw)];
}

function alterCmd(cmd: any, table: string | null, raw: string): Statement {
  const k = (kind: string) => st(raw, kind, table, false);
  switch (cmd.subtype) {
    case 'AT_AddColumn': return k(addColumnKind(cmd.def?.ColumnDef));
    case 'AT_DropColumn': return k('DROP_COLUMN');
    case 'AT_ColumnDefault': return k(cmd.def ? 'SET_DEFAULT' : 'DROP_DEFAULT');
    case 'AT_SetNotNull': return k('SET_NOT_NULL');
    case 'AT_DropNotNull': return k('DROP_NOT_NULL');
    case 'AT_AlterColumnType': return k('ALTER_TYPE');
    case 'AT_AddConstraint': return k(constraintKind(cmd.def?.Constraint));
    case 'AT_ValidateConstraint': return k('VALIDATE_CONSTRAINT');
    case 'AT_DropConstraint': return k('DROP_CONSTRAINT');
    case 'AT_SetLogged': return k('SET_LOGGED');
    case 'AT_SetUnLogged': return k('SET_UNLOGGED');
    case 'AT_AttachPartition': return k('ATTACH_PARTITION');
    case 'AT_DetachPartition': return k('DETACH_PARTITION');
    default:
      // Storage/statistics/trigger-enable/owner/etc: metadata-only table lock,
      // no scan/rewrite. Modeled by the lockModel default (brief ACCESS EXCLUSIVE).
      if (cmd.subtype && METADATA_ALTER.has(cmd.subtype)) return k('ALTER_TABLE_MISC');
      return un(raw, `unmapped ALTER TABLE subtype ${cmd.subtype ?? '(none)'}`);
  }
}

function constraintKind(con: any): string {
  switch (con?.contype) {
    case 'CONSTR_FOREIGN': return 'ADD_FOREIGN_KEY';
    case 'CONSTR_PRIMARY': return 'ADD_PRIMARY_KEY';
    case 'CONSTR_UNIQUE': return 'ADD_UNIQUE';
    case 'CONSTR_EXCLUSION': return 'ADD_UNIQUE'; // builds an index under the same locks
    case 'CONSTR_CHECK': return 'ADD_CHECK';
    default: return 'ADD_CHECK'; // conservative: constraint we don't know = assume verifying scan
  }
}

// ── ADD COLUMN volatility (the fast-default rule, PG 11+) ────────────────────
// Postgres rewrites the whole table ONLY if the default expression contains a
// VOLATILE function (contain_volatile_functions). now()/CURRENT_TIMESTAMP and
// friends are STABLE — evaluated once at ALTER time, stored as attmissingval, no
// rewrite (verified: 0.9ms on 2M rows, vs 1249ms for gen_random_uuid()). Unknown
// functions are treated as volatile: user-defined functions can be volatile and
// we never under-warn.

const STABLE_BUILTINS = new Set([
  'now', 'transaction_timestamp', 'statement_timestamp', 'current_timestamp',
  'current_date', 'current_time', 'localtimestamp', 'localtime', 'timezone',
]);

function addColumnKind(cd: any): string {
  if (!cd) return 'ADD_COLUMN';
  const typeName = (cd.typeName?.names ?? []).map((s: any) => s.String?.sval).filter(Boolean).pop() ?? '';
  if (/^(small|big)?serial[248]?$/.test(typeName)) return 'ADD_COLUMN_DEFAULT_VOLATILE'; // serial = nextval()
  for (const c of cd.constraints ?? []) {
    const con = c.Constraint ?? {};
    // Identity and stored-generated columns need a distinct/computed value per
    // existing row — same full-rewrite consequence as a volatile default.
    if (con.contype === 'CONSTR_IDENTITY' || con.contype === 'CONSTR_GENERATED') return 'ADD_COLUMN_DEFAULT_VOLATILE';
    if (con.contype === 'CONSTR_DEFAULT') {
      return exprIsVolatile(con.raw_expr) ? 'ADD_COLUMN_DEFAULT_VOLATILE' : 'ADD_COLUMN_DEFAULT_CONST';
    }
  }
  return 'ADD_COLUMN';
}

function exprIsVolatile(expr: any): boolean {
  if (expr == null || typeof expr !== 'object') return false;
  if (Array.isArray(expr)) return expr.some(exprIsVolatile);
  for (const [key, val] of Object.entries(expr)) {
    if (key === 'FuncCall') {
      const name = ((val as any).funcname ?? []).map((s: any) => s.String?.sval).filter(Boolean).pop() ?? '';
      if (!STABLE_BUILTINS.has(name.toLowerCase())) return true; // unknown → volatile (never under-warn)
      if (exprIsVolatile((val as any).args)) return true;
      continue;
    }
    if (key === 'SQLValueFunction') continue; // CURRENT_TIMESTAMP-family keyword form: stable
    if (exprIsVolatile(val)) return true;
  }
  return false;
}

// ── remaining node helpers ────────────────────────────────────────────────────

function renameStmt(n: any, raw: string): Statement {
  const table = rangeVar(n.relation);
  switch (n.renameType) {
    case 'OBJECT_TABLE': return st(raw, 'RENAME_TABLE', table, false);
    case 'OBJECT_COLUMN': return st(raw, 'RENAME_COLUMN', table, false);
    case 'OBJECT_TABCONSTRAINT': return st(raw, 'RENAME_CONSTRAINT', table, false);
    case 'OBJECT_INDEX': return st(raw, 'RENAME_INDEX', table, false);
    default: return benign(raw); // renames of views/schemas/types etc: no table-lock model
  }
}

function dropStmt(n: any, raw: string): Statement[] {
  const names = (n.objects ?? []).map((o: any) =>
    (o.List?.items ?? [o]).map((i: any) => i.String?.sval).filter(Boolean).join('.') || null);
  switch (n.removeType) {
    case 'OBJECT_TABLE':
    case 'OBJECT_MATVIEW': // destructive the same way
      return names.map((t: string | null) => st(raw, 'DROP_TABLE', t, false));
    case 'OBJECT_INDEX':
      return names.map((t: string | null) => st(raw, 'DROP_INDEX', t, !!n.concurrent));
    default:
      return [benign(raw)]; // views, functions, triggers, policies, types, sequences…
  }
}

function rangeVar(rv: any): string | null {
  if (!rv?.relname) return null;
  return rv.schemaname ? `${rv.schemaname}.${rv.relname}` : rv.relname;
}

function st(raw: string, kind: string, table: string | null, concurrent: boolean): Statement {
  return { raw, kind, table, concurrent };
}
function benign(raw: string): Statement {
  return { raw, kind: 'BENIGN', table: null, concurrent: false };
}
function un(raw: string, detail: string): Statement {
  return { raw, kind: 'UNANALYZED', table: null, concurrent: false, detail };
}

// Recognized statement types with no table-lock risk to model. DML (INSERT/
// UPDATE/DELETE backfills) is out of scope for the LOCK model — batching advice
// belongs to rewrites, not findings.
const BENIGN_NODES = new Set([
  'SelectStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt', 'CopyStmt',
  'DoStmt', 'CallStmt', 'ExplainStmt', 'VariableSetStmt', 'VariableShowStmt',
  'TransactionStmt', 'LockStmt', 'NotifyStmt', 'ListenStmt', 'UnlistenStmt',
  'ViewStmt', 'CreateFunctionStmt', 'AlterFunctionStmt', 'CreateTrigStmt',
  'CreatePolicyStmt', 'AlterPolicyStmt', 'CreateSeqStmt', 'AlterSeqStmt',
  'CreateSchemaStmt', 'CreateExtensionStmt', 'AlterExtensionStmt',
  'CreateEnumStmt', 'AlterEnumStmt', 'CreateDomainStmt', 'AlterDomainStmt',
  'CompositeTypeStmt', 'CreateRangeStmt', 'DefineStmt', 'CreateCastStmt',
  'CreateStatsStmt', 'CommentStmt', 'SecLabelStmt', 'RuleStmt',
  'GrantStmt', 'GrantRoleStmt', 'AlterDefaultPrivilegesStmt',
  'CreateRoleStmt', 'AlterRoleStmt', 'AlterRoleSetStmt', 'DropRoleStmt',
  'AlterOwnerStmt', 'AlterObjectSchemaStmt', 'AlterSystemStmt',
  'ReassignOwnedStmt', 'DropOwnedStmt', 'PrepareStmt', 'ExecuteStmt', 'DeallocateStmt',
  'DeclareCursorStmt', 'FetchStmt', 'ClosePortalStmt', 'CheckPointStmt', 'DiscardStmt',
  // Logical replication management (Supabase realtime uses publications heavily).
  'CreatePublicationStmt', 'AlterPublicationStmt',
  'CreateSubscriptionStmt', 'AlterSubscriptionStmt', 'DropSubscriptionStmt',
]);

// ALTER TABLE subtypes that are metadata-only bookkeeping (brief lock, no scan).
const METADATA_ALTER = new Set([
  'AT_SetStatistics', 'AT_SetOptions', 'AT_ResetOptions', 'AT_SetStorage',
  'AT_SetCompression', 'AT_ChangeOwner', 'AT_ClusterOn', 'AT_DropCluster',
  'AT_SetRelOptions', 'AT_ResetRelOptions', 'AT_ReplaceRelOptions',
  'AT_EnableTrig', 'AT_EnableAlwaysTrig', 'AT_EnableReplicaTrig', 'AT_DisableTrig',
  'AT_EnableTrigAll', 'AT_DisableTrigAll', 'AT_EnableTrigUser', 'AT_DisableTrigUser',
  'AT_EnableRule', 'AT_EnableAlwaysRule', 'AT_EnableReplicaRule', 'AT_DisableRule',
  'AT_EnableRowSecurity', 'AT_DisableRowSecurity', 'AT_ForceRowSecurity', 'AT_NoForceRowSecurity',
  'AT_SetIdentity', 'AT_AddIdentity', 'AT_DropIdentity', 'AT_DropExpression',
  'AT_AddInherit', 'AT_DropInherit', 'AT_ReplicaIdentity', 'AT_SetAccessMethod',
  'AT_CheckNotNull', 'AT_SetExpression', 'AT_ReAddStatistics',
]);
