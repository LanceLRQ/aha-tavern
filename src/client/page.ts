// 设置页的界面。只用原生 HTML 元素和宿主提供的 React，样式用继承色与半透明边框，明暗主题下都能看。
// 所有结果文字来自插件端（与对应的 /aha 命令同一份文案）；这里不拼服务端原文。
import { createElement as h, useEffect, useRef, useState } from 'react'
import type { SettingsState, StartResultView, TestResult, VoiceStatusView } from '../shell/settings'
import {
  IMAGE_FIELDS, SUGGEST_HF, SUGGEST_MODELS, VOICE_FIELDS, changedFields, guard, isActionResult, isDirty, isSaveResult,
  isSettingsState, isStartResult, isTestResult, isVoiceStatus, placeholders, type FieldDef, type Fields,
} from './logic'

/** 插件端远程服务的方法；每个都返回 { ok, value }。 */
export interface Remote {
  getState(): Promise<unknown>
  saveVoice(form: Fields): Promise<unknown>
  saveImage(form: Fields): Promise<unknown>
  voiceStatus(): Promise<unknown>
  voiceStart(options: { confirmed?: boolean; detail?: string }): Promise<unknown>
  voiceStop(): Promise<unknown>
  testVoice(): Promise<unknown>
  testImage(): Promise<unknown>
}

const POLL_MS = 2000
const LINE = '1px solid rgba(128,128,128,0.35)'

const S = {
  page: { display: 'flex', flexDirection: 'column', gap: 16, margin: '12px 0' },
  card: { border: LINE, borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
  title: { margin: 0, fontSize: 15, fontWeight: 600 },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  field: { display: 'flex', flexDirection: 'column', gap: 3 },
  label: { fontSize: 12, opacity: 0.8 },
  hint: { fontSize: 11, opacity: 0.6 },
  err: { fontSize: 12, color: '#d9534f' },
  input: { font: 'inherit', color: 'inherit', background: 'transparent', border: LINE, borderRadius: 6, padding: '5px 8px', minWidth: 0, maxWidth: '100%' },
  button: { font: 'inherit', color: 'inherit', background: 'transparent', border: LINE, borderRadius: 6, padding: '5px 12px', cursor: 'pointer' },
  primary: { font: 'inherit', color: 'inherit', background: 'rgba(128,128,128,0.2)', border: LINE, borderRadius: 6, padding: '5px 12px', cursor: 'pointer', fontWeight: 600 },
  status: { border: LINE, borderRadius: 8, padding: '8px 10px', fontSize: 13 },
  detail: { margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 },
} as const

type Style = Record<string, unknown>
const el = (tag: string, style: Style | null, props: Record<string, unknown> | null, ...children: unknown[]) =>
  h(tag, { ...(style ? { style } : {}), ...(props ?? {}) }, ...children)

function Button(label: string, onClick: () => void, opts: { primary?: boolean; disabled?: boolean } = {}) {
  return el('button', opts.primary ? S.primary : S.button, { type: 'button', onClick, disabled: opts.disabled === true }, label)
}

function FieldRow(
  def: FieldDef, value: string, placeholder: string, error: string | undefined, onChange: (v: string) => void, suggestions: readonly string[],
) {
  const listId = def.suggest ? `aha-list-${def.suggest}` : undefined
  let input: unknown
  if (def.kind === 'select') {
    input = el('select', S.input, { value, onChange: (e: any) => onChange(e.target.value) },
      ...(def.options ?? []).map((o) => h('option', { key: o.value, value: o.value }, o.label)))
  } else {
    input = el('input', S.input, {
      type: def.kind === 'number' ? 'number' : 'text', value, placeholder, spellCheck: false, autoComplete: 'off',
      onChange: (e: any) => onChange(e.target.value), ...(listId ? { list: listId } : {}),
    })
  }
  return el('label', S.field, { key: def.key },
    el('span', S.label, null, def.label),
    input,
    listId ? h('datalist', { id: listId }, ...suggestions.map((s) => h('option', { key: s, value: s }))) : null,
    error ? el('span', S.err, null, error) : def.hint ? el('span', S.hint, null, def.hint) : null)
}

function TestLines(result: TestResult | null) {
  if (!result) return null
  return el('div', S.status, null,
    ...result.lines.map((l, i) => el('div', null, { key: i }, `${l.mark ? `${l.mark} ` : ''}${l.text}`)))
}

function Notice(text: string, ok: boolean) {
  return text ? el('div', ok ? S.hint : S.err, null, text) : null
}

interface SectionProps {
  remote: Remote
  state: SettingsState
  reload: () => Promise<void>
}

function useBusy(): [string, <T>(name: string, fn: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState('')
  const run = async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name)
    try {
      return await fn()
    } finally {
      setBusy('')
    }
  }
  return [busy, run]
}

