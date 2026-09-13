import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  API_TYPES,
  IMAGE_FORMATS,
  NUMBER_RULES,
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
import { useConfig } from '../state/config'

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

function numericTextFrom(cfg: AppConfig): Record<NumericKey, string> {
  const out = {} as Record<NumericKey, string>
  for (const key of Object.keys(NUMBER_RULES) as NumericKey[]) out[key] = String(cfg[key])
  return out
}

/** 可折叠的一组。展开状态不持久化：抽屉关掉就卸载，下次打开回到默认 */
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
    <section className={`drawer-group ${open ? '' : 'is-closed'}`}>
      <button type="button" className="drawer-group-head" onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <span className="drawer-group-summary">
          {summary !== undefined ? `${summary} ` : ''}
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && <div className="drawer-group-body">{children}</div>}
    </section>
  )
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function SettingsDrawer({ open, onClose }: Props): JSX.Element | null {
  const config = useConfig((s) => s.config)
  const loaded = useConfig((s) => s.loaded)
  const hasLlmApiKey = useConfig((s) => s.hasLlmApiKey)
  const hasNaiToken = useConfig((s) => s.hasNaiToken)
  const configExists = useConfig((s) => s.configExists)
  const saveError = useConfig((s) => s.saveError)
  const save = useConfig((s) => s.save)
  const dismissSaveError = useConfig((s) => s.dismissSaveError)

  const [draft, setDraft] = useState<AppConfig>(config)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [naiTokenInput, setNaiTokenInput] = useState('')
  const [numericText, setNumericText] = useState<Record<NumericKey, string>>(() => numericTextFrom(config))
  const [saving, setSaving] = useState(false)
  // 在系统提示词框里拖选文字、松开时鼠标落在遮罩上：Chromium 把 click 事件
  // 派给按下与松开两个目标的最近公共祖先——正是遮罩——于是 onClose 被
  // 触发，草稿（连同刚填的 API Key）全丢。只有按下和松开都落在遮罩本身
  // 才算真的点了遮罩要关闭。
  const downOnBackdrop = useRef(false)

  useEffect(() => {
    // 必须等 loaded 才重置草稿：配置还没读回来就用默认值初始化草稿，
    // 随手一保存就把已存配置覆盖了。loaded 从 false 变 true 时这条会再跑一次。
    if (!open || !loaded) return
    setDraft(config)
    setApiKeyInput('')
    setNaiTokenInput('')
    setNumericText(numericTextFrom(config))
    dismissSaveError()
    // 只在「打开且已载入」这一刻取快照；config 若进依赖数组，编辑期间
    // 每次按键触发的重渲染都会被这条 effect 用旧值把草稿冲掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, loaded])

  if (!open) return null

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
    // 立即替换，不弹确认（规格 §14.2）：改的是草稿，关掉不保存就是撤销
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
    await save(draft, apiKeyInput === '' ? undefined : apiKeyInput, naiTokenInput === '' ? undefined : naiTokenInput)
    setSaving(false)
    // 只在成功时清空并关闭：失败多半是磁盘之类与输入无关的原因，
    // 用户接下来大概率要重试，把刚输入的 Key 清掉等于逼他重新输一遍
    if (useConfig.getState().saveError === null) {
      setApiKeyInput('')
      setNaiTokenInput('')
      onClose()
    }
  }

  async function pickSaveDir(): Promise<void> {
    const dir = await window.api.pickDirectory()
    // 取消对话框返回空串：保留原来的目录，不清空
    if (dir !== '') set('saveDir', dir)
  }

  const errorOf = (key: keyof AppConfig): ReactNode =>
    errors[key] !== undefined ? <span className="field-error">{errors[key]}</span> : null

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
      <textarea rows={rows} value={draft[key]} onChange={(e) => set(key, e.target.value)} />
      {errorOf(key)}
    </label>
  )

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
    <div
      className="drawer-backdrop"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose()
      }}
    >
      <form className="settings-drawer" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void handleSubmit(e)}>
        <div className="drawer-header">
          <span>设置</span>
          <button type="button" className="drawer-close" title="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        {!loaded && <div className="placeholder">载入配置中…</div>}

        {loaded && (
          <>
            {/* 抽屉是自己弹出来的，得说清为什么；也要讲明「不保存就还会再弹」——那是刻意的 */}
            {!configExists && (
              <div className="drawer-firstrun" role="status">
                首次启动：填好 LLM 的 API 地址、Key 与模型后点保存。不保存的话，下次启动还会弹出。
              </div>
            )}
            {saveError !== null && (
              <div className="drawer-error" role="alert">
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
                  <textarea
                    rows={3}
                    spellCheck={false}
                    value={draft.openaiExtraParams}
                    placeholder={'{"top_p": 0.9}'}
                    onChange={(e) => set('openaiExtraParams', e.target.value)}
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
                {numberField('retryCount', '失败重试次数', { hint: '429 与 Token 问题不重试' })}
                {numberField('taskIntervalMs', '任务间隔（毫秒）')}
                {numberField('historyDays', '历史保留天数')}
              </div>
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
                {textField('quality', '质量词')}
                {textField('negativePrompt', '负面词')}
              </div>
              {textField('promptOrder', '字段顺序', { hint: '同时决定编辑器里块的先后' })}
              {textField('naiCharPromptOrder', '角色字段顺序', { hint: '同时决定角色编辑器里块的先后' })}
              {checkField('tailInjectionEnabled', '尾部注入')}
              {draft.tailInjectionEnabled && areaField('tailInjection', '尾部注入内容', 3)}
            </Group>

            <Group title="多角色与分辨率">
              <div className="two-col">
                {numberField('naiMaxCharacters', '角色数上限')}
                {numberField('naiMaxPixels', '像素上限', { hint: '宽高比换算宽高时的总像素上限' })}
              </div>
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
              <div className="drawer-subtitle">角色</div>
              {numberField('tagQueryCharacterMax', '最多返回条数', { hint: '0 = 不限制' })}
              {checkField('tagQueryCharacterAliases', '返回中文别名')}
              {checkField('tagQueryCharacterWiki', '返回 wiki 摘要')}
              {checkField('tagQueryCharacterSeries', '返回所属作品')}
              {checkField('tagQueryCharacterAppearance', '返回外貌标签')}
              {checkField('tagQueryCharacterClothing', '返回服装标签')}
              <div className="drawer-subtitle">画师</div>
              {numberField('tagQueryArtistMax', '最多返回条数', { hint: '0 = 不限制' })}
              {checkField('tagQueryArtistAliases', '返回中文别名')}
              {checkField('tagQueryArtistWiki', '返回 wiki 摘要')}
              <div className="drawer-subtitle">概念</div>
              {numberField('tagQueryGeneralMax', '最多返回条数', { hint: '0 = 不限制' })}
              {checkField('tagQueryGeneralAliases', '返回中文别名')}
              {checkField('tagQueryGeneralWiki', '返回释义')}
              <div className="drawer-subtitle">作品</div>
              {numberField('tagQuerySeriesMax', '最多返回条数', { hint: '0 = 不限制' })}
              {checkField('tagQuerySeriesAliases', '返回中文别名')}
              {checkField('tagQuerySeriesWiki', '返回 wiki 摘要')}
              {numberField('tagQueryWikiLength', 'wiki 摘要截断长度（字符）')}
            </Group>

            <Group title="网络">
              {textField('proxy', '代理', { placeholder: '留空跟随系统代理，例如 http://127.0.0.1:7890' })}
            </Group>

            <div className="drawer-actions">
              <button type="button" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="primary" disabled={hasErrors || saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
