import { describe, expect, it } from 'vitest'
import { applyRoundToWorkspace } from '../../src/shared/copyInfo'
import { takeSnapshot } from '../../src/main/gen/snapshot'
import {
  attachLlm,
  contentFingerprint,
  normalizeWorkspaceLlm,
  readSnapshotLlm,
  snapshotLlmOf,
  type LlmRequestInfo,
} from '../../src/shared/llmProvenance'
import { createCharacter, emptyWorkspace, normalizeWorkspace, type GenParams, type Workspace } from '../../src/shared/workspace'

const request: LlmRequestInfo = {
  apiType: 'claude',
  model: 'claude-opus-4-8',
  instruction: '海边的少女，夕阳',
  multiCharacter: 'auto',
  editExisting: false,
  transparent: false,
  styleMode: 'preset',
  presetName: '厚涂光影',
  autoGenerate: true,
  llmRounds: 3,
  elapsedMs: 31_000,
}

function filledWorkspace(): Workspace {
  const ws = emptyWorkspace()
  ws.main.count = '1girl'
  ws.main.artist = 'artist:wlop'
  ws.negative = 'lowres'
  const c = createCharacter()
  c.fields.character = 'miku'
  ws.characters = [c]
  attachLlm(ws, request, false)
  return ws
}

describe('contentFingerprint：哪些改动算手改', () => {
  const edits: Array<[string, (ws: Workspace) => void]> = [
    ['整图字段', (ws) => (ws.main.tags = 'smile')],
    ['画面文字', (ws) => (ws.text = 'Hello')],
    ['负面词', (ws) => (ws.negative = 'bad hands')],
    ['角色字段', (ws) => (ws.characters[0].fields.tags = 'waving')],
    ['角色负面词', (ws) => (ws.characters[0].negative = 'extra fingers')],
    ['角色坐标', (ws) => (ws.characters[0].position = 'B3')],
    ['角色是否参与', (ws) => (ws.characters[0].enabled = false)],
    ['增删角色', (ws) => ws.characters.push(createCharacter())],
    ['使用坐标定位', (ws) => (ws.useCoords = !ws.useCoords)],
    ['宽', (ws) => (ws.params.width = 832)],
    ['步数', (ws) => (ws.params.steps = 23)],
    ['seed 模式', (ws) => (ws.params.seedMode = 'fixed')],
    ['透明背景参数', (ws) => (ws.params.transparentBackground = true)],
  ]
  for (const [name, edit] of edits) {
    it(`改${name} → 指纹变`, () => {
      const ws = filledWorkspace()
      const before = contentFingerprint(ws)
      edit(ws)
      expect(contentFingerprint(ws)).not.toBe(before)
    })
  }

  it('seed、跑图次数、指令区、角色 id 不算：出图后回写 seed 不能被当成手改', () => {
    const ws = filledWorkspace()
    const before = contentFingerprint(ws)
    ws.params.seed = 123456
    ws.runCount = 8
    ws.console.instruction = '换一句指令'
    ws.console.autoGenerate = false
    ws.characters[0].id = 'ch-other'
    expect(contentFingerprint(ws)).toBe(before)
  })

  it('与对象键的先后无关；工作区存盘读回后来源原样保留', () => {
    const ws = filledWorkspace()
    const reordered: Workspace = {
      ...ws,
      main: Object.fromEntries(Object.entries(ws.main).reverse()),
      params: Object.fromEntries(Object.entries(ws.params).reverse()) as GenParams,
    }
    expect(contentFingerprint(reordered)).toBe(contentFingerprint(ws))
    const reloaded = normalizeWorkspace(JSON.parse(JSON.stringify(ws)))
    expect(reloaded.llm).toEqual(ws.llm)
    expect(snapshotLlmOf(reloaded)).toEqual({ request, stale: false })
  })
})

