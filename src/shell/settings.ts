// 设置页的插件端：读写 services.yaml 的表单、语音服务的状态与启停、两项服务的"测试连接"。
// 页面传来的一切都当不可信输入：先校验再用；返回给页面的错误只有归类后的固定短语，不带服务端原文，
// 日志里的地址去掉用户名密码。启停走 voice.ts 的同一套操作，页面上需要安装或下载时先显示与确认卡片相同的说明。
import fs from 'node:fs/promises'
import os from 'node:os'
import { createComfyClient } from '../core/comfy'
import {
  IMAGE_SERVICE_DEFAULTS, VOICE_SERVICE_DEFAULTS, hasUserInfo, loadImageService, type VoiceServiceSettings,
} from '../core/services'
import {
  ServicesEditError, parseImageForm, parseVoiceForm, readServicesForm, updateServicesFile,
  type FormResult, type ServicesForm, type ServicesSection,
} from '../core/services-edit'
import { TtsError, createTtsClient } from '../core/tts'
import { checkDrawing, redactUrls, type DrawDoctorReport } from './draw-doctor'
import { hostOf } from './draw'
import {
  VOICE_CARD_HEADER, VOICE_CARD_QUESTION, VOICE_OPT_CANCEL, VOICE_OPT_GO, VOICE_STAGE_NAME, drawDoctorItems, drawDoctorIssues,
  voiceLastFailedReceipt, voiceNotConfiguredReceipt, voiceStartingReceipt, voiceStatusNotConfiguredReceipt, voiceStatusReceipt,
  voiceStopReceipt, voiceUnavailableReceipt, voiceUserInfoReceipt, type Reply,
} from './receipts'
import { defaultModelsDir, type Runtime } from './runtime'
import { isLaunching } from './voice'

const VOICE_PROBE_MS = 5000

// ---------- 返回给页面的结构（全部是可 JSON 化的纯数据） ----------

export interface ActionResult { ok: boolean; text: string }
export interface SaveResult extends ActionResult {
  /** 按字段名给出的校验错误。 */
  errors?: Record<string, string>
}

export type VoiceState = 'not-configured' | 'invalid' | 'starting' | 'failed' | 'running' | 'stopped'
export interface VoiceStatusView {
  state: VoiceState
  /** 一句话状态，与 `/aha 语音 状态` 同一份文字。 */
  text: string
  /** 启动中时所在的阶段：install / start / warmup。 */
  stage?: 'install' | 'start' | 'warmup'
  seconds?: number
  /** 插件启动的（running 时有意义）。 */
  ours?: boolean
  canStart: boolean
  canStop: boolean
  modelsDir?: string
  env?: { supported: boolean; uv: boolean; envInstalled: boolean; modelDownloaded: boolean }
}

export interface StartResultView {
  result: 'need-confirm' | 'starting' | 'done'
  ok: boolean
  text: string
  confirm?: { header: string; question: string; detail: string; goLabel: string; cancelLabel: string }
}

export interface TestResult {
  ok: boolean
  lines: { mark: string; text: string }[]
}

export interface SettingsState {
  servicesPath: string
  workflows: string[]
  voice: { form: ServicesForm['voice'] }
  image: { form: ServicesForm['image'] }
  defaults: {
    voice: { launch: string; model: string; modelsDir: string; read: string; language: string; timeoutSeconds: number }
    image: { workflow: string; auto: boolean; style: string; width: number; height: number; steps: number; timeoutSeconds: number }
  }
  problems: { file: string[]; voice: string[]; image: string[] }
  voiceStatus: VoiceStatusView
}

export interface SettingsApi {
  getState(): Promise<SettingsState>
  saveVoice(form: unknown): Promise<SaveResult>
  saveImage(form: unknown): Promise<SaveResult>
  voiceStatus(): Promise<VoiceStatusView>
  voiceStart(options: unknown): Promise<StartResultView>
  voiceStop(): Promise<ActionResult>
  testVoice(): Promise<TestResult>
  testImage(): Promise<TestResult>
}

