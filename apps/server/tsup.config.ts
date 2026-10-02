import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Workspace packages are TypeScript sources: bundle them into the server build.
  noExternal: [/^@qs\//],
});