describe('snapshotLlmOf', () => {
  it('没经过 LLM 的工作区 → null', () => {
    expect(snapshotLlmOf(emptyWorkspace())).toBeNull()
  })

  it('回填后直接生成 → 不是手改', () => {
    expect(snapshotLlmOf(filledWorkspace())).toEqual({ request, stale: false })
  })

  it('回填后改过内容 → 手改过；改回原样 → 又不算', () => {
    const ws = filledWorkspace()
    ws.main.tags = 'smile'
    expect(snapshotLlmOf(ws)?.stale).toBe(true)
    ws.main.tags = ''
    expect(snapshotLlmOf(ws)?.stale).toBe(false)
  })

  it('带进来时就已标手改过的，内容没动也仍是手改过', () => {
    const ws = emptyWorkspace()
    attachLlm(ws, request, true)
    expect(snapshotLlmOf(ws)?.stale).toBe(true)
  })

  it('takeSnapshot 把来源写进快照，固定 seed 换值不影响手改判断', () => {
    const ws = filledWorkspace()
    ws.params.seedMode = 'fixed'
    ws.params.seed = -1
    attachLlm(ws, request, false)
    const s = takeSnapshot(ws, 2961054388)
    expect(s.params.seed).toBe(2961054388)
    expect(s.llm).toEqual({ request, stale: false })
    expect(takeSnapshot(emptyWorkspace(), null).llm).toBeNull()
  })
})

describe('读回的形状', () => {
  it('readSnapshotLlm：没有这个键是旧记录（undefined），null 是确定没经过 LLM', () => {
    expect(readSnapshotLlm(undefined)).toBeUndefined()
    expect(readSnapshotLlm(null)).toBeNull()
    expect(readSnapshotLlm({ request, stale: true })).toEqual({ request, stale: true })
  })

  it('readSnapshotLlm：形状不对按说不清处理（undefined），不当成「没经过」', () => {
    expect(readSnapshotLlm({ request: { ...request, multiCharacter: 'many' }, stale: false })).toBeUndefined()
    expect(readSnapshotLlm({ request, stale: 'no' })).toBeUndefined()
    expect(readSnapshotLlm('x')).toBeUndefined()
  })

  it('normalizeWorkspaceLlm：合法的原样保留，缺项或类型不对一律丢弃', () => {
    const ok = { request, fingerprint: 'fp', stale: false }
    expect(normalizeWorkspaceLlm(ok)).toEqual(ok)
    expect(normalizeWorkspaceLlm({ ...ok, fingerprint: 1 })).toBeNull()
    expect(normalizeWorkspaceLlm({ ...ok, request: { ...request, llmRounds: -1 } })).toBeNull()
    expect(normalizeWorkspaceLlm({ ...ok, request: { ...request, apiType: 'gemini' } })).toBeNull()
    expect(normalizeWorkspaceLlm(undefined)).toBeNull()
    expect(normalizeWorkspace({}).llm).toBeNull()
  })
})

describe('复制信息带上来源', () => {
  it('LLM 来源跟着内容带过来，指纹按复制之后的内容算：紧接着生成不算手改', () => {
    const src = filledWorkspace()
    const snapshot = takeSnapshot(src, null)
    const ws = emptyWorkspace()
    applyRoundToWorkspace(ws, snapshot, 42)
    expect(ws.llm?.request).toEqual(request)
    expect(snapshotLlmOf(ws)).toEqual({ request, stale: false })
    ws.negative = 'changed'
    expect(snapshotLlmOf(ws)?.stale).toBe(true)
  })

  it('已经手改过的记录复制过来仍标手改过', () => {
    const src = filledWorkspace()
    src.main.tags = 'edited'
    const ws = emptyWorkspace()
    applyRoundToWorkspace(ws, takeSnapshot(src, null), 42)
    expect(snapshotLlmOf(ws)?.stale).toBe(true)
  })

  it('纯手工与旧记录清掉工作区原有的来源', () => {
    const manual = takeSnapshot(emptyWorkspace(), null)
    const ws = filledWorkspace()
    applyRoundToWorkspace(ws, manual, 1)
    expect(ws.llm).toBeNull()

    const legacy = { ...takeSnapshot(emptyWorkspace(), null) }
    delete legacy.llm
    const ws2 = filledWorkspace()
    applyRoundToWorkspace(ws2, legacy, 1)
    expect(ws2.llm).toBeNull()
  })
})