export interface SettingsApiDeps {
  /** 服务里已加载的模型名；连不上就拒绝。 */
  probeVoice(endpoint: string, timeoutMs: number): Promise<string[]>
  /** 生图检查（不试出图）。 */
  checkImage(): Promise<DrawDoctorReport>
  defaultModelsDir(): string
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const VOICE_TEST_FAIL: Record<string, string> = {
  unreachable: '连不上语音服务，请确认它已启动、地址和端口没写错。',
  timeout: '语音服务没有及时回应。',
  'bad-response': '语音服务返回了看不懂的内容，请确认地址指向的是语音服务。',
  cancelled: '连接测试被取消。',
  other: '连接测试出错，详情见日志。',
}
const SAVE_EDIT_FAIL: Record<'parse' | 'format', string> = {
  parse: '服务配置文件解析失败，请先修好文件里的 YAML 语法再保存。',
  format: '服务配置文件的格式不对，请先手工修好再保存。',
}
const SAVE_FAIL = '保存失败，详情见日志。'
const NOT_CONFIGURED_TEST = '还没有保存服务地址，先填好地址并保存。'

const replyView = (r: Reply): ActionResult => ({ ok: r.kind === 'success', text: r.text })

export function createSettingsApi(rt: Runtime, deps: Partial<SettingsApiDeps> = {}): SettingsApi {
  const probeVoice = deps.probeVoice ?? ((endpoint, timeoutMs) => createTtsClient({ endpoint, fetch: globalThis.fetch }).probe(timeoutMs))
  const defaultDir = deps.defaultModelsDir ?? defaultModelsDir
  const checkImage = deps.checkImage ?? (async () =>
    checkDrawing({
      loadService: () => loadImageService(rt.servicesPath()),
      createClient: (endpoint) => createComfyClient({ endpoint, fetch: globalThis.fetch }),
      builtinWorkflowDir: rt.builtinWorkflowDir,
      tmpDir: os.tmpdir(),
      now: Date.now,
      random: Math.random,
      log: rt.log,
    }, { trial: false }))

  async function listWorkflows(): Promise<string[]> {
    try {
      const names = await fs.readdir(rt.builtinWorkflowDir)
      return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)).sort()
    } catch {
      return []
    }
  }

  async function save(section: ServicesSection, parse: (opts: { partial: boolean }) => FormResult): Promise<SaveResult> {
    // 页面只提交改动的字段；地址必填与"代为启动要本机地址"在写文件的锁内按合并后的结果校验
    const parsed = parse({ partial: true })
    if (!parsed.ok) return { ok: false, errors: parsed.errors, text: '有填写不对的地方，请改正后再保存。' }
    try {
      await updateServicesFile(rt.servicesPath(), section, parsed.edit)
      return { ok: true, text: '已保存。' }
    } catch (e) {
      if (e instanceof ServicesEditError) {
        if (e.code === 'invalid') return { ok: false, errors: e.errors, text: '有填写不对的地方，请改正后再保存。' }
        return { ok: false, text: SAVE_EDIT_FAIL[e.code] }
      }
      rt.log.warn(`设置页保存失败：${redactUrls((e as Error).message)}`)
      return { ok: false, text: SAVE_FAIL }
    }
  }

  async function voiceStatus(): Promise<VoiceStatusView> {
    const cfg = await rt.voiceSettings()
    if (!cfg.configured) return { state: 'not-configured', text: voiceStatusNotConfiguredReceipt().text, canStart: false, canStop: false }
    const s = cfg.settings
    if (hasUserInfo(s.endpoint)) return { state: 'invalid', text: voiceUserInfoReceipt().text, canStart: false, canStop: false }
    const voice = rt.voice
    if (!voice) return { state: 'invalid', text: voiceUnavailableReceipt().text, canStart: false, canStop: false }
    try {
      const d = await voice.statusOf(rt, s)
      const base = { modelsDir: s.modelsDir }
      if (d.phase === 'starting') {
        return {
          ...base, state: 'starting', stage: d.stage, seconds: d.seconds,
          text: `语音服务正在启动：${VOICE_STAGE_NAME[d.stage]}，已用 ${d.seconds} 秒。`, canStart: false, canStop: true,
        }
      }
      const env = { supported: d.info.supported, uv: d.info.uv !== null, envInstalled: d.info.envInstalled, modelDownloaded: d.info.modelDownloaded }
      if (d.phase === 'failed') {
        return {
          ...base, env, state: 'failed', text: voiceLastFailedReceipt(d.reason, s.modelsDir).text,
          canStart: s.launch === 'mlx', canStop: false,
        }
      }
      const text = voiceStatusReceipt({
        reachable: d.reachable, ours: d.ours, busy: d.busy, model: s.modelAlias ?? s.model, loaded: d.loaded,
      }).text
      return {
        ...base, env, text, state: d.reachable ? 'running' : 'stopped', ours: d.ours,
        canStart: s.launch === 'mlx' && !d.reachable && !d.busy, canStop: d.reachable && d.ours,
      }
    } catch (e) {
      rt.log.warn(`设置页读取语音状态出错：${redactUrls((e as Error).message)}`)
      return { state: 'invalid', text: '读取语音服务状态出错，详情见日志。', canStart: false, canStop: false }
    }
  }

  async function voiceStart(options: unknown): Promise<StartResultView> {
    const done = (r: Reply): StartResultView => ({ result: 'done', ...replyView(r) })
    const refuse = (r: Reply): StartResultView => ({ result: 'done', ok: false, text: r.text })
    const cfg = await rt.voiceSettings()
    if (!cfg.configured) return refuse(voiceNotConfiguredReceipt())
    const s: VoiceServiceSettings = cfg.settings
    if (hasUserInfo(s.endpoint)) return refuse(voiceUserInfoReceipt())
    const voice = rt.voice
    if (!voice) return refuse(voiceUnavailableReceipt())
    try {
      const plan = await voice.planStart(rt, s)
      if (plan.kind === 'reply') return done(plan.reply)
      // 需要安装或下载：用户必须看过同样内容的说明并确认；确认的内容与现在的不一致就重新确认
      const confirmedDetail = isRecord(options) && options.confirmed === true && typeof options.detail === 'string' ? options.detail : null
      if (plan.card !== null && confirmedDetail !== plan.card) {
        return {
          result: 'need-confirm', ok: true, text: VOICE_CARD_QUESTION,
          confirm: { header: VOICE_CARD_HEADER, question: VOICE_CARD_QUESTION, detail: plan.card, goLabel: VOICE_OPT_GO, cancelLabel: VOICE_OPT_CANCEL },
        }
      }
      const reply = await voice.launchAndWait(rt, s, plan)
      if (isLaunching(s.modelsDir)) {
        const d = await voice.statusOf(rt, s)
        return { result: 'starting', ...replyView(voiceStartingReceipt(d.phase === 'starting' ? d.stage : 'start')) }
      }
      return done(reply)
    } catch (e) {
      rt.log.warn(`设置页启动语音服务出错：${redactUrls((e as Error).message)}`)
      return { result: 'done', ok: false, text: '启动语音服务出错，详情见日志。' }
    }
  }

  async function voiceStop(): Promise<ActionResult> {
    const refuse = (r: Reply): ActionResult => ({ ok: false, text: r.text })
    const cfg = await rt.voiceSettings()
    if (!cfg.configured) return refuse(voiceNotConfiguredReceipt())
    if (hasUserInfo(cfg.settings.endpoint)) return refuse(voiceUserInfoReceipt())
    const voice = rt.voice
    if (!voice) return refuse(voiceUnavailableReceipt())
    try {
      return replyView(voiceStopReceipt(await voice.stopService(rt, cfg.settings)))
    } catch (e) {
      rt.log.warn(`设置页停止语音服务出错：${redactUrls((e as Error).message)}`)
      return { ok: false, text: '停止语音服务出错，详情见日志。' }
    }
  }

  async function testVoice(): Promise<TestResult> {
    const cfg = await rt.voiceSettings()
    if (!cfg.configured) return { ok: false, lines: [{ mark: '✗', text: NOT_CONFIGURED_TEST }] }
    const s = cfg.settings
    if (hasUserInfo(s.endpoint)) return { ok: false, lines: [{ mark: '✗', text: voiceUserInfoReceipt().text }] }
    const host = hostOf(s.endpoint)
    try {
      const models = await probeVoice(s.endpoint, VOICE_PROBE_MS)
      const lines = [{ mark: '✓', text: `语音服务 ${host} 已连上` }]
      lines.push(models.includes(s.model)
        ? { mark: '✓', text: `模型 ${s.modelAlias ?? s.model} 已加载` }
        : { mark: '', text: `模型 ${s.modelAlias ?? s.model} 尚未加载（第一次朗读时才会加载，可能要等一会儿）` })
      return { ok: true, lines }
    } catch (e) {
      const kind = e instanceof TtsError ? e.kind : 'other'
      rt.log.debug(`设置页测试语音连接失败（${kind}）：${redactUrls(e instanceof TtsError ? e.detail || e.message : (e as Error).message)}`)
      return { ok: false, lines: [{ mark: '✗', text: `${host}：${VOICE_TEST_FAIL[kind] ?? VOICE_TEST_FAIL.other}` }] }
    }
  }

  async function testImage(): Promise<TestResult> {
    try {
      const report = await checkImage()
      if (!report.configured) return { ok: false, lines: [{ mark: '✗', text: NOT_CONFIGURED_TEST }] }
      const lines = drawDoctorItems(report).map((i) => ({ mark: i.mark, text: i.url ? `${i.text}（下载地址 ${i.url}）` : i.text }))
      return { ok: drawDoctorIssues(report).length === 0, lines }
    } catch (e) {
      rt.log.warn(`设置页测试生图连接出错：${redactUrls((e as Error).message)}`)
      return { ok: false, lines: [{ mark: '✗', text: '连接测试出错，详情见日志。' }] }
    }
  }

  async function getState(): Promise<SettingsState> {
    const [form, workflows, voiceView, voiceCfg, imageCfg] = await Promise.all([
      readServicesForm(rt.servicesPath()), listWorkflows(), voiceStatus(), rt.voiceSettings(), loadImageService(rt.servicesPath()),
    ])
    const d = VOICE_SERVICE_DEFAULTS
    const i = IMAGE_SERVICE_DEFAULTS
    return {
      servicesPath: rt.servicesPath(),
      workflows,
      voice: { form: form.voice },
      image: { form: form.image },
      defaults: {
        voice: { launch: d.launch, model: d.model, modelsDir: defaultDir(), read: d.read, language: d.language, timeoutSeconds: d.timeoutSeconds },
        image: { workflow: i.workflow, auto: i.auto, style: i.style, width: i.width, height: i.height, steps: i.steps, timeoutSeconds: i.timeoutSeconds },
      },
      problems: { file: form.problems, voice: voiceCfg.problems, image: imageCfg.problems },
      voiceStatus: voiceView,
    }
  }

  return {
    getState,
    saveVoice: (form) => save('voice', (o) => parseVoiceForm(form, o)),
    saveImage: (form) => save('image', (o) => parseImageForm(form, o)),
    voiceStatus,
    voiceStart,
    voiceStop,
    testVoice,
    testImage,
  }
}
