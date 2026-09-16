// 手机端的外壳（计划 Task 11）：没连上就是连接页，连上了就是顶栏 + 四个标签。
// 工作台（Task 12）已经填上，其余三个标签的内容由 Task 13–17 往里填。
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MobileMeta } from '@shared/mobileApi'
import type { Workspace } from '@shared/workspace'
import { ApiFailure, createApiClient, normalizeBaseUrl, type ApiClient } from './api'
import Workbench from './pages/Workbench'
import { flushState, loadState, saveConnection, saveWorkspace, type Connection } from './state'

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

function messageOf(err: unknown): string {
  // ApiFailure 里的 message 是服务端给的、能直接显示的中文（Global Constraints）
  if (err instanceof ApiFailure) return err.error.message
  return err instanceof Error && err.message !== '' ? err.message : '出了点问题，稍后再试'
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

  // SSE 只在这里开一条，事件分发给各标签由后续任务接手；现在只用它点亮状态点
  useEffect(() => client.events(() => undefined, setOnline), [client])

  return (
    <div className="app">
      <header className="head">
        <span className={online ? 'dot' : 'dot off'} title={online ? '已连上电脑' : '和电脑断开了'} />
        <span className="title">{TABS.find((t) => t.key === tab)?.label}</span>
        <span className="grow" />
        {/* 额度位：由 Task 13 的 UsageLine 填上点数与 V5 用量 */}
        <span className="sec">额度 —</span>
      </header>
      <main className="body">
        {error !== null && <p className="alert">{error}</p>}
        <TabBody tab={tab} meta={meta} workspace={workspace} onWorkspaceChange={updateWorkspace} />
      </main>
      <nav className="tabs">
        {TABS.map((t) => (
          <button type="button" key={t.key} className={t.key === tab ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
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
