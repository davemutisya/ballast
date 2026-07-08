# Ballast in your agent loop (MCP)

Ballast's wedge is being *inside* the coding agent while it writes a migration, so the
agent gets a load-aware verdict and rewrites the unsafe statement before you ever see
the diff. That happens over [MCP](https://modelcontextprotocol.io). This is the setup.

## What it exposes

One tool: **`analyze_migration`**. The agent calls it before proposing any DDL and gets
back the lock mode, predicted hold time under real load, blocked-query estimate,
lock-queue-pileup risk, and a verified safe rewrite.

Arguments:
- `sql` (required) — the migration SQL.
- `dsn` (optional) — a **read-only** Postgres connection string. Ballast snapshots live
  table size + running transactions per statement. It needs only `SELECT` on
  `pg_catalog` / `pg_stat_*` — no table data, no writes, no DDL.
- `stats` (optional) — explicit `{rows, bytes?, writeTps?, longestRunningTxnSec?}` when
  you can't or won't hand it a DSN.
- `table` (optional) — override the table to snapshot.

Without `dsn` or `stats` it still runs a structural analysis (Squawk-superset). With
them it's load-aware. (Note the authoring-vs-deploy-time caveat in
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md#1-authoring-time-vs-deploy-time--the-temporal-gap).)

## Install

```bash
npm install -g ballast-pg     # provides `ballast` and `ballast-mcp`
```

### Claude Code
```bash
claude mcp add ballast -- ballast-mcp
```
Or add to `~/.claude.json` (or a project `.mcp.json`):
```json
{ "mcpServers": { "ballast": { "command": "ballast-mcp" } } }
```

### Cursor
`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):
```json
{ "mcpServers": { "ballast": { "command": "ballast-mcp" } } }
```
Then: Settings → MCP → confirm `ballast` is green.

### VS Code (Copilot / MCP-capable extensions)
`.vscode/mcp.json`:
```json
{ "servers": { "ballast": { "command": "ballast-mcp" } } }
```

### Passing a read-only DSN
Don't hard-code credentials in the MCP config. Prefer having the agent pass `dsn` per
call from an env var, or run against a read-replica. A least-privilege role:
```sql
CREATE ROLE ballast_ro LOGIN PASSWORD '...';
GRANT pg_monitor TO ballast_ro;      -- read pg_stat_* for the lock-queue signal
-- plus USAGE/SELECT on the schemas whose tables you migrate
```

## Nudge the agent to actually use it

Add to your project rules (`CLAUDE.md`, `.cursorrules`, etc.):

> Before proposing any database migration or DDL, call the `analyze_migration` MCP tool.
> If the verdict is danger or critical, apply the safe rewrite it returns before showing
> me the change.

## Sanity check

```bash
npm run mcp-smoke      # from the repo: calls the server over the real protocol
```
Or point your agent at a throwaway `CREATE INDEX ON big_table (col);` and confirm it
comes back with a non-concurrent-index warning + the `CONCURRENTLY` rewrite.