/** 表单 + 保存 + 测试连接，两节共用。 */
function useSection(
  props: SectionProps, section: 'voice' | 'image', save: (f: Fields) => Promise<unknown>, test: () => Promise<unknown>,
) {
  const saved = props.state[section].form as Fields
  const [form, setForm] = useState<Fields>({ ...saved })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [busy, run] = useBusy()
  const savedKey = JSON.stringify(saved)
  const lastKey = useRef(savedKey)
  // 插件端的值变了（保存后重新读取）就把表单对齐
  useEffect(() => {
    if (lastKey.current !== savedKey) {
      lastKey.current = savedKey
      setForm({ ...saved })
    }
  }, [savedKey])
  const dirty = isDirty(form, saved)

  const doSave = () => run('save', async () => {
    try {
      const r = guard(await save(changedFields(form, saved)), isSaveResult)
      setErrors(r.errors ?? {})
      setMessage({ text: r.text, ok: r.ok })
      if (r.ok) await props.reload()
    } catch (e) {
      setMessage({ text: (e as Error).message, ok: false })
    }
  })
  const doTest = () => run('test', async () => {
    try {
      setTestResult(guard(await test(), isTestResult))
    } catch (e) {
      setTestResult({ ok: false, lines: [{ mark: '✗', text: (e as Error).message }] })
    }
  })
  return { form, setForm, errors, message, testResult, busy, dirty, doSave, doTest, section }
}

function ProblemList(problems: readonly string[]) {
  if (problems.length === 0) return null
  return el('div', S.status, null, ...problems.map((p, i) => el('div', S.err, { key: i }, `! ${p}`)))
}

function SectionBody(
  fields: readonly FieldDef[], s: ReturnType<typeof useSection>, ph: Fields,
  suggestions: Record<string, readonly string[]>, extra: unknown[],
) {
  return [
    ...extra,
    el('div', S.grid, null, ...fields.map((f) =>
      FieldRow(f, s.form[f.key] ?? '', ph[f.key] ?? '', s.errors[f.key], (v) => s.setForm({ ...s.form, [f.key]: v }), suggestions[f.suggest ?? ''] ?? []))),
    el('div', S.row, null,
      Button(s.busy === 'save' ? '保存中…' : '保存', s.doSave, { primary: true, disabled: s.busy !== '' || !s.dirty }),
      Button(s.busy === 'test' ? '测试中…' : '测试连接', s.doTest, { disabled: s.busy !== '' || s.dirty }),
      s.dirty ? el('span', S.hint, null, '有未保存的修改；测试连接用的是已保存的配置。') : null),
    s.errors._ ? el('div', S.err, null, s.errors._) : null,
    s.message ? Notice(s.message.text, s.message.ok) : null,
    TestLines(s.testResult),
  ]
}

