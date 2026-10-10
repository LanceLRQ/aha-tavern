// 包的 ./typert 导出：宿主据此发现设置页的远程服务。构建后是 dist/typert.host.js。
import { hostTypert } from './shared/settings-rpc'

export const TYPERT = hostTypert()
