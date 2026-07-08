// libpg-query ships no TypeScript types. We type the surface we use; parse-tree
// nodes are structurally-typed `any` and every access is defensive in parse.ts.
declare module 'libpg-query' {
  export interface ParseResult { version: number; stmts: RawStmt[] }
  export interface RawStmt { stmt: Record<string, any>; stmt_location?: number; stmt_len?: number }
  export function loadModule(): Promise<unknown>;
  export function parse(sql: string): Promise<ParseResult>;
  export function parseSync(sql: string): ParseResult;
  export class SqlError extends Error {}
}
