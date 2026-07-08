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

## PR comment + gate (recommended — the one people actually feel)

Beyond a pass/fail check, post a blast-radius **comment on the PR** (updated in place
on each push) so the danger is visible where the review happens — and still gate the
merge. Copy [`ballast-pr-comment.yml`](ballast-pr-comment.yml) to
`.github/workflows/ballast.yml`. It uses `--format md` to build the comment and needs
`pull-requests: write` permission (already set in the template). No third-party action —
just `actions/github-script`.

## Options
- `--fail-on danger|critical` — the severity that fails the build (default `danger`).
- `--format text|json|md` — human output, machine-readable, or a PR-comment-shaped
  Markdown report (`md`).
- `--explain` — print the verified catalog detail (why it's unsafe, edge cases).
- `--table <name>` — override the table to snapshot (multi-table migrations).

## In your coding agent (Cursor / Claude Code)
Add the MCP server so the agent checks a migration *before* proposing it:
```json
{ "mcpServers": { "ballast": { "command": "npx", "args": ["ballast-mcp"] } } }
```
