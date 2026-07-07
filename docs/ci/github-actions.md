# Ballast in CI (the migration-safety gate)

Drop this into `.github/workflows/migration-safety.yml` in your repo. It fails the
PR when a migration is dangerous, so a bad schema change can't merge.

## Structural (no database) — zero setup

```yaml
name: migration-safety
on:
  pull_request:
    paths: ['**/*.sql', 'migrations/**', 'db/migrate/**']
jobs:
  ballast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx ballast-pg check migrations/ --fail-on danger
```

## Load-aware (recommended) — point it at a replica

Give CI a **read-only** connection to a replica or staging DB and Ballast weights
every finding by real table size + live transaction state — killing false positives
on small tables and quantifying the real ones. Store the DSN as a repo secret
(`BALLAST_DSN`); Ballast never needs write or DDL privileges and never reads your
data.

```yaml
      - run: npx ballast-pg check migrations/ --dsn "${{ secrets.BALLAST_DSN }}" --fail-on danger
```

## Options
- `--fail-on danger|critical` — the severity that fails the build (default `danger`).
- `--explain` — print the verified catalog detail (why it's unsafe, edge cases).
- `--json` — machine-readable output.
- `--table <name>` — override the table to snapshot (multi-table migrations).

## In your coding agent (Cursor / Claude Code)
Add the MCP server so the agent checks a migration *before* proposing it:
```json
{ "mcpServers": { "ballast": { "command": "npx", "args": ["ballast-mcp"] } } }
```
