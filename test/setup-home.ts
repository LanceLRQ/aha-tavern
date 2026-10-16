// 单元测试里任何 ~ 开头的路径（默认配置的登记表、服务配置等）都落到临时目录，不碰真实的 ~/.dsh
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aha-test-home-'))
process.env.HOME = home
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
