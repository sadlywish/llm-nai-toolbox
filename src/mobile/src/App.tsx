// 手机端的外壳（计划 Task 11）：没连上就是连接页，连上了就是顶栏 + 四个标签。
// 工作台（Task 12）、参数（Task 13）、指令区与 LLM 日志（Task 14）已经填上，
// 出图 / 历史 / 画风三个标签由 Task 15–17 往里填。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MobileMeta } from '@shared/mobileApi'
import type { StylePreset } from '@shared/styles'
import type { Workspace } from '@shared/workspace'
import { createApiClient, messageOf, normalizeBaseUrl, type ApiClient } from './api'
import Console from './components/Console'
import UsageLine from './components/UsageLine'
import { statusTitle } from './llmPending'
import LlmLog from './pages/LlmLog'
import Params from './pages/Params'
import Workbench from './pages/Workbench'
import { flushState, loadState, saveConnection, saveWorkspace, type Connection } from './state'
import { useLlmRun } from './useLlmRun'

/** 令牌失效时给用户的那句话。桌面端「吊销」与换设备表都会走到这里 */
const REVOKED_MESSAGE = '这台手机已被吊销或令牌失效，请重新配对'

/**
 * 配对时报给桌面端的设备名，显示在设置页的已配对列表里。
 * 从 UA 里猜一个型号，猜不出就叫「手机」——桌面端那边只是给人看的，猜错了也不影响功能。
 */
function guessDeviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/iPad/i.test(ua)) return 'iPad'
  if (/iPhone/i.test(ua)) return 'iPhone'
  const android = /Android[^;]*;\s*([^;)]+)/i.exec(ua)
  if (android !== null) {
    // UA 里型号后面常跟着 `Build/xxx`，那串对人没有意义
    const model = android[1].replace(/Build\/.*$/i, '').trim()
    if (model !== '') return model
  }
  return '手机'
}

/** 这个页面就是桌面端服务发出来的，同源地址十有八九就是对的（Capacitor 壳里不是 http，那时留空让用户自己填） */
function defaultAddress(): string {
  const origin = typeof location === 'undefined' ? '' : location.origin
  return /^https?:/i.test(origin) ? origin : ''
}

/** 扫码打开的链接带着 `?code=`，配对码自动填好，用户直接点连接（界面稿第一节） */
function codeFromUrl(): string {
  if (typeof location === 'undefined') return ''
  try {
    return new URLSearchParams(location.search).get('code') ?? ''
  } catch {
    return ''
  }
}

function ConnectPage({
  notice,
  onConnected,
}: {
  notice: string | null
  onConnected: (c: Connection) => void
}): JSX.Element {
  const [address, setAddress] = useState(defaultAddress)
  const [code, setCode] = useState(codeFromUrl)
  const [pairing, setPairing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const base = normalizeBaseUrl(address)
  const ready = base !== '' && code.trim() !== '' && !pairing

  const connect = async (): Promise<void> => {
    setPairing(true)
    setError(null)
    try {
      // 配对是拿令牌的唯一入口，这时候还没有令牌可带，所以用一个空令牌的客户端；
      // 也不给它 onUnauthorized——配对码打错同样是 401，那不是「令牌失效」
      const paired = await createApiClient(base, '').pair(code.trim(), guessDeviceName())
      const connection: Connection = { baseUrl: base, token: paired.token }
      saveConnection(connection)
      onConnected(connection)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setPairing(false)
    }
  }

  return (
    <div className="app">
      <header className="head">
        <span className="dot off" />
        <span className="title">连接桌面端</span>
      </header>
      <main className="body connect">
        {notice !== null && <p className="alert">{notice}</p>}
        <label className="field">
          <span>地址</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="http://192.168.1.8:7321"
          />
        </label>
        <label className="field">
          <span>配对码</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            placeholder="4821"
          />
        </label>
        <button type="button" className="btn pri" disabled={!ready} onClick={() => void connect()}>
          {pairing ? '连接中…' : '连接'}
        </button>
        {error !== null && <p className="alert">{error}</p>}
        <p className="hint">扫码打开的链接会自动填好这两项，直接点连接。手机要和电脑连同一个 WiFi。</p>
      </main>
    </div>
  )
}

type TabKey = 'workbench' | 'gen' | 'history' | 'styles'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'workbench', label: '工作台' },
  { key: 'gen', label: '出图' },
  { key: 'history', label: '历史' },
  { key: 'styles', label: '画风' },
]

