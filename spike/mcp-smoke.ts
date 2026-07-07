// Smoke test: spawn the Ballast MCP server and call analyze_migration over the
// real MCP protocol, exactly as Cursor / Claude Code would.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/mcp.ts'],
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '), '\n');

async function call(label: string, args: Record<string, unknown>) {
  const res: any = await client.callTool({ name: 'analyze_migration', arguments: args });
  console.log(`── ${label} ──`);
  console.log(res.content.map((c: any) => c.text).join('\n'));
  console.log();
}

// 1. Load-aware: big table, live traffic → should be danger + rewrite.
await call('CREATE INDEX on 5M-row table under load', {
  sql: 'CREATE INDEX idx_users_email ON users (email)',
  stats: { rows: 5_000_000, writeTps: 800, readTps: 4000 },
});

// 2. The queue amplifier: a "fast" drop column, but a long query is running.
await call('DROP COLUMN with a 45s query running (queue pileup)', {
  sql: 'ALTER TABLE orders DROP COLUMN legacy_note',
  stats: { rows: 2_000_000, writeTps: 1200, readTps: 6000, longestRunningTxnSec: 45 },
});

// 3. No stats → structural (linter-equivalent) fallback.
await call('SET NOT NULL, no stats', {
  sql: 'ALTER TABLE accounts ALTER COLUMN status SET NOT NULL',
});

await client.close();
process.exit(0);
