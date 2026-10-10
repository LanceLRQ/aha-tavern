// 打包：
//   dist/index.js        插件本体（src/index.ts），提示词 .md 内联
//   dist/typert.host.js  设置页的远程调用描述（包的 ./typert 导出）
//   dist/client.js       设置页的浏览器端，包成 window.__ModuleLoader__.load 的格式（包的 ./client 导出）
// @deepseek-ai/* 保持 external：运行时由宿主提供，避免出现两套框架实例。
// 默认输出到 dist/；设了环境变量 AHA_BUILD_OUT 就输出到那个目录（验证打包时用，不动 dist/）。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import { build } from 'esbuild'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'aha-tavern'

async function buildPlugin(outdir, logLevel) {
  await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/index.ts'],
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['@deepseek-ai/*'],
    // yaml 等 CJS 依赖打进 ESM 产物后需要 require，补一个
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    // 提示词文件以文本内联
    loader: { '.md': 'text' },
    sourcemap: false,
    legalComments: 'none',
    logLevel,
  })
}

async function buildTypert(outdir, logLevel) {
  await build({
    absWorkingDir: ROOT,
    entryPoints: { 'typert.host': 'src/typert-host.ts' },
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['@deepseek-ai/*'],
    legalComments: 'none',
    logLevel,
  })
}

/** 浏览器端：先打成 CJS，再套上宿主要求的 factory 外壳。react 等由宿主页面提供，保持 external。 */
async function buildClient(outdir, logLevel) {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ['src/client/entry.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'cjs',
    target: 'es2020',
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
    legalComments: 'none',
    logLevel,
  })
  const code = result.outputFiles[0].text
  const wrapped = [
    'window.__ModuleLoader__.load({',
    `  id: ${JSON.stringify(PACKAGE_NAME)},`,
    '  factory: (require) => {',
    '    var module = { exports: {} };',
    '    var exports = module.exports;',
    code,
    '    return module.exports;',
    '  }',
    '});',
    '',
  ].join('\n')
  await fs.mkdir(outdir, { recursive: true })
  await fs.writeFile(path.join(outdir, 'client.js'), wrapped, 'utf8')
}

export async function buildAll({ outdir = path.join(ROOT, 'dist'), logLevel = 'info' } = {}) {
  await buildPlugin(outdir, logLevel)
  await buildTypert(outdir, logLevel)
  await buildClient(outdir, logLevel)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAll({ outdir: process.env.AHA_BUILD_OUT ? path.resolve(process.env.AHA_BUILD_OUT) : undefined })
}
