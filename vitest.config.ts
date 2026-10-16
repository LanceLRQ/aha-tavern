import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 与构建一致：.md 以文本内联
  plugins: [{ name: 'md-text', transform: (code, id) => (id.endsWith('.md') ? `export default ${JSON.stringify(code)}` : null) }],
  // 套件里有大图的 sharp 处理：并行负载下偶发超 10 秒，超时放到 20 秒（单独跑远低于此）
  test: { include: ['test/unit/**/*.test.ts'], environment: 'node', testTimeout: 20_000, setupFiles: ['test/setup-home.ts'] },
})
