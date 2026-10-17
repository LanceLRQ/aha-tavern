import fs from 'node:fs'
import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const read = (f: string) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))

describe('DSH 运行时兼容范围', () => {
  const packages = ['dsh-compaction-basic', 'dsh-llm', 'dsh-tools', 'dsh-typert-protocol']
  for (const name of ['dsh', ...packages]) {
    it(`${name} 接受两个受支持的候选版本并排除范围外版本`, () => {
      const range = name === 'dsh' ? pkg.engines?.dsh : pkg.peerDependencies[`@deepseek-ai/${name}`]
      expect(range).toBeTypeOf('string')
      for (const version of ['0.2.0-rc.2', '0.2.1-rc.1', '0.2.1']) {
        expect(satisfies(version, range), version).toBe(true)
      }
      for (const version of ['0.2.0-rc.1', '0.2.1-rc.0', '0.3.0-rc.1', '0.3.0']) {
        expect(satisfies(version, range), version).toBe(false)
      }
    })
  }
})

describe('设置页的包清单约定', () => {
  it('导出 ./typert 与 ./client，并声明浏览器端', () => {
    expect(pkg.exports['./typert']).toBe('./dist/typert.host.js')
    expect(pkg.exports['./client']).toBe('./dist/client.js')
    expect(pkg.exports['.']).toBe('./dist/index.js')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-plugin-manager')
    expect(pkg.files).toContain('dist')
  })

  it('files 只带面向使用者的三份文档（回执里会让用户去看），不带整个 docs', () => {
    for (const f of ['docs/getting-started.md', 'docs/image-setup.md', 'docs/voice-setup.md']) {
      expect(pkg.files).toContain(f)
      expect(fs.existsSync(new URL(`../../${f}`, import.meta.url))).toBe(true)
    }
    expect(pkg.files).not.toContain('docs')
  })
  it('files 含 assets，随包录音存在（预热与无角色试念要用）', () => {
    expect(pkg.files).toContain('assets')
    expect(fs.existsSync(new URL('../../assets/voice-ref.wav', import.meta.url))).toBe(true)
  })

  it('补丁里有一行根层的设置页实例：说明符等于包名，mode 为 settings；酒馆模式的 id 与名字不变', () => {
    const patch = YAML.parse(read('cordis.patch.yml')) as { insert: { id: string; name: string; config?: any }[] }[]
    const rows = patch[0]!.insert
    const settings = rows.find((r) => r.name === pkg.name)
    expect(settings).toMatchObject({ id: 'aha-tavern-settings', config: { mode: 'settings' } })
    // 根层行的 id 与宿主自己的行同在一张表里：撞名会让宿主的服务消失（实测 settings 撞过）
    for (const r of rows) expect(r.id, `根层行 id ${r.id}`).toMatch(/^(aha-tavern|preset-tavern-)/)
    expect(rows.map((r) => r.id)).not.toContain('settings')
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['preset-tavern-setup', 'preset-tavern-chat', 'preset-tavern-group', 'preset-tavern-book']))
    const presets = rows.filter((r) => r.id.startsWith('preset-'))
    expect(presets.map((p) => p.config.id).sort()).toEqual(['tavern-book', 'tavern-chat', 'tavern-group', 'tavern-setup'])
    // 酒馆模式里嵌套的插件仍是原来的 aha-tavern，mode 分别为 setup / chat / group / book
    const nested = presets.map((p) => p.config.plugins.find((x: any) => x.id === 'aha-tavern').config.mode).sort()
    expect(nested).toEqual(['book', 'chat', 'group', 'setup'])
  })

  it('本机调试模板的模式与 cordis.patch.yml 一致（只差插件写成 dist 下的绝对路径）', () => {
    type Row = { id: string; name: string; config?: any }
    const presetsOf = (f: string) => (YAML.parse(read(f)) as { insert: Row[] }[])[0]!.insert.filter((r) => r.id.startsWith('preset-'))
    const local = (name: string) => name.endsWith('/dist/index.js') ? pkg.name : name.endsWith('/dist/compaction.js') ? `${pkg.name}/compaction` : name
    const normalize = (v: any): any => Array.isArray(v) ? v.map(normalize)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'name' && typeof x === 'string' ? local(x) : normalize(x)]))
        : v
    expect(normalize(presetsOf('examples/dev.example.yml'))).toEqual(presetsOf('cordis.patch.yml'))
  })

  it('提问卡片工具只有筹备模式挂：单聊与群聊里模型看到的提问工具只会被滥用来抢插件的事', () => {
    const patch = YAML.parse(read('cordis.patch.yml')) as { insert: { id: string; config?: any }[] }[]
    const presets = patch[0]!.insert.filter((r) => r.id.startsWith('preset-'))
    const ask = (p: { config?: any }) => ((p.config?.plugins ?? []) as any[]).some((x) => x.id === 'tool-ask-user')
    // 主持人建卡流程用它让 user 挑已有的东西（host-setup 规则 2、11）
    expect(presets.filter((p) => ask(p)).map((p) => p.config.id)).toEqual(['tavern-setup'])
  })

  it('每个酒馆模式都挂隔离的 compaction 组：扮演向压缩后端加手动 /compact，长聊天有压缩对策', () => {
    const patch = YAML.parse(read('cordis.patch.yml')) as { insert: { id: string; config?: any }[] }[]
    const presets = patch[0]!.insert.filter((r) => r.id.startsWith('preset-'))
    expect(presets).toHaveLength(4)
    for (const p of presets) {
      const group = ((p.config?.plugins ?? []) as any[]).find((x) => x.id === 'compaction')
      expect(group, `模式 ${p.config.id} 缺 compaction 组`).toMatchObject({ name: 'cordis:group', group: true, isolate: { compaction: true } })
      expect(group.config.map((c: any) => c.id)).toEqual(['compaction-tavern', 'command-compact'])
      expect(group.config[0].name).toBe(`${pkg.name}/compaction`)
    }
    // 压缩入口随包发布
    expect(pkg.exports['./compaction']).toBe('./dist/compaction.js')
  })

  it('peerDependencies 声明了设置页要用的协议包', () => {
    expect(pkg.peerDependencies['@deepseek-ai/dsh-typert-protocol']).toBeTruthy()
    // 协议包缺席时插件照常装配，只是没有设置页：标为可选
    expect(pkg.peerDependenciesMeta['@deepseek-ai/dsh-typert-protocol']).toEqual({ optional: true })
  })
})
