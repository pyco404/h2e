import * as esbuild from 'esbuild'
const dev = process.argv.includes('--serve')
const ctx = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/bundle.js',
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"', 'process.env.ANCHOR_BROWSER': 'true' },
  inject: ['src/shim-node.ts'],
  loader: { '.json': 'json' },
  sourcemap: true,
  logLevel: 'info',
}
if (dev) {
  const context = await esbuild.context(ctx)
  await context.watch()
  const { host, port } = await context.serve({ servedir: '.', port: 5178 })
  console.log(`app on http://localhost:${port}`)
} else {
  await esbuild.build(ctx)
  console.log('built dist/bundle.js')
}
