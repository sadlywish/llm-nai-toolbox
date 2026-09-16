import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import QRCode from 'qrcode'
import {
  API_TYPES,
  IMAGE_FORMATS,
  OPENAI_REASONING_DIALECTS,
  OPENAI_REASONING_EFFORTS,
  RESTORABLE_KEYS,
  THINKING_EFFORTS,
  THINKING_FORMATS,
  defaultAppConfig,
  validateConfig,
  type AppConfig,
  type NumericKey,
  type OpenAIReasoningDialect,
  type OpenAIReasoningEffort,
} from '@shared/config'
import type { MobileStatus } from '@shared/ipc'
import { PIXEL_PRESETS, pixelPresetOf } from '@shared/naiOptions'
import { formatRoundTime } from '../formatTime'
import { useConfig } from '../state/config'
import { isSettingsDirty, numericTextFrom, type NumericText } from '../settingsDraft'
import AutoTextarea from './AutoTextarea'

const MANUAL_PIXELS = 'manual'
/** 保存成功后「已保存」在保存栏停留多久 */
const SAVED_NOTICE_MS = 2000

type BooleanKey = { [K in keyof AppConfig]: AppConfig[K] extends boolean ? K : never }[keyof AppConfig]
type StringKey = { [K in keyof AppConfig]: AppConfig[K] extends string ? K : never }[keyof AppConfig]

/** 「恢复默认」按钮该不该出现，唯一依据是 RESTORABLE_KEYS——不要在各字段调用处各判一遍 */
function isRestorable(key: keyof AppConfig): key is StringKey {
  return (RESTORABLE_KEYS as readonly string[]).includes(key)
}

const API_TYPE_LABELS: Record<AppConfig['apiType'], string> = { claude: 'Claude', openai: 'OpenAI 兼容' }
const THINKING_FORMAT_LABELS: Record<AppConfig['thinkingFormat'], string> = {
  adaptive: 'adaptive（按力度）',
  budget: 'budget（按预算）',
}
const OPENAI_DIALECT_LABELS: Record<OpenAIReasoningDialect, string> = {
  reasoning_effort: 'reasoning_effort（OpenAI / Gemini / xAI / vLLM）',
  reasoning_object: 'reasoning 对象（OpenRouter）',
  thinking_object: 'thinking 对象（DeepSeek / 智谱 / Kimi）',
  enable_thinking: 'enable_thinking（通义千问）',
}

/** 可折叠的一组。设置页常驻挂载，展开状态切标签时保留；重启应用回到默认 */
function Group({
  title,
  summary,
  defaultOpen = true,
  children,
}: {
  title: string
  summary?: string
  defaultOpen?: boolean
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`settings-group ${open ? '' : 'is-closed'}`}>
      <button type="button" className="settings-group-head" onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <span className="settings-group-summary">
          {summary !== undefined ? `${summary} ` : ''}
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && <div className="settings-group-body">{children}</div>}
    </section>
  )
}

interface Props {
  /** 当前是不是在「设置」标签。不在时整页隐藏但不卸载：没保存的草稿、分组展开状态都得留着 */
  active: boolean
  /** 有无未保存修改变化时通知 App，给顶栏「设置」标签挂黄点 */
  onDirtyChange: (dirty: boolean) => void
}

/** 手机端服务状态多久刷新一次：不需要实时，几秒钟发现设备变化或服务起停就够用 */
const MOBILE_POLL_MS = 4000