function VoiceSection(props: SectionProps) {
  const { remote, state } = props
  const s = useSection(props, 'voice', (f) => remote.saveVoice(f), () => remote.testVoice())
  const [status, setStatus] = useState<VoiceStatusView>(state.voiceStatus)
  const [note, setNote] = useState<{ text: string; ok: boolean; pending?: boolean } | null>(null)
  const [confirm, setConfirm] = useState<NonNullable<StartResultView['confirm']> | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const refresh = async () => {
    try {
      setStatus(guard(await remote.voiceStatus(), isVoiceStatus))
    } catch (e) {
      setNote({ text: (e as Error).message, ok: false })
    }
  }
  // 保存配置后整页状态会重读，跟着更新；启动中每 2 秒查一次进度
  useEffect(() => { setStatus(state.voiceStatus) }, [JSON.stringify(state.voiceStatus)])
  useEffect(() => {
    if (status.state !== 'starting') setNote((n) => (n?.pending ? null : n))
  }, [status.state])
  useEffect(() => {
    if (status.state !== 'starting') return undefined
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => clearInterval(timer)
  }, [status.state])

  const start = async (confirmedDetail?: string) => {
    setActionBusy(true)
    setNote(null)
    try {
      const r = guard(await remote.voiceStart(confirmedDetail === undefined ? {} : { confirmed: true, detail: confirmedDetail }), isStartResult)
      if (r.result === 'need-confirm' && r.confirm) {
        setConfirm(r.confirm)
      } else {
        setConfirm(null)
        // 转入后台的"正在启动"提示：状态走到终态后清掉
        setNote({ text: r.text, ok: r.ok, ...(r.result === 'starting' ? { pending: true } : {}) })
      }
      await refresh()
    } catch (e) {
      setNote({ text: (e as Error).message, ok: false })
    } finally {
      setActionBusy(false)
    }
  }
  const stop = async () => {
    setActionBusy(true)
    setNote(null)
    try {
      const r = guard(await remote.voiceStop(), isActionResult)
      setNote({ text: r.text, ok: r.ok })
      await refresh()
    } catch (e) {
      setNote({ text: (e as Error).message, ok: false })
    } finally {
      setActionBusy(false)
    }
  }

  const suggestions = { models: SUGGEST_MODELS, hf: SUGGEST_HF }
  const control = [
    el('div', S.status, null, el('div', null, null, status.text),
      status.env && status.state !== 'running'
        ? el('div', S.hint, null, `运行环境${status.env.envInstalled ? '已安装' : '未安装'}，模型${status.env.modelDownloaded ? '已下载' : '未下载'}。`)
        : null),
    confirm
      ? el('div', S.status, null,
          el('div', { fontWeight: 600 }, null, `${confirm.header}：${confirm.question}`),
          el('pre', S.detail, null, confirm.detail),
          el('div', S.row, null,
            Button(confirm.goLabel, () => { void start(confirm.detail) }, { primary: true, disabled: actionBusy }),
            Button(confirm.cancelLabel, () => setConfirm(null), { disabled: actionBusy })))
      : null,
    el('div', S.row, null,
      Button('启动服务', () => { void start() }, { primary: true, disabled: actionBusy || !status.canStart || confirm !== null }),
      Button('停止服务', () => { void stop() }, { disabled: actionBusy || !status.canStop }),
      Button('刷新状态', () => { void refresh() }, { disabled: actionBusy })),
    note ? Notice(note.text, note.ok) : null,
  ]
  const ph = placeholders(state, 'voice')
  return el('section', S.card, null, el('h3', S.title, null, '语音'),
    ...SectionBody(VOICE_FIELDS, s, ph, suggestions, [ProblemList([...state.problems.voice]), ...control]))
}

function ImageSection(props: SectionProps) {
  const { remote, state } = props
  const s = useSection(props, 'image', (f) => remote.saveImage(f), () => remote.testImage())
  const ph = placeholders(state, 'image')
  return el('section', S.card, null, el('h3', S.title, null, '生图'),
    ...SectionBody(IMAGE_FIELDS, s, ph, { workflows: state.workflows }, [ProblemList([...state.problems.image])]))
}

function PageBody(props: { getRemote: () => Remote }) {
  const [state, setState] = useState<SettingsState | null>(null)
  const [error, setError] = useState('')
  const remote = props.getRemote()
  const reload = async () => {
    try {
      setState(guard(await remote.getState(), isSettingsState))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => { void reload() }, [])
  if (error && !state) return el('div', S.page, null, el('div', S.err, null, error), Button('重试', () => { void reload() }))
  if (!state) return el('div', S.hint, null, '读取中…')
  const sectionProps = { remote, state, reload }
  return el('div', S.page, null,
    state.problems.file.length > 0 ? ProblemList(state.problems.file) : null,
    h(VoiceSection, sectionProps),
    h(ImageSection, sectionProps),
    el('div', S.hint, null, `配置保存在 ${state.servicesPath}；文件里的注释和这里没有的字段保存时会原样保留。`))
}

/** 返回槽位里渲染的组件：view 为 summary 时只给一句话，page 时给完整页面。 */
export function createPage(getRemote: () => Remote) {
  return function AhaSettingsPage(props: { view?: string }) {
    if (props.view === 'summary') return el('span', null, null, '语音与生图服务的地址、模型和启停')
    return h(PageBody, { getRemote })
  }
}
