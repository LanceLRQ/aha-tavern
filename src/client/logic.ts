// 设置页里不依赖 React 的部分：字段表、远程调用结果的拆包、表单是否改动。
import type {
  ActionResult, SaveResult, SettingsState, StartResultView, TestResult, VoiceStatusView,
} from '../shell/settings'

export type Fields = Record<string, string>

export interface FieldDef {
  key: string
  label: string
  /** 字段下方的说明。 */
  hint?: string
  kind: 'text' | 'number' | 'select'
  /** 数字输入框的步长；允许小数时写 any 或 0.5。 */
  step?: string
  options?: readonly { value: string; label: string }[]
  /** 输入框的候选值来源。 */
  suggest?: 'workflows' | 'models' | 'hf'
}

export const VOICE_FIELDS: readonly FieldDef[] = [
  { key: 'endpoint', label: '服务地址', hint: '必填。语音服务的 http 地址，如 http://127.0.0.1:18123；不要带用户名密码。', kind: 'text' },
  {
    key: 'launch', label: '启动方式', kind: 'select',
    hint: '选"本机代为启动"时，插件可以在这台 Mac 上安装并启动语音服务；地址必须是本机地址。',
    options: [{ value: '', label: '默认（只连接，不代为启动）' }, { value: 'none', label: '只连接，不代为启动' }, { value: 'mlx', label: '本机代为启动' }],
  },
  { key: 'model', label: '模型', hint: '0.6b 更省内存，1.7b 音质更好；也可以写完整的模型名。', kind: 'text', suggest: 'models' },
  { key: 'modelsDir', label: '权重目录', hint: '运行环境与模型权重存放的位置，绝对路径（可以用 ~ 开头）。', kind: 'text' },
  { key: 'hfEndpoint', label: '下载源', hint: '下载模型用的镜像地址；留空用官方源。', kind: 'text', suggest: 'hf' },
  {
    key: 'read', label: '朗读范围', kind: 'select',
    options: [{ value: '', label: '默认（只念台词）' }, { value: 'lines', label: '只念台词' }, { value: 'all', label: '整段都念' }],
  },
  { key: 'language', label: '语言', hint: '传给语音服务的语言名，如 chinese。', kind: 'text' },
  { key: 'timeoutSeconds', label: '单句超时（秒）', hint: '单句合成最多等多久。', kind: 'number' },
  {
    key: 'pauseSeconds', label: '段间停顿（秒）', kind: 'number', step: '0.5',
    hint: '隔着大约 12 个没念出来的字时停多久；字多停久些、字少停短些，范围由下面两项决定；0 表示不停。',
  },
  { key: 'pauseMinSeconds', label: '最短停顿（秒）', hint: '隔着的字很少时停的最短时间；不能大于段间停顿。', kind: 'number', step: '0.5' },
  { key: 'pauseMaxSeconds', label: '最长停顿（秒）', hint: '隔着的字很多时停的最长时间；不能小于段间停顿。', kind: 'number', step: '0.5' },
]

export const IMAGE_FIELDS: readonly FieldDef[] = [
  { key: 'endpoint', label: '服务地址', hint: '必填。ComfyUI 的 http 地址，如 http://192.168.1.5:8188；不要带用户名密码。', kind: 'text' },
  { key: 'workflow', label: '工作流', hint: '内置工作流名，或工作流文件的绝对路径。', kind: 'text', suggest: 'workflows' },
  {
    key: 'auto', label: '角色自己决定出图', kind: 'select',
    options: [{ value: '', label: '默认（是）' }, { value: 'true', label: '是' }, { value: 'false', label: '否，只在我要求时出图' }],
  },
  { key: 'style', label: '画风', hint: '拼在每个提示词最前面。', kind: 'text' },
  { key: 'width', label: '宽', kind: 'number' },
  { key: 'height', label: '高', kind: 'number' },
  { key: 'steps', label: '步数', kind: 'number' },
  { key: 'timeoutSeconds', label: '单张超时（秒）', kind: 'number' },
  { key: 'unet', label: '覆盖 unet 文件名', hint: '留空用工作流自带的。', kind: 'text' },
  { key: 'clip', label: '覆盖 clip 文件名', kind: 'text' },
  { key: 'vae', label: '覆盖 vae 文件名', kind: 'text' },
]