/** 四个标签的内容。还没做的那几个留一句占位，写清楚谁负责填 */
function TabBody({
  tab,
  meta,
  workspace,
  onWorkspaceChange,
}: {
  tab: TabKey
  meta: MobileMeta | null
  workspace: Workspace
  onWorkspaceChange: (update: (w: Workspace) => Workspace) => void
}): JSX.Element {
  if (tab === 'workbench') return <Workbench workspace={workspace} meta={meta} onChange={onWorkspaceChange} />
  if (tab === 'gen') return <p className="hint">参数、进度与结果网格在这里。</p>
  if (tab === 'history') return <p className="hint">轮次列表与那一轮的图在这里。</p>
  return <p className="hint">画风列表与增删改在这里。</p>
}

function Shell({ connection, onRevoked }: { connection: Connection; onRevoked: () => void }): JSX.Element {
  const [tab, setTab] = useState<TabKey>('workbench')
  const [meta, setMeta] = useState<MobileMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [online, setOnline] = useState(false)
  // 参数页盖在标签内容上而不是新开一个标签：它不是「看什么」的第五个分类，是随时可能要改的
  // 一份设置，从哪个标签进都该能开、关了还回到原来那个标签（界面稿：工作台右上角进入）
  const [paramsOpen, setParamsOpen] = useState(false)
  // LLM 日志页同理盖在标签内容上：它只属于「刚发出去的那一轮」，不是第五个标签
  const [logOpen, setLogOpen] = useState(false)
  /** 回填成功后那句绿色的「已回填: …」，点一下消掉 */
  const [notice, setNotice] = useState<string | null>(null)
  /** 共用的画风列表（`GET /api/styles`）；null = 还没拉到 */
  const [presets, setPresets] = useState<StylePreset[] | null>(null)
  // 手机自己那一份工作区（规格 §4）。只存在手机本地，不走任何写桌面端工作区的接口
  const [workspace, setWorkspace] = useState(() => loadState().workspace)

  // 存盘统一放在这里而不是每个改动点各存一次：saveWorkspace 自带 300ms 防抖，
  // 打字时连着改也只写一次；漏一个改动点的表现是「这一格改完刷新就没了」
  useEffect(() => saveWorkspace(workspace), [workspace])

  const updateWorkspace = useCallback((update: (w: Workspace) => Workspace) => setWorkspace(update), [])

  const client: ApiClient = useMemo(
    () => createApiClient(connection.baseUrl, connection.token, onRevoked),
    [connection.baseUrl, connection.token, onRevoked],
  )

  useEffect(() => {
    let alive = true
    client
      .meta()
      .then((m) => {
        if (alive) {
          setMeta(m)
          setError(null)
        }
      })
      // 401 已经由 onRevoked 接管（整个 Shell 会被换掉），这里只管剩下的那些失败
      .catch((err: unknown) => {
        if (alive) setError(messageOf(err))
      })
    return () => {
      alive = false
    }
  }, [client])

  const handleFilled = useCallback((summary: string) => {
    // 回填成功就回工作台：接下来要看的是那十个块，不是日志（同桌面端「回填后收起抽屉」）。
    // 「回填后自动生成」的接点也在这里：Task 15 接上出图之后，按回填之后的工作区与跑图次数开跑
    setLogOpen(false)
    setParamsOpen(false)
    setTab('workbench')
    setNotice(summary)
  }, [])

  const llm = useLlmRun({ client, update: updateWorkspace, onFilled: handleFilled, api: meta?.llm ?? null })

  // 订阅整个连接期间只挂一条，所以回调里走 ref 读最新的那份 hook；
  // 把 llm.handleEvent 直接写进依赖会让 SSE 在每次状态变化时重连一次
  const llmRef = useRef(llm)
  llmRef.current = llm
  const onlineRef = useRef(false)

  // SSE 只在这里开一条：LLM 的日志与结局分给 useLlmRun，顺带点亮状态点
  useEffect(
    () =>
      client.events(
        (e) => llmRef.current.handleEvent(e),
        (up) => {
          setOnline(up)
          // 断线补偿之二：重连的那一刻查一次断线期间跑完的那一轮（锁屏、切后台都会把 SSE 断掉）
          if (up && !onlineRef.current) llmRef.current.checkLast()
          onlineRef.current = up
        },
      ),
    [client],
  )

  // 画风列表：进工作台时拉一次（指令区的预设档要用），从画风标签改完切回来也会再拉一次。
  // 预设本身是电脑与手机共用的那一条（Global Constraints：画风共用），以电脑那份为准
  useEffect(() => {
    if (tab !== 'workbench') return
    let alive = true
    client
      .styles()
      .then((r) => {
        if (!alive) return
        setPresets(r.styles)
        // 共用的预设选择同步进手机这份工作区，指令区的 currentPresetOf 才认得出是哪一条
        updateWorkspace((w) => (w.console.presetId === r.presetId ? w : { ...w, console: { ...w.console, presetId: r.presetId } }))
      })
      // 拉不到就先不显示预设名（预设档会退回不覆盖），不打断正在编辑的人
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [client, tab, updateWorkspace])

  const send = (): void => {
    setNotice(null)
    setParamsOpen(false)
    // 发送即进日志页（同桌面端「发送即打开抽屉」）：这一轮要跑几十秒，得让人看见它在动
    setLogOpen(true)
    llm.send(workspace, presets ?? [])
  }

  const openLog = (): void => {
    setParamsOpen(false)
    setLogOpen(true)
  }

  const currentTabLabel = TABS.find((t) => t.key === tab)?.label
  const overlay = paramsOpen || logOpen

  return (
    <div className="app">
      <header className="head">
        <span className={online ? 'dot' : 'dot off'} title={online ? '已连上电脑' : '和电脑断开了'} />
        <span className="title">{paramsOpen ? '参数' : logOpen ? statusTitle(llm.phase) || 'LLM 日志' : currentTabLabel}</span>
        <span className="grow" />
        {/* 日志页右上角是「中止」（界面稿第三节），别的时候是参数入口 */}
        {logOpen ? (
          llm.running && (
            <button type="button" className="btn sm danger" onClick={llm.abort}>
              中止
            </button>
          )
        ) : (
          <button type="button" className="btn sm" disabled={paramsOpen} onClick={() => setParamsOpen(true)}>
            参数
          </button>
        )}
      </header>
      {/* 独立一行而不是塞进 .head：额度那句话（点数 · V5 用量 · 恢复速率）在窄屏上和
          标题、按钮挤在同一行放不下，换行的话标题会被顶飞 */}
      <div className="usage-bar">
        {/* refreshSignal 先不传：出图结束后刷新是 Task 15 接出图页时的事，那时候
            只需给这里加一个「每次出图完成就变一次」的值，这个组件不用再改 */}
        <UsageLine client={client} percentPerImage={meta?.usagePercentPerImage ?? 0} />
      </div>
      <main className="body">
        {error !== null && <p className="alert">{error}</p>}
        {!overlay && notice !== null && (
          // 回填结果一行绿字。做成按钮是为了点一下就能消掉——手机上没有别的地方放「关闭」
          <button type="button" className="notice" onClick={() => setNotice(null)}>
            {notice}
          </button>
        )}
        {logOpen ? (
          <LlmLog phase={llm.phase} lines={llm.lines} />
        ) : paramsOpen ? (
          <Params workspace={workspace} meta={meta} onChange={updateWorkspace} />
        ) : (
          <TabBody tab={tab} meta={meta} workspace={workspace} onWorkspaceChange={updateWorkspace} />
        )}
      </main>
      {!overlay && tab === 'workbench' && (
        <Console
          workspace={workspace}
          presets={presets}
          running={llm.running}
          hasLog={llm.hasLog}
          onChange={updateWorkspace}
          onSend={send}
          onOpenLog={openLog}
          onOpenStyles={() => setTab('styles')}
        />
      )}
      <nav className="tabs">
        {overlay ? (
          <button type="button" className="on" onClick={() => (logOpen ? setLogOpen(false) : setParamsOpen(false))}>
            ‹ 返回{currentTabLabel}
          </button>
        ) : (
          TABS.map((t) => (
            <button type="button" key={t.key} className={t.key === tab ? 'on' : ''} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))
        )}
      </nav>
    </div>
  )
}

export default function App(): JSX.Element {
  const [connection, setConnection] = useState<Connection | null>(() => loadState().connection)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    // 手机上「关页面」多半是切后台之后被系统回收，unload 不一定跑得到，pagehide 才是稳的那个
    const onHide = (): void => flushState()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  const handleRevoked = useCallback(() => {
    saveConnection(null)
    setConnection(null)
    setNotice(REVOKED_MESSAGE)
  }, [])

  const handleConnected = useCallback((c: Connection) => {
    setNotice(null)
    setConnection(c)
  }, [])

  if (connection === null) return <ConnectPage notice={notice} onConnected={handleConnected} />
  // key 用令牌：重新配对之后整个外壳重来一遍，免得上一份连接的 meta 与 SSE 状态留在界面上
  return <Shell key={connection.token} connection={connection} onRevoked={handleRevoked} />
}