/** 配对码剩余时间，mm:ss；已过期显示 0:00（下一次刷新会把 code 换成 null，界面转去显示「生成中」） */
function formatRemainingMs(expiresAt: number, now: number): string {
  const totalSec = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`
}

/**
 * 手机端分组的服务状态：轮询 + 换码 / 吊销。这份状态与设置草稿无关——它读的是
 * 服务的当前实况，不是「保存后会变成什么样」，所以单独一个 hook 而不是塞进 draft。
 */
function useMobileStatus(active: boolean): {
  status: MobileStatus | null
  refreshCode: () => void
  revoke: (deviceId: string) => void
} {
  const [status, setStatus] = useState<MobileStatus | null>(null)

  useEffect(() => {
    // 不在设置标签时不必轮询：省一份定时器，也省一次跨进程调用
    if (!active) return
    let cancelled = false
    const load = (): void => {
      void window.api.mobileStatus().then((s) => {
        if (!cancelled) setStatus(s)
      })
    }
    load()
    const timer = setInterval(load, MOBILE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [active])

  useEffect(() => {
    // 服务在跑但配对码没有或已经过期：自动续一个。界面不该在用户第一次点开这个
    // 分组时空等一次手动点击才出现二维码——配对码本就是一次性的，续不续都不影响安全性
    if (status === null || !status.running) return
    if (status.code !== null && status.codeExpiresAt !== null && status.codeExpiresAt > Date.now()) return
    void window.api.mobileNewCode().then(setStatus)
  }, [status])

  return {
    status,
    refreshCode: () => void window.api.mobileNewCode().then(setStatus),
    revoke: (deviceId) => void window.api.mobileRevoke(deviceId).then(setStatus),
  }
}

/**
 * 设置页：顶栏与「工作台」「画风维护」并排的第三个标签（界面稿 2026-09-15-settings-tab-mockup.html，方案 A）。
 * 单列居中，分组照原来的抽屉；保存栏钉在页底，切走标签草稿不丢。
 */
export default function SettingsPage({ active, onDirtyChange }: Props): JSX.Element {
  const config = useConfig((s) => s.config)
  const loaded = useConfig((s) => s.loaded)
  const hasLlmApiKey = useConfig((s) => s.hasLlmApiKey)
  const hasNaiToken = useConfig((s) => s.hasNaiToken)
  const hasDanbooruApiKey = useConfig((s) => s.hasDanbooruApiKey)
  const configExists = useConfig((s) => s.configExists)
  const saveError = useConfig((s) => s.saveError)
  const save = useConfig((s) => s.save)
  const dismissSaveError = useConfig((s) => s.dismissSaveError)

  const [draft, setDraft] = useState<AppConfig>(config)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [naiTokenInput, setNaiTokenInput] = useState('')
  const [danbooruKeyInput, setDanbooruKeyInput] = useState('')
  const [numericText, setNumericText] = useState<NumericText>(() => numericTextFrom(config))
  const [saving, setSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)

  const mobile = useMobileStatus(active)
  const [mobileQr, setMobileQr] = useState<string | null>(null)
  const mobileFirstUrl = mobile.status?.running === true ? mobile.status.urls[0] : undefined
  const mobileCode = mobile.status?.running === true ? mobile.status.code : null
  useEffect(() => {
    if (mobileFirstUrl === undefined || mobileCode === null) {
      setMobileQr(null)
      return
    }
    let cancelled = false
    // 内容是「地址 + 配对码」：手机扫码即可跳过手输那两项（同界面稿「连接桌面端」页的提示）
    void QRCode.toDataURL(`${mobileFirstUrl}/?code=${mobileCode}`)
      .then((data) => {
        if (!cancelled) setMobileQr(data)
      })
      .catch(() => {
        if (!cancelled) setMobileQr(null)
      })
    return () => {
      cancelled = true
    }
  }, [mobileFirstUrl, mobileCode])

  // 配对码剩余时间要每秒跳一下；没有有效配对码时没必要开这个定时器
  const [mobileNow, setMobileNow] = useState(() => Date.now())
  const mobileCodeExpiresAt = mobile.status?.running === true ? mobile.status.codeExpiresAt : null
  useEffect(() => {
    if (mobileCodeExpiresAt === null) return
    const timer = setInterval(() => setMobileNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [mobileCodeExpiresAt])

  /** 草稿、数值原文、三个密钥框全部回到已保存的样子 */
  function resetDraft(): void {
    setDraft(config)
    setApiKeyInput('')
    setNaiTokenInput('')
    setDanbooruKeyInput('')
    setNumericText(numericTextFrom(config))
    dismissSaveError()
  }

  useEffect(() => {
    // 必须等 loaded 才重置草稿：配置还没读回来就用默认值初始化草稿，
    // 随手一保存就把已存配置覆盖了。设置页常驻挂载，这条只在 loaded 变 true 时跑一次。
    if (!loaded) return
    resetDraft()
    // 只在「已载入」这一刻取快照；config 若进依赖数组，编辑期间
    // 每次按键触发的重渲染都会被这条 effect 用旧值把草稿冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  // 配置没读回来之前草稿是默认值，不算「改过」
  const dirty =
    loaded &&
    isSettingsDirty({ draft, numericText, secrets: [apiKeyInput, naiTokenInput, danbooruKeyInput] }, config)

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (!savedNotice) return
    const timer = setTimeout(() => setSavedNotice(false), SAVED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [savedNotice])

  function set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function setNumber(key: NumericKey, raw: string): void {
    setNumericText((t) => ({ ...t, [key]: raw }))
    const text = raw.trim()
    const n = Number(text)
    // 解析不了就不写回草稿：保留上一个合法值，同时下面的错误提示让用户看见自己填错了
    if (text !== '' && Number.isFinite(n)) set(key, n)
  }

  function restore(key: StringKey): void {
    // 立即替换，不弹确认（规格 §14.2）：改的是草稿，不保存或点「撤销修改」就回去了
    set(key, defaultAppConfig()[key])
  }

  const errors: Partial<Record<keyof AppConfig, string>> = validateConfig(draft)
  for (const key of Object.keys(numericText) as NumericKey[]) {
    const text = numericText[key].trim()
    if (text === '' || !Number.isFinite(Number(text))) errors[key] = '请输入数字'
  }
  const hasErrors = Object.keys(errors).length > 0

  const openaiUsesBudget = draft.openaiReasoningDialect === 'reasoning_object' || draft.openaiReasoningDialect === 'enable_thinking'
  // thinking 对象只发 {type: enabled}（智谱、Kimi 不认力度字段）；enable_thinking 是开关加预算；
  // OpenRouter 的 effort 与 max_tokens 二选一，填了预算就不再发力度
  const openaiEffortDisabled =
    draft.openaiReasoningDialect === 'thinking_object' ||
    draft.openaiReasoningDialect === 'enable_thinking' ||
    (draft.openaiReasoningDialect === 'reasoning_object' && draft.openaiReasoningBudget > 0)

  function setThinkingFormat(value: AppConfig['thinkingFormat']): void {
    // 预算 token 框在非 budget 格式下会置灰（见下面 numberField 的 disabled）。
    // 一个置灰、用户碰不到的框不能继续攥着一个非法值挡住保存，所以切走 budget
    // 时把草稿和原文本都退回上次保存的值——那个值必然是校验通过的
    if (value !== 'budget' && errors.thinkingBudgetTokens !== undefined) {
      setNumericText((t) => ({ ...t, thinkingBudgetTokens: String(config.thinkingBudgetTokens) }))
      set('thinkingBudgetTokens', config.thinkingBudgetTokens)
    }
    set('thinkingFormat', value)
  }

  function setApiType(value: AppConfig['apiType']): void {
    // 切换接口类型后，另一种接口专属的输入框会被藏起来。藏起来的框不能攥着一个非法值
    // 挡住保存（用户已经看不见它了），所以把那些有错的项退回上次保存的值——那个值必然合法
    if (value === 'claude') {
      if (errors.openaiExtraParams !== undefined) set('openaiExtraParams', config.openaiExtraParams)
      if (errors.openaiReasoningBudget !== undefined) {
        setNumericText((t) => ({ ...t, openaiReasoningBudget: String(config.openaiReasoningBudget) }))
        set('openaiReasoningBudget', config.openaiReasoningBudget)
      }
    } else if (errors.thinkingBudgetTokens !== undefined) {
      setNumericText((t) => ({ ...t, thinkingBudgetTokens: String(config.thinkingBudgetTokens) }))
      set('thinkingBudgetTokens', config.thinkingBudgetTokens)
    }
    set('apiType', value)
  }

  function setOpenaiDialect(value: OpenAIReasoningDialect): void {
    // 与 setThinkingFormat 同理：切到用不上预算的写法时，置灰的预算框不能攥着非法值
    const usesBudget = value === 'reasoning_object' || value === 'enable_thinking'
    if (!usesBudget && errors.openaiReasoningBudget !== undefined) {
      setNumericText((t) => ({ ...t, openaiReasoningBudget: String(config.openaiReasoningBudget) }))
      set('openaiReasoningBudget', config.openaiReasoningBudget)
    }
    set('openaiReasoningDialect', value)
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (hasErrors || saving) return
    setSaving(true)
    // 留空传 undefined：主进程拿 undefined 当「不改动已存的 Key」，传 '' 会把它清空
    await save(
      draft,
      apiKeyInput === '' ? undefined : apiKeyInput,
      naiTokenInput === '' ? undefined : naiTokenInput,
      danbooruKeyInput === '' ? undefined : danbooruKeyInput,
    )
    setSaving(false)
    // 只在成功时清空：失败多半是磁盘之类与输入无关的原因，
    // 用户接下来大概率要重试，把刚输入的 Key 清掉等于逼他重新输一遍
    if (useConfig.getState().saveError === null) {
      setApiKeyInput('')
      setNaiTokenInput('')
      setDanbooruKeyInput('')
      // 原文按存下的值重写：「 16 」这种能解析的写法存成 16 后，框里不该还算没保存
      setNumericText(numericTextFrom(draft))
      setSavedNotice(true)
    }
  }

  async function pickSaveDir(): Promise<void> {
    const dir = await window.api.pickDirectory()
    // 取消对话框返回空串：保留原来的目录，不清空
    if (dir !== '') set('saveDir', dir)
  }

  const errorOf = (key: keyof AppConfig): ReactNode =>
    errors[key] !== undefined ? <span className="field-error">{errors[key]}</span> : null

  // 下拉跟着输入框的文本走：恰好等于某个预设就显示它，否则（含半截输入）显示「手动设置」
  const pixelsText = numericText.naiMaxPixels.trim()
  const pixelPreset = pixelsText === '' ? null : pixelPresetOf(Number(pixelsText))

  const restoreButton = (key: StringKey): ReactNode => (
    <button type="button" onClick={() => restore(key)}>
      恢复默认
    </button>
  )

  const textField = (key: StringKey, label: string, opts: { hint?: string; placeholder?: string } = {}): ReactNode => (
    <label className="field">
      <span className="field-label">
        {label}
        {isRestorable(key) && restoreButton(key)}
      </span>
      <input type="text" value={draft[key]} placeholder={opts.placeholder} onChange={(e) => set(key, e.target.value)} />
      {opts.hint !== undefined && <span className="field-hint">{opts.hint}</span>}
      {errorOf(key)}
    </label>
  )

  const areaField = (key: StringKey, label: string, rows: number): ReactNode => (
    <label className="field">
      <span className="field-label">
        {label}
        {isRestorable(key) && restoreButton(key)}
      </span>
      <AutoTextarea minRows={rows} value={draft[key]} onChange={(v) => set(key, v)} />
      {errorOf(key)}
    </label>
  )

  /** 单行值但可能很长（质量词、负面词）：按内容撑高、折行显示；留空时框高亮提醒，不拦保存 */
  const lineAreaField = (key: StringKey, label: string): ReactNode => {
    const empty = draft[key].trim() === ''
    return (
      <label className="field">
        <span className="field-label">
          {label}
          {isRestorable(key) && restoreButton(key)}
        </span>
        <AutoTextarea
          singleLine
          className={empty ? 'is-empty-warn' : undefined}
          title={empty ? `${label}为空` : undefined}
          value={draft[key]}
          onChange={(v) => set(key, v)}
        />
        {errorOf(key)}
      </label>
    )
  }

  const numberField = (key: NumericKey, label: string, opts: { hint?: string; disabled?: boolean } = {}): ReactNode => (
    <label className={`field ${opts.disabled === true ? 'is-disabled' : ''}`}>
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={numericText[key]}
        disabled={opts.disabled}
        onChange={(e) => setNumber(key, e.target.value)}
      />
      {opts.hint !== undefined && <span className="field-hint">{opts.hint}</span>}
      {errorOf(key)}
    </label>
  )

  const checkField = (key: BooleanKey, label: string): ReactNode => (
    <label className="field-check">
      <input type="checkbox" checked={draft[key]} onChange={(e) => set(key, e.target.checked)} />
      {label}
    </label>
  )

  return (
    <main className="settings-page" hidden={!active}>
      <form className="settings-form" onSubmit={(e) => void handleSubmit(e)}>
        {!loaded && <div className="placeholder">载入配置中…</div>}

        {loaded && (
          <>
            {/* 首次启动是自己切到设置页的，得说清为什么；也要讲明「不保存下次还会先打开这里」——那是刻意的 */}
            {!configExists && (
              <div className="settings-firstrun" role="status">
                首次启动：填好 LLM 的 API 地址、Key 与模型后点保存。不保存的话，下次启动还会先打开设置。
              </div>
            )}
            {saveError !== null && (
              <div className="settings-error" role="alert">
                {saveError}
              </div>
            )}

            <Group title="LLM API">
              <div className="two-col">
                <label className="field">
                  <span>接口类型</span>
                  <select value={draft.apiType} onChange={(e) => setApiType(e.target.value as AppConfig['apiType'])}>
                    {API_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {API_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                </label>
                {textField('model', '模型')}
              </div>
              {textField('apiBaseUrl', 'API 地址')}
              <label className="field">
                <span>API Key</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKeyInput}
                  placeholder={hasLlmApiKey ? '已保存（留空则不修改）' : '必填'}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                />
              </label>
              <div className="two-col">
                {numberField('maxTokens', '最大输出 token')}
                {numberField('requestTimeoutSec', '请求超时（秒）')}
              </div>
              {draft.apiType === 'openai' && (
                <label className="field">
                  <span>附加请求参数（JSON）</span>
                  <AutoTextarea
                    minRows={3}
                    spellCheck={false}
                    value={draft.openaiExtraParams}
                    placeholder={'{"top_p": 0.9}'}
                    onChange={(v) => set('openaiExtraParams', v)}
                  />
                  <span className="field-hint">原样合并进请求体，同名字段以这里为准</span>
                  {errorOf('openaiExtraParams')}
                </label>
              )}
            </Group>

            <Group title="NovelAI">
              <label className="field">
                <span>NovelAI Token</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={naiTokenInput}
                  placeholder={hasNaiToken ? '已保存（留空则不修改）' : '必填'}
                  onChange={(e) => setNaiTokenInput(e.target.value)}
                />
              </label>
              {textField('naiBaseUrl', '接口地址')}
              <label className="field">
                <span>保存目录</span>
                <div className="field-row">
                  <input type="text" readOnly value={draft.saveDir} placeholder="未设置" />
                  <button type="button" onClick={() => void pickSaveDir()}>
                    选择…
                  </button>
                </div>
                <span className="field-hint">按日期分子目录存图；同目录 _index.json 记账</span>
              </label>
              <div className="two-col">
                <label className="field">
                  <span>图片格式</span>
                  <select value={draft.imageFormat} onChange={(e) => set('imageFormat', e.target.value as AppConfig['imageFormat'])}>
                    {IMAGE_FORMATS.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                {numberField('naiTimeoutSec', '请求超时（秒）')}
                {numberField('naiUsagePercentPerImage', '每张消耗额度（%）', { hint: '顶栏「还能画几张」用它换算；官方接口只给百分比，按自己实测填，0 = 不估算' })}
                {numberField('retryCount', '失败重试次数', { hint: '429 与 Token 问题不重试' })}
                {numberField('taskIntervalMs', '任务间隔（毫秒）')}
                {numberField('historyDays', '历史保留天数')}
              </div>
              <div className="settings-subtitle">多角色与分辨率</div>
              <div className="two-col">{numberField('naiMaxCharacters', '角色数上限')}</div>
              <label className="field">
                <span>像素上限</span>
                <div className="field-row">
                  <select
                    className="pixel-preset"
                    value={pixelPreset ?? MANUAL_PIXELS}
                    onChange={(e) => {
                      const preset = PIXEL_PRESETS.find((p) => p.id === e.target.value)
                      // 选「手动设置」不改值：输入框里是什么就还是什么
                      if (preset) setNumber('naiMaxPixels', String(preset.pixels))
                    }}
                  >
                    <option value={MANUAL_PIXELS}>手动设置</option>
                    {PIXEL_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}（{p.size}）
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={numericText.naiMaxPixels}
                    onChange={(e) => setNumber('naiMaxPixels', e.target.value)}
                  />
                </div>
                <span className="field-hint">
                  宽高比换算宽高时的总像素上限。选预设即写入右边的值；手改成不等于任何预设的值时，下拉回到「手动设置」
                </span>
                {errorOf('naiMaxPixels')}
              </label>
            </Group>

            <Group title="Danbooru">
              {textField('danbooruLogin', '用户名')}
              <label className="field">
                <span>API Key</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={danbooruKeyInput}
                  placeholder={hasDanbooruApiKey ? '已保存（留空则不修改）' : '可不填'}
                  onChange={(e) => setDanbooruKeyInput(e.target.value)}
                />
                <span className="field-hint">可不填：匿名也能查；填了翻页上限更高、限流更宽</span>
              </label>
            </Group>

            <Group title="思维链">
              {checkField('thinkingEnabled', '开启')}
              {draft.apiType === 'claude' ? (
                <>
                  <div className="two-col">
                    <label className="field">
                      <span>格式</span>
                      <select
                        value={draft.thinkingFormat}
                        onChange={(e) => setThinkingFormat(e.target.value as AppConfig['thinkingFormat'])}
                      >
                        {THINKING_FORMATS.map((f) => (
                          <option key={f} value={f}>
                            {THINKING_FORMAT_LABELS[f]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>力度</span>
                      <select
                        value={draft.thinkingEffort}
                        onChange={(e) => set('thinkingEffort', e.target.value as AppConfig['thinkingEffort'])}
                      >
                        {THINKING_EFFORTS.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {numberField('thinkingBudgetTokens', '预算 token', {
                    disabled: draft.thinkingFormat !== 'budget',
                    hint: '仅 budget 格式使用；须 ≥1024 且小于最大输出 token，超出会自动收敛并告警',
                  })}
                </>
              ) : (
                <>
                  <label className="field">
                    <span>参数写法</span>
                    <select
                      value={draft.openaiReasoningDialect}
                      onChange={(e) => setOpenaiDialect(e.target.value as OpenAIReasoningDialect)}
                    >
                      {OPENAI_REASONING_DIALECTS.map((d) => (
                        <option key={d} value={d}>
                          {OPENAI_DIALECT_LABELS[d]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="two-col">
                    <label className={`field ${openaiEffortDisabled ? 'is-disabled' : ''}`}>
                      <span>力度</span>
                      <select
                        value={draft.openaiReasoningEffort}
                        disabled={openaiEffortDisabled}
                        onChange={(e) => set('openaiReasoningEffort', e.target.value as OpenAIReasoningEffort)}
                      >
                        {OPENAI_REASONING_EFFORTS.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    </label>
                    {numberField('openaiReasoningBudget', '预算 token', {
                      disabled: !openaiUsesBudget,
                      hint: '0 = 不发预算；仅 OpenRouter、通义千问的写法使用',
                    })}
                  </div>
                  {draft.openaiReasoningDialect === 'thinking_object' && (
                    <span className="field-hint">
                      {'DeepSeek 要调力度时，在「附加请求参数」里写 {"thinking": {"type": "enabled", "reasoning_effort": "max"}}'}
                    </span>
                  )}
                </>
              )}
            </Group>

            <Group title="提示词">
              {areaField('systemPrompt', '系统提示词', 6)}
              {areaField('naiCharSystemPrompt', '多角色附加', 3)}
              <div className="two-col">
                {lineAreaField('quality', '质量词')}
                {lineAreaField('negativePrompt', '负面词')}
              </div>
              {textField('promptOrder', '字段顺序', { hint: '同时决定编辑器里块的先后' })}
              {textField('naiCharPromptOrder', '角色字段顺序', { hint: '同时决定角色编辑器里块的先后' })}
              {checkField('tailInjectionEnabled', '尾部注入')}
              {draft.tailInjectionEnabled && areaField('tailInjection', '尾部注入内容', 3)}
            </Group>

            <Group title="工具循环">
              <div className="two-col">
                {numberField('maxToolRounds', '最大轮数')}
                {numberField('tagBrowsePageChars', '分类浏览单页字数')}
              </div>
              {checkField('autoSkipSearch', '搜索结果置信度都 ≥0.85 时，下一轮不再提供 search_tags')}
              {checkField('tagManualEnabled', '启用标签手册（load_tag_manual）')}
            </Group>

            <Group title="标签查询返回" summary="16 项" defaultOpen={false}>
              <div className="settings-subtitle">角色</div>
              {numberField('tagQueryCharacterMax', '最多返回条数', { hint: '0 = 不限制' })}
              {checkField('tagQueryCharacterAliases', '返回中文别名')}
              {checkField('tagQueryCharacterWiki', '返回 wiki 摘要')}
              {checkField('tagQueryCharacterSeries', '返回所属作品')}
              {checkField('tagQueryCharacterAppearance', '返回外貌标签')}
              {checkField('tagQueryCharacterClothing', '返回服装标签')}
              <div className="settings-subtitle">画师</div>
              {numberField('tagQueryArtistMax', '最多返回条数', { hint: '0 = 不限制' })}
              {checkField('tagQueryArtistAliases', '返回中文别名')}
              {checkField('tagQueryArtistWiki', '返回 wiki 摘要')}
              <div className="settings-subtitle">概念</div>
              {numberField('tagQueryGeneralMax', '最多返回条数', { hint: '0 = 不限制' })}
              {checkField('tagQueryGeneralAliases', '返回中文别名')}
              {checkField('tagQueryGeneralWiki', '返回释义')}
              <div className="settings-subtitle">作品</div>
              {numberField('tagQuerySeriesMax', '最多返回条数', { hint: '0 = 不限制' })}
              {checkField('tagQuerySeriesAliases', '返回中文别名')}
              {checkField('tagQuerySeriesWiki', '返回 wiki 摘要')}
              {numberField('tagQueryWikiLength', 'wiki 摘要截断长度（字符）')}
            </Group>

            <Group title="网络">
              {textField('proxy', '代理', { placeholder: '留空跟随系统代理，例如 http://127.0.0.1:7890' })}
            </Group>

            <Group title="手机端">
              {checkField('mobileServerEnabled', '开启手机端服务')}
              {numberField('mobileServerPort', '端口', { hint: '1024–65535；开关或端口改动要保存后才生效' })}

              {mobile.status === null && <span className="field-hint">读取手机端服务状态…</span>}

              {mobile.status !== null && (
                <>
                  {!mobile.status.running ? (
                    <div className="mobile-line">
                      {mobile.status.error !== null ? `服务没能启动：${mobile.status.error}` : '服务未开启'}
                    </div>
                  ) : (
                    <div className="mobile-connect">
                      {mobileQr !== null && <img className="mobile-qr" src={mobileQr} alt="手机扫码配对" />}
                      <div className="mobile-connect-info">
                        <div className="mobile-urls">
                          {mobile.status.urls.length > 0 ? (
                            mobile.status.urls.map((u) => (
                              <code key={u} className="mobile-url">
                                {u}
                              </code>
                            ))
                          ) : (
                            <span className="field-hint">本机没有可用的局域网地址，检查一下网络连接</span>
                          )}
                        </div>
                        <div className="mobile-code-row">
                          <span>
                            配对码 <code className="mobile-code">{mobile.status.code ?? '生成中…'}</code>
                          </span>
                          {mobile.status.code !== null && mobile.status.codeExpiresAt !== null && (
                            <span className="field-hint">
                              {formatRemainingMs(mobile.status.codeExpiresAt, mobileNow)} 内有效，用一次即失效
                            </span>
                          )}
                          <button type="button" onClick={mobile.refreshCode}>
                            换一个配对码
                          </button>
                        </div>
                        <span className="field-hint">手机连同一个 WiFi，扫码或手输地址与配对码即可连接</span>
                      </div>
                    </div>
                  )}

                  <div className="mobile-devices">
                    <span className="settings-subtitle">已配对设备</span>
                    {mobile.status.devices.length === 0 ? (
                      <span className="field-hint">还没有设备配对</span>
                    ) : (
                      mobile.status.devices.map((d) => (
                        <div key={d.id} className="mobile-device-row">
                          <span className="mobile-device-name">{d.name}</span>
                          <span className="field-hint">
                            配对于 {formatRoundTime(d.pairedAt)} · 最后活跃 {formatRoundTime(d.lastSeenAt)}
                          </span>
                          <button type="button" onClick={() => mobile.revoke(d.id)}>
                            吊销
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </Group>

            {/* 保存栏钉在页底：系统提示词很长，滚到哪都要能直接保存 */}
            <div className="settings-actions">
              {dirty ? (
                <span className="settings-status is-dirty">有未保存的修改</span>
              ) : (
                savedNotice && <span className="settings-status is-saved">已保存</span>
              )}
              <button type="button" disabled={!dirty || saving} onClick={resetDraft}>
                撤销修改
              </button>
              {/* 没改也能保存：首次启动时草稿就是默认值，不保存 config.json 就不会落盘 */}
              <button type="submit" className="primary" disabled={hasErrors || saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </>
        )}
      </form>
    </main>
  )
}
