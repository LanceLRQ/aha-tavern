// 工作流文件：读取并校验随包或自带的 ComfyUI 接口格式工作流，按说明块填值，列出依赖。
// 不做网络请求；失败抛 Error，message 是可读的中文原因，不夹带文件内容。
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ImageServiceSettings } from './services'

export type ModelSlot = 'unet' | 'clip' | 'vae'
export type SlotName = 'prompt' | 'width' | 'height' | 'seed' | 'steps' | ModelSlot
type SlotRef = [node: string, input: string]
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export interface ModelNote {
  slot: ModelSlot
  dir?: string
  url?: string
}

/** 参考图能力：参考图交给哪个编码节点、用哪个 VAE 输出、最多几张。 */
export interface RefsSpec {
  encoder: string
  vae: [node: string, output: number]
  max: number
}

export interface Workflow {
  /** 内置名，或自带文件的路径。 */
  name: string
  /** 产出图片的节点编号。 */
  output: string
  slots: Partial<Record<SlotName, SlotRef>>
  notes: ModelNote[]
  /** 支持参考图时才有；缺失或写错都没有。 */
  refs?: RefsSpec
  /** 说明块里写了 refs 但不合法时的原因（中文短语，不含文件内容）；此时 refs 为空。 */
  refsProblem?: string
  /** 去掉说明块后的节点图。 */
  graph: Graph
}

export interface FillValues {
  prompt: string
  width?: number
  height?: number
  seed?: number
  steps?: number
  models?: ImageServiceSettings['models']
  /** 参考图的服务端文件名；超过 refs.max 的部分被丢弃，工作流不支持时忽略。 */
  refs?: string[]
}

export interface Requirements {
  nodeTypes: string[]
  models: Array<{ slot: ModelSlot; file: string; nodeType: string; input: string; dir?: string; url?: string }>
}

const SLOT_NAMES: readonly SlotName[] = ['prompt', 'width', 'height', 'seed', 'steps', 'unet', 'clip', 'vae']
const MODEL_SLOTS: readonly ModelSlot[] = ['unet', 'clip', 'vae']
const BUILTIN_NAME_RE = /^[\w.-]+$/

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export async function loadWorkflow(nameOrPath: string, builtinDir: string): Promise<Workflow> {
  const isPath = path.isAbsolute(nameOrPath)
  if (!isPath && !BUILTIN_NAME_RE.test(nameOrPath)) throw new Error(`工作流名不合法：${nameOrPath}`)
  const file = isPath ? nameOrPath : path.join(builtinDir, `${nameOrPath}.json`)

  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    throw new Error(
      (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? `工作流不存在：${nameOrPath}`
        : `工作流文件读不了：${nameOrPath}`,
    )
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error(`工作流文件不是合法的 JSON：${nameOrPath}`)
  }
  return validate(nameOrPath, doc)
}

function validate(name: string, doc: unknown): Workflow {
  if (!isRecord(doc)) throw new Error(`工作流顶层必须是对象：${name}`)
  const { _aha: aha, ...rest } = doc
  if (!isRecord(aha)) throw new Error(`工作流缺少 _aha 说明块：${name}`)
  for (const [id, node] of Object.entries(rest)) {
    if (!isRecord(node) || typeof node.class_type !== 'string' || node.class_type === '' || !isRecord(node.inputs)) {
      throw new Error(`工作流里节点 ${id} 的格式不对：${name}`)
    }
  }
  const graph = rest as Graph

  const rawSlots = aha.slots
  if (!isRecord(rawSlots) || rawSlots.prompt === undefined) throw new Error(`工作流缺少 slots.prompt：${name}`)

  const slots: Partial<Record<SlotName, SlotRef>> = {}
  for (const key of SLOT_NAMES) {
    const ref = rawSlots[key]
    if (ref === undefined) continue
    if (!Array.isArray(ref) || ref.length !== 2 || typeof ref[0] !== 'string' || typeof ref[1] !== 'string') {
      throw new Error(`slots.${key} 应是 [节点编号, 输入名]：${name}`)
    }
    const [node, input] = ref as SlotRef
    const target = graph[node]
    if (!isRecord(target)) throw new Error(`slots.${key} 指向不存在的节点 ${node}：${name}`)
    if (!isRecord(target.inputs) || !(input in target.inputs)) {
      throw new Error(`slots.${key} 指向不存在的输入 ${node}.${input}：${name}`)
    }
    slots[key] = [node, input]
  }

  if (typeof aha.output !== 'string' || aha.output === '') throw new Error(`工作流缺少 output：${name}`)
  if (!isRecord(graph[aha.output])) throw new Error(`output 指向不存在的节点 ${aha.output}：${name}`)

  const notes: ModelNote[] = []
  if (Array.isArray(aha.models)) {
    for (const m of aha.models) {
      if (!isRecord(m) || !MODEL_SLOTS.includes(m.slot as ModelSlot)) continue
      notes.push({
        slot: m.slot as ModelSlot,
        ...(typeof m.dir === 'string' ? { dir: m.dir } : {}),
        ...(typeof m.url === 'string' ? { url: m.url } : {}),
      })
    }
  }
  const wf: Workflow = { name, output: aha.output, slots, notes, graph }
  if (aha.refs !== undefined) {
    const parsed = parseRefs(aha.refs, graph)
    if (typeof parsed === 'string') wf.refsProblem = parsed
    else wf.refs = parsed
  }
  return wf
}

