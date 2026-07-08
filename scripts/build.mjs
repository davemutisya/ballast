// Bundle the CLI + MCP server to plain ESM JS in dist/ so `npx ballast` works
// without tsx/source. Runtime deps stay external (installed from package deps);
// the correctness catalog JSON is inlined into the bundle.
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/cli/index.ts', 'src/mcp.ts'],
  outbase: 'src',
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['pg', '@modelcontextprotocol/sdk', 'zod', 'libpg-query'],
  loader: { '.json': 'json' },
  banner: { js: '// Ballast — generated bundle. Edit src/, run `npm run build`.' },
});
console.log('built dist/cli/index.js, dist/mcp.js');
