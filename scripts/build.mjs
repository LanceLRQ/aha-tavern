// 把 src/ 打成 dist/index.js 单文件。
// @deepseek-ai/* 保持 external：运行时由宿主提供，避免出现两套框架实例。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['@deepseek-ai/*'],
  // yaml 等 CJS 依赖打进 ESM 产物后需要 require，补一个
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})
