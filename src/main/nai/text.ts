// ─── 文本渲染 ───────────────────────────────────────────────

/**
 * 组装 NovelAI 的文本渲染语法。
 *
 * 机制（官方文档 + 实测）：
 * - 标记是 `text:`，**大小写不敏感**（`Text:` / `teXt:` 同样生效）
 * - **引号出现在提示词正文里，不在 `text:` 段里**。官方工具的形态是：
 *   正文中把要渲染的文字用引号括起（给模型"这里有文字"的语义提示），
 *   末尾的 `text:内容` 则不带引号。实测提示词：
 *   `... floating white feathers , "天使"， 降临 , very aesthetic, masterpiece , text:天使`
 * - **从第一个标记开始，其后的全部内容被当作一整句话渲染**——
 *   包括后面出现的字面 "text:" 三个字。实测提示词末尾写
 *   `text:天使 ,text:降临`，画面上出现的就是 `天使 ,text:降临`
 * - 因此标记必须在提示词最末尾，且全篇只能有一个生效的标记
 * - **只支持一段连续文字**。模型针对这一段做了字形修复，多段不会生效。
 *   实测官方工具只取最后一个引号内的内容，也印证了单段的设计
 * - 提示词中要有 `text, english text` 标签
 * - 质量词里的 `no text` 会让文本渲染失效（官方 V4.5 质量词恰好含这个词）
 * - 需要 V4 及以上模型；建议 120 字符以内
 *
 * 反过来，**没有要渲染的文字时补 `no text`**：这个标签就是文本渲染的开关位，
 * 该关的时候得关上，否则模型容易在画面里自作主张糊一片乱码字符。
 * 所以 rawText 为空也要调用本函数，不能在调用点跳过。
 *
 * 对已有标记的处理：**改写而不是删除**。把中途出现的 `text:` 换成 `text=`，
 * 内容原样保留——直接丢弃会把后面的正常标签一起带走，导致大量 TAG 丢失、画面偏离目标。
 * 换成 `text=` 后它不再触发渲染机制，但语义仍能被模型读到。
 */
export function applyTextRendering(basePrompt: string, rawText: string): { prompt: string; notes: string[] } {
  const notes: string[] = []
  let raw = String(rawText || '').trim()

  // 文本强化只作用于**一段**连续文字。LLM 可能塞进多段（多组引号），
  // 那样一段都强化不好——取最长的一段，其余降级为正文里的普通描述。
  const quotedGroups = raw.match(/["“‘'][^"”’']+["”’']/g)
  if (quotedGroups && quotedGroups.length > 1) {
    const longest = quotedGroups.reduce((a, b) => (b.length > a.length ? b : a))
    notes.push(`text 字段含 ${quotedGroups.length} 段文字，只能强化一段，已取最长的一段：${longest}`)
    raw = longest
  }

  // 剥掉各种引号（含中文引号）：text: 段本身不需要引号，
  // 引号要出现在正文里，两处形态不同，所以先归一成裸文本再分别处理
  const text = raw.replace(/^["“‘'](.*)["”’']$/s, '$1').trim()

  // 即使没有要渲染的文字，也要把中途的 text: 改掉——否则它会把后面所有内容吞成画面文字
  let prompt = basePrompt
  const marker = /text\s*:/gi
  const hits = basePrompt.match(marker)
  if (hits && hits.length > 0) {
    prompt = prompt.replace(marker, 'text=')
    notes.push(`提示词中已有 ${hits.length} 处 text: 标记，已改写为 text= 以免触发文本渲染（内容保留）`)
  }

  // 没有要渲染的文字时，反过来补 no text。
  // 与下面「有文字就删掉 no text」是同一条规则的两面：这个标签是文本渲染的开关位，
  // 该关的时候就得关上——不写它，模型容易在画面里自作主张糊上一片乱码字符。
  if (!text) {
    const tags = prompt.split(',').map(t => t.trim()).filter(Boolean)
    if (!tags.some(t => t.toLowerCase() === 'no text')) {
      prompt = `${prompt.replace(/[,\s]*$/, '')}, no text`
      notes.push('未指定渲染文字，已补 no text 抑制画面乱码文字')
    }
    return { prompt, notes }
  }

  // 去掉 no text——它和文本渲染直接冲突
  const beforeNoText = prompt.split(',').map(t => t.trim()).filter(Boolean)
  const afterNoText = beforeNoText.filter(t => t.toLowerCase() !== 'no text')
  if (afterNoText.length !== beforeNoText.length) {
    notes.push('已移除 no text（与文本渲染冲突）')
  }
  prompt = afterNoText.join(', ')

  // 补上触发标签
  // 用切分比对而不是正则：模板字符串里的 \s 会被当成无效转义吞掉，很容易写出永不命中的正则
  const existing = new Set(prompt.split(',').map(t => t.trim().toLowerCase()).filter(Boolean))
  // 语种标签跟着文字走：渲染中文要用 chinese text，用 english text 会误导模型
  const hasCjk = /[぀-ヿ㐀-䶿一-鿿]/.test(text)
  const langTag = hasCjk ? 'chinese text' : 'english text'
  const missing = ['text', langTag].filter(t => !existing.has(t))
  if (missing.length > 0) {
    prompt = `${prompt.replace(/,\s*$/, '')}, ${missing.join(', ')}`
    notes.push(`已补充文本渲染标签: ${missing.join(', ')}`)
  }

  // 在正文里补一段带引号的文字，作为"这里有文字"的语义提示。
  // 这是官方工具的形态：引号在正文、text: 段不带引号。
  // 已经写过就不重复（LLM 可能自己按要求写了）。
  const quotedForm = `"${text}"`
  if (!prompt.includes(quotedForm) && !prompt.includes(`“${text}”`)) {
    prompt = `${prompt.replace(/,\s*$/, '')}, ${quotedForm}`
    notes.push(`已在正文补充带引号的文字提示: ${quotedForm}`)
  }

  // 追加到最末尾——这是全篇唯一生效的标记，内容不带引号
  prompt = `${prompt.replace(/[,\s]*$/, '')}, text: ${text}`

  if (text.length > 120) {
    notes.push(`渲染文本 ${text.length} 字符，超过官方建议的 120，可能拼写错乱`)
  }
  const nonAscii = [...text].filter(c => c.charCodeAt(0) > 0x7e)
  if (nonAscii.length > 0) {
    notes.push(`渲染文本含非 ASCII 字符（V4/V4.5 不支持，V5 实测可渲染中文）: ${[...new Set(nonAscii)].slice(0, 8).join('')}`)
  }

  return { prompt, notes }
}