const REFS_MAX_LIMIT = 16

/** 校验 _aha.refs；合法返回规格，否则返回原因。 */
function parseRefs(raw: unknown, graph: Graph): RefsSpec | string {
  if (!isRecord(raw)) return 'refs 应是对象'
  if (typeof raw.encoder !== 'string' || !isRecord(graph[raw.encoder])) return 'refs.encoder 没有指向存在的节点'
  const vae = raw.vae
  if (!Array.isArray(vae) || vae.length !== 2 || typeof vae[0] !== 'string' || !Number.isInteger(vae[1]) || (vae[1] as number) < 0) {
    return 'refs.vae 应是 [节点编号, 输出序号]'
  }
  if (!isRecord(graph[vae[0]])) return 'refs.vae 指向不存在的节点'
  const max = raw.max === undefined ? REFS_MAX_LIMIT : raw.max
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > REFS_MAX_LIMIT) {
    return `refs.max 应是 1 到 ${REFS_MAX_LIMIT} 的整数`
  }
  return { encoder: raw.encoder, vae: [vae[0], vae[1] as number], max }
}

/** 带这些参考图提交时实际会用几张（受 refs.max 限制；工作流不支持为 0）。 */
export function refsUsed(wf: Workflow, refs: string[] | undefined): number {
  return wf.refs && refs ? Math.min(refs.length, wf.refs.max) : 0
}

/** 带参考图时额外需要的节点类型，以及编码节点的类型；工作流不支持参考图返回 undefined。 */
export function refsRequirementsOf(wf: Workflow): { nodeTypes: string[]; encoderType: string } | undefined {
  if (!wf.refs) return undefined
  return { nodeTypes: ['LoadImage'], encoderType: wf.graph[wf.refs.encoder]!.class_type }
}

/** 深拷贝后按位置填值，返回可提交的图（不含 _aha）；没有对应位置的值跳过。 */
export function fillWorkflow(wf: Workflow, values: FillValues): Graph {
  const graph = structuredClone(wf.graph)
  const set = (slot: SlotName, value: unknown): void => {
    const ref = wf.slots[slot]
    const node = ref && graph[ref[0]]
    if (ref && node && value !== undefined) node.inputs[ref[1]] = value
  }
  set('prompt', values.prompt)
  set('width', values.width)
  set('height', values.height)
  set('seed', values.seed)
  set('steps', values.steps)
  for (const slot of MODEL_SLOTS) set(slot, values.models?.[slot])
  addRefs(wf, graph, values.refs)
  return graph
}

/** 给编码节点接上参考图：每张一个 LoadImage 节点；列表为空或不支持时什么都不做。 */
function addRefs(wf: Workflow, graph: Graph, refs: string[] | undefined): void {
  const count = refsUsed(wf, refs)
  const spec = wf.refs
  const encoder = spec && graph[spec.encoder]
  if (!spec || !encoder || !refs || count === 0) return
  delete encoder.inputs.images
  for (let i = 1; i <= count; i++) {
    const base = `aha_ref_${i}`
    let id = base
    for (let k = 2; id in graph; k++) id = `${base}_${k}`
    graph[id] = { class_type: 'LoadImage', inputs: { image: refs[i - 1] } }
    // 键名里的点是键的一部分，不是嵌套
    encoder.inputs[`images.image_${i}`] = [id, 0]
  }
  encoder.inputs.vae = [...spec.vae]
}

/** 用到的节点类型（去重），以及每个模型位置最终的文件名与出处。 */
export function requirementsOf(wf: Workflow, values: Pick<FillValues, 'models'>): Requirements {
  const graph = fillWorkflow(wf, { prompt: '', models: values.models })
  const nodeTypes = [...new Set(Object.values(graph).map((n) => n.class_type))]
  const models: Requirements['models'] = []
  for (const slot of MODEL_SLOTS) {
    const ref = wf.slots[slot]
    if (!ref) continue
    const node = graph[ref[0]]
    const file = node?.inputs[ref[1]]
    if (!node || typeof file !== 'string') continue
    const note = wf.notes.find((n) => n.slot === slot)
    models.push({
      slot,
      file,
      nodeType: node.class_type,
      input: ref[1],
      ...(note?.dir ? { dir: note.dir } : {}),
      ...(note?.url ? { url: note.url } : {}),
    })
  }
  return { nodeTypes, models }
}
