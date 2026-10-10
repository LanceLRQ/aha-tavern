import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const read = (f: string) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))

describe('设置页的包清单约定', () => {
  it('导出 ./typert 与 ./client，并声明浏览器端', () => {
    expect(pkg.exports['./typert']).toBe('./dist/typert.host.js')
    expect(pkg.exports['./client']).toBe('./dist/client.js')
    expect(pkg.exports['.']).toBe('./dist/index.js')
    expect(pkg.dsh.client.platform).toBe('web')
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-plugin-manager')
    expect(pkg.files).toContain('dist')
  })

  it('补丁里有一行根层的设置页实例：说明符等于包名，mode 为 settings；酒馆模式的 id 与名字不变', () => {
    const patch = YAML.parse(read('cordis.patch.yml')) as { insert: { id: string; name: string; config?: any }[] }[]
    const rows = patch[0]!.insert
    const settings = rows.find((r) => r.name === pkg.name)
    expect(settings).toMatchObject({ id: 'aha-tavern-settings', config: { mode: 'settings' } })
    // 根层行的 id 与宿主自己的行同在一张表里：撞名会让宿主的服务消失（实测 settings 撞过）
    for (const r of rows) expect(r.id, `根层行 id ${r.id}`).toMatch(/^(aha-tavern|preset-tavern-)/)
    expect(rows.map((r) => r.id)).not.toContain('settings')
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['preset-tavern-setup', 'preset-tavern-chat']))
    const presets = rows.filter((r) => r.id.startsWith('preset-'))
    expect(presets.map((p) => p.config.id).sort()).toEqual(['tavern-chat', 'tavern-setup'])
    // 酒馆模式里嵌套的插件仍是原来的 aha-tavern，mode 分别为 setup / chat
    const nested = presets.map((p) => p.config.plugins.find((x: any) => x.id === 'aha-tavern').config.mode).sort()
    expect(nested).toEqual(['chat', 'setup'])
  })

  it('peerDependencies 声明了设置页要用的协议包', () => {
    expect(pkg.peerDependencies['@deepseek-ai/dsh-typert-protocol']).toBeTruthy()
    // 协议包缺席时插件照常装配，只是没有设置页：标为可选
    expect(pkg.peerDependenciesMeta['@deepseek-ai/dsh-typert-protocol']).toEqual({ optional: true })
  })
})
