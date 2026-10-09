import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 与构建一致：.md 以文本内联
  plugins: [{ name: 'md-text', transform: (code, id) => (id.endsWith('.md') ? `export default ${JSON.stringify(code)}` : null) }],
  test: { include: ['test/unit/**/*.test.ts'], environment: 'node', testTimeout: 10_000 },
})