export const SUGGEST_MODELS = ['0.6b', '1.7b'] as const
export const SUGGEST_HF = ['https://hf-mirror.com'] as const

/** 远程调用的结果：`{ ok: true, value }` 或 `{ ok: false, error }`。 */
export function unwrap<T>(r: unknown): T {
  if (r && typeof r === 'object' && (r as { ok?: unknown }).ok === true && 'value' in r) return (r as { value: T }).value
  throw new Error('和插件通信失败，请确认插件已启用后刷新页面。')
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const VOICE_STATES = ['not-configured', 'invalid', 'starting', 'failed', 'running', 'stopped']

export const isActionResult = (v: unknown): v is ActionResult => isObj(v) && typeof v.ok === 'boolean' && typeof v.text === 'string'
export const isSaveResult = (v: unknown): v is SaveResult =>
  isActionResult(v) && ((v as SaveResult).errors === undefined || isObj((v as SaveResult).errors))
export const isTestResult = (v: unknown): v is TestResult =>
  isObj(v) && typeof v.ok === 'boolean' && Array.isArray(v.lines) &&
  v.lines.every((l) => isObj(l) && typeof l.mark === 'string' && typeof l.text === 'string')
export const isVoiceStatus = (v: unknown): v is VoiceStatusView =>
  isObj(v) && typeof v.state === 'string' && VOICE_STATES.includes(v.state) && typeof v.text === 'string' &&
  typeof v.canStart === 'boolean' && typeof v.canStop === 'boolean'
export const isStartResult = (v: unknown): v is StartResultView =>
  isActionResult(v) && ['need-confirm', 'starting', 'done'].includes((v as unknown as StartResultView).result) &&
  ((v as unknown as StartResultView).confirm === undefined ||
    (isObj((v as unknown as StartResultView).confirm) && typeof (v as unknown as StartResultView).confirm!.detail === 'string'))
export const isSettingsState = (v: unknown): v is SettingsState =>
  isObj(v) && typeof v.servicesPath === 'string' && Array.isArray(v.workflows) &&
  isObj(v.voice) && isObj(v.voice.form) && isObj(v.image) && isObj(v.image.form) && isObj(v.defaults) &&
  isObj(v.problems) && Array.isArray(v.problems.voice) && Array.isArray(v.problems.image) && Array.isArray(v.problems.file) &&
  isVoiceStatus(v.voiceStatus)

/** 拆包并判别形状：通信失败或形状不对（比如插件端出错返回的固定值）都抛出中文说明，由调用处显示在对应区域。 */
export function guard<T>(r: unknown, check: (v: unknown) => v is T): T {
  const value = unwrap<unknown>(r)
  if (!check(value)) throw new Error('插件端返回的内容不对，可能是操作出错了，详情见日志。')
  return value
}

/** 只留下与已保存值不同的字段；保存时只提交这些，免得覆盖用户在别处改过的其它字段。 */
export function changedFields(form: Fields, saved: Fields): Fields {
  return Object.fromEntries(Object.entries(form).filter(([k, v]) => v !== (saved[k] ?? '')))
}

export function isDirty(form: Fields, saved: Fields): boolean {
  return Object.keys(form).some((k) => (form[k] ?? '') !== (saved[k] ?? ''))
}

/** 从插件端返回的状态里取出某一节的占位默认值（字符串化）。 */
export function placeholders(state: SettingsState, section: 'voice' | 'image'): Fields {
  const d = state.defaults[section] as Record<string, unknown>
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '是' : '否') : String(v)]))
}
