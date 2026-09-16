# 设计说明

llm-nai-toolbox 的架构与关键取舍。使用方法见 [README](../README.md)。

---

## 一句话

把 `koishi-plugin-reforge` 的 LLM 交互层搬到桌面，界面与工程骨架取自「画师串工具箱」，**只保留 NovelAI**，并把「LLM 直接出图」改成「LLM 只回填字段，人确认后出图」。

> 权威定义在代码里：字段看 `src/shared/fields.ts`，段结构看 `src/shared/blockDoc.ts`。本文若与代码冲突，以代码为准。

---

## 进程模型

主进程包办全部 IO 与外部请求；渲染进程 `contextIsolation` 打开、不发任何外部 HTTP 请求。所有网络走 Electron 的 `net.fetch`，因此 LLM 接口、NovelAI 接口、Danbooru 接口与例图共用同一处代理设置。

渲染进程里唯一的例外是 `<img src>` 加载 Danbooru 图片——它走 Electron session 的代理，与 `net.fetch` 是同一处配置，不必另开一条 IPC 通道。

### 模块

| 目录 | 职责 |
|---|---|
| `main/net.ts` | `appFetch`（`net.fetch`）与代理应用；主进程所有外部请求都走它 |
| `main/store.ts` · `config-store.ts` · `secret-store.ts` | `workspace.json` / `styles.json` / `config.json` / `secrets.json` 的原子读写；密钥用 `safeStorage` 加密 |
| `renderer/components/` | 工具栏、历史竖栏、出图弹窗与溯源信息、指令区（固定在中间列底部）与日志抽屉、提示词面板、参数区、角色面板、画风维护、设置页（与工作台、画风维护并排的标签）——布局与交互照画师串工具箱与已确认的界面稿 |
| `main/nai/` | NovelAI 协议：请求体、出图客户端与错误分级、zip 解包、读 PNG 元信息、画面文字处理、落盘与 `_index.json` |
| `main/danbooru/` | 只服务右侧 WIKI 栏：`client.ts`（令牌桶容量 6、每秒回补 1；10s 超时；内存 LRU + 磁盘 7 天缓存；`tagInfo`、posts 排序；测试用 `LLM_NAI_DANBOORU_BASE_URL` 换桩地址）、`cache.ts`、`cdn.ts`（给 `cdn.donmai.us` 图片请求补 Referer） |
| `main/tagdb/` | 本地标签库：索引加载与补全、LLM 工具数据的惰性加载、分类浏览、释义与废弃表、角色特征、搜索结果格式化 |
| `main/llm/` | 一轮 LLM 交互：两个端点、工具 schema、参数兜底与 NovelAI 规范化、上下文组装、收口后处理、多轮循环 |
| `main/gen/` | 一轮出图的编排：快照与拼接、串行队列（429 暂停、Token/点数中止、按张重试）、seed 分配与回填 |
| `shared/` | 字段定义、分块文档、配置与工作区的类型/默认值/校验/自愈、token 计算——纯函数，两端共用 |
| `renderer/editor/` | CodeMirror 接线：装饰、守卫、快捷键 |

`shared/fields.ts` 是字段的唯一事实来源。分块装饰、提示词拼接、LLM 工具 schema 全部从这里取——各写一份必然漂移，漂移的表现是「界面上有这个块，拼接时被漏掉」。

---

## 一次 LLM 轮次

```
渲染进程  llm:run({ instruction, multiCharacter, editExisting, transparent, style, workspace })
   ↓
主进程 runner（main/llm/runner.ts，循环只有这一份）
  0. 备齐标签数据：缺哪个文件就摘掉对应工具，日志写明
  1. system = 系统提示词 + 多角色说明 + tag-skill-core + 手册目录 + 分类目录 + 修改模式规则
  2. user   = [标签释义] + 指令 + [质量词] + [负面词]
            修改模式：<现有参数>（取自工作区）+ [用户的修改要求]
  3. 循环 ≤ maxToolRounds：
       工具集 = 生成工具 + search_tags + search_character_features + load_tag_manual + browse_tags
       调端点；日志行逐条推 llm:event
       检索类本地执行、结果喂回；没有检索调用就收口
       搜索全部 ≥0.85 且开着 autoSkipSearch → 之后撤掉 search_tags
       最后一轮只给生成工具
  4. 收口后处理：画风覆盖 → NovelAI 规范化 → 透明背景 → 负面词兜底 → 宽高换算
   ↓
llm:event finished { LlmRunResult：filled（带 FillResult）/ noParams / failed / aborted }
   ↓
渲染进程  filled 时 applyFill 写进工作区，日志末尾追加「已回填: …」
```

**每次发送都是全新一轮**，不累积对话历史。想在现有内容上改，打开「在现有内容上修改」，编辑器、负面词、参数、角色的当前内容会作为 `<现有参数>` 一并送出。

**回填内容就是本来要发给 NovelAI 的最终参数。** 插件在出图前做的处理全部在收口后做完，回填本身不再加工，所以不存在「没回填」的值。唯一例外是 `text`：插件在拼接完提示词之后才处理它（补 `no text`、改写中途的 `text:`、追加 `text: 内容`），提示词排序里没有它的位置，所以原样带出，出图时再按插件规则处理。角色负面词独立存在，只取模型给该角色的——与插件不同，没有「角色默认负面词」，也不和整图负面词发生关系。

生成参数里没有负面预设、质量词开关与 Variety Boost：工具主要面向 V5，V5 不支持 Variety Boost；官网的默认正面/负面词不悄悄加进请求，将来要用也是在设置里选「用官网配置覆盖」。

工具名与 schema 与插件完全一致——成品系统提示词通篇引用这些名字，改名等于全部作废。唯一动态的部分是 `generate_image` 描述里那句拼接顺序：按设置里的字段顺序生成。

**日志照 koishi LOG。** 每行 `时间 [I/W/E] 文本`，文案沿用插件原句：本轮工具集、Token 累计、每条搜索的最高匹配、NovelAI 规范化说明、宽高换算……三种没有回填的结束各有固定的末行：模型没给参数时原样打出它说了什么；请求失败时一行接口原文、一行下一步；中止时写停在第几轮。

**端点。** Claude 与 OpenAI 兼容两种。思维链关闭时**不发送**任何参数（显式 disabled 会让 Opus 5 偶尔把工具调用写进正文）。OpenAI 兼容端点各家的思维链写法不同，设置里选「参数写法」：`reasoning_effort`（OpenAI / Gemini / xAI / vLLM）、`reasoning` 对象（OpenRouter）、`thinking` 对象（DeepSeek / 智谱 / Kimi）、`enable_thinking`（通义千问）；力度原样发送，不在应用里降档；其余差异用「附加请求参数（JSON）」补，同名字段以它为准。工具往返里带回续接推理所需的字段（`reasoning_content`、`reasoning_details`、`tool_calls[].extra_content`），缺了 DeepSeek、OpenRouter、Gemini 会报 400。端点以 400 拒绝时按报错点名的参数自动退让，每种一轮最多一次：不认思维链参数就不再发、要求 `max_completion_tokens` 就改发它（OpenAI 官方的推理模型不收 `max_tokens`）、不收带回的推理字段就从历史里剥掉。网络错误与 5xx 重试 3 次；超时不重试——超时多半是代理问题，重试只会让用户多等几分钟。中止不依赖 `net.fetch` 是否支持 `AbortSignal`，请求被包在一个中止即 reject 的 promise 里。

**同一时刻只有一轮。** 两轮并发往同一份工作区回填，谁先谁后说不清。

**结束经事件送达。** 渲染进程不从 `llm:run` 的返回值取结果，而是等主进程在返回前推的 `finished` 事件。它和日志走同一条 `llm:event` 通道，先后有保证；invoke 的回复走另一条通道，实测会早于最后几行日志到达，拿它当结束会让「已回填」行插在日志中间。

**回填**（`shared/applyFill.ts`）：整图十个字段整体替换；画面文字、负面词、宽高、透明背景、使用坐标定位照写；角色区按回填重建（新 id、全部勾选），模型用单角色工具收口时清空角色区。宽高总是写入换算结果。**模型不管 seed**：生成工具参数里没有 seed，seed 与 seed 模式完全由参数区决定。

---

## 分块提示词编辑器

单个 CodeMirror 文档，用不可见的 `U+001F` 把十个字段切成**固定十段**，每段渲染成一个带字段徽章的底色框。

段结构由 transaction filter 守着，**永不增减**——空字段也占位。这让光标归属与边界保护变成纯粹的区间判断，不需要处理「段被创建/销毁」的中间态。

文档永远是**单行**：一个字段值里混进换行，所有按字符位置算的区间就全部错位。这条不靠每个写入点各自留心，而是结构性地兜住——`sanitizeFieldText` 在每次写入时剥掉分隔符与换行，`isWellFormed` 也把两者都当损坏来判。没有哪个任务的验收专门测过回车或多行粘贴，这条不变量是事后从一个漏洞里补出来的，不是计划里写好的。

两条规则处理方式故意不同：

- 改动范围**跨越分隔符** → 整笔拒绝。裁剪的语义（保留哪一段？）没有唯一正确答案，猜错就是静默改坏用户的内容。
- 插入的**文本里含分隔符**（从别处粘来的） → 剥掉再插入。这里语义唯一，拒绝反而是「粘贴毫无反应」这种莫名其妙的表现。

装饰区间的计算放在 `shared/` 而不是编辑器文件里，且不 import CodeMirror——`Decoration` 必须在浏览器环境构造，掺进来这段就没法在 node 里单测，而区间算错正是最容易出、也最容易漏的那类 bug。

### 版面：框里看到的就是发出去的

块的先后与拼接顺序一致。每个会进拼接结果的块（trim 后非空）后面跟一个**不可编辑**的 ` ,`，于是把徽章和空框拿掉，屏幕上剩下的文字就是 `buildPrompt` 的结果：

```
[count] 1girl, solo , [style ▢] [character] skadi , [artist] wlop ,
→ 1girl, solo , skadi , wlop ,
```

「画不画逗号」与 `buildPrompt`「拼不拼这一段」共用 `joinsPrompt` 一个判据。字段值自带的尾逗号如实保留，`solo,` 显示为 `solo, ,`，与输出一致。插件的 `enableNltags` 不实现。

折行照静态演示稿 `docs/block-editor-preview.html`：

- 整个编辑器是一段文字，每行从同一个左缘开始；块内折行时续行贴左缘，框在折行处开口
- 徽章贴着首词，放不下时一起换行
- 块与块之间隔一个空格，行首不占位；拼接逗号粘在块尾，不会落到行首
- 空块整块不拆
- tags 形态的字段**只在逗号之后折行**，一个标签（含 `very long hair` 这种带空格的）不拆开；比一整行还宽的标签才允许在内部断开。nltags 是自然语言，照常在空格处折

这几条几乎每一条都踩过一个浏览器或 CodeMirror 的具体行为，理由写在 `editor/blockExtension.ts` 与 `index.css` 的注释里。最容易重犯的三个：

- **要粘住的东西不能放进 widget。** CodeMirror 在每个 widget 两侧插零宽 `<img class="cm-widgetBuffer">`，浏览器允许在图片旁折行。拼接逗号与块间空格因此画在 mark 的 `::after` 上。
- **同一个装饰来源里，范围相同的两个 mark 谁在外没有保证。** 增量更新时会建出不一致的嵌套，把一个框拆成几段，每段各画一个 `::before` 徽章（实机：中文后打空格再打字，徽章重复出现）。所以装饰分四个来源，靠来源优先级固定内外：拼接逗号 > 框 > 标签 > 问题标红（全角逗号、标签末尾数字紧贴 `::`，两者不会重叠，同一层）。以后再加 mark 装饰，优先级必须高于框那一层。
- **光标坐标不靠 `selection.assoc`。** 分隔符两侧的位置语义是固定的（前一段末尾 / 后一段起点），由分隔符 widget 的 `coordsAt` 直接给坐标。先前靠 assoc 的写法从未生效过：`dispatch({ selection: EditorSelection.cursor(pos, -1) })` 会被 state 用 `EditorSelection.single(anchor, head)` 重建，assoc 当场丢失。

### 整图与角色是两套字段集

| | 整图（10 项） | 角色（5 项） |
|---|---|---|
| 字段 | `count style character artist appearance tags environment series nltags quality` | `count character appearance tags nltags` |
| `count` | 总人数、构图、镜头，自由标签 | 该角色的性别标记，`girl`/`boy`/`other` 三选一；规格要求渲染成选择器，目前尚未实现，仍是分块编辑器里的普通文本块 |
| `character` | 多角色模式下必须留空 | 该角色的角色名 |

`negative_prompt` 与 `position` 是角色的**参数不是字段**，有各自的独立输入，绝不进分块流。

编辑器组件**接受字段集作为参数**，不引用任何模块级字段常量。

### 工作区与设置

一份工作区（`workspace.json`）：整图字段、画面文字、负面词、生成参数、角色列表、坐标定位开关。编辑防抖 500ms 落盘，关窗前同步冲刷一次。读回来的任何形状都先过 `normalizeWorkspace`：缺的补默认、类型不对的回默认、字段值里的换行剥掉、重复的角色 id 重新生成——重复 id 会让两个角色共用一个编辑器实例与撤销栈。指令区的输入与开关（指令、多角色、修改模式、透明背景、画风档位与选中的预设）也存在工作区里。

**画面文字不是字段**：它在提示词拼接完之后才接到末尾，提示词排序里没有它的位置，所以单独一个输入框。

设置（`config.json`）读写都过 `mergeConfig`：逐项按默认值的类型取用，只补缺不回退——存的是空串就是空串，随包默认文案只在文件不存在时出现一次（设置页的「恢复默认」除外）。枚举、数值规则、字段顺序不合法的项回到默认值。

**字段顺序串必须恰好包含全部字段。** 它同时决定拼接顺序与编辑器里块的先后；插件允许漏写字段（漏掉的不拼接），这里不允许，否则会有一个看得见却发不出去的块。

设置页的 Danbooru 分组另有一项非密钥配置：`danbooruLogin`（用户名，默认空串，不填也能匿名查询，填了翻页上限更高、限流更宽）。

密钥全部在 `secrets.json`，渲染进程只知道「有没有存过」，明文不进渲染进程；`SecretName` 现有 `llmApiKey`、`naiToken`、`danbooruApiKey` 三项。Danbooru API Key 只走 `Authorization: Basic` 头，绝不进 URL、缓存键或错误文案。

---

## 画风注入

三选一，决定 LLM 返回的 `artist` 字段怎么处理：不覆盖 / 用预设画风覆盖 / 用当前 artist 块覆盖。

画风不注入上下文：后两档在回填前直接用锁定的画风覆盖 `artist`（`fill.ts`），模型写什么都会被替换，没必要占用户消息。

两处退化明确处理：没有可用的预设画风 → 预设档置灰；选了保持当前但 `artist` 块本来就空 → 退化成不锁定并写明，而不是注入一个空画风让模型犯迷糊。

**画风预设**（名称 + 标签）存 `styles.json`（数组顺序即列表顺序），在顶栏「画风维护」视图里维护：左侧列表（拖动排序，绿点标出当前预设画风，顶上单独置顶当前预设）+ 右侧详情（名称框直接改名，不能为空、不能重名；「选为预设画风」「覆盖画风」「规范化权重与 @」「生成副本」「删除」，删除有内容的预设前确认）；「从工作台提取」把工作台 artist 块存成新画风。改动即保存（防抖 500ms，关窗前冲刷）。

**当前预设画风**只有一条，记在工作区的 `console.presetId`，在画风维护里「选为预设画风」设置，**不动**指令区的画风档位；指令区只显示它的名称和「选择预设…」（切到画风维护）。「覆盖画风」把那条标签整段替换工作台 artist 块并切回工作台。当前预设被删掉或清空时，预设变未选择、预设档退回「不覆盖」（切回工作台时结算）。规范化权重另把 webui 转义的 `\(` `\)` 还原成普通括号。

---

## 本地标签库

随安装包分发。`tags_index_v2`(29MB) 启动后异步读盘，服务补全与 `search_tags`；其余五个文件是 LLM 工具的数据，第一次跑 LLM 时由 `main/tagdb/extras.ts` 按需读入并常驻。`tags_detail_v2`(41MB) 只在打开了任一类「返回 wiki」开关时才读。读失败不缓存——用户按日志提示把文件放进去，下一轮就能用，不必重启。

`tag-skill-core.md` 与 `tag-manuals/` 一共一百多 KB，构建期打进主进程包（`?raw` 与 `import.meta.glob`），不存在运行时找不到的问题。

插件用的是同步 `readFileSync`，搬到 Electron 主进程会卡住启动，所以改成 `fs/promises`。但 `JSON.parse` 与建索引仍是同步的：**实测整个加载 3949ms**（读盘 85ms + parse 210ms + 建两份索引约 3.6s），常驻 heap 554MB。这段时间主进程被占住，界面照常（渲染是独立进程），只是发往主进程的补全请求会排队——所以 `loading` 状态必须在同步段开始**之前**播出去，`load()` 里那个 `await readFile` 提供的让出点保证了这一点。

索引常驻进程生命周期，不做淘汰。554MB 是接受的代价，不是异常。

**缺文件时不静默降级**：状态分 `missing`（文件没放）与 `error`（读不了、解析失败、或某一类为空），`detail` 里点名是哪个文件、哪几类，界面照抄。类别判空是**逐类**而不是只判全空——旧版 schema 或被截断的文件会让三类为空而总数非零，那时挂 `ready` 等于给用户一个半残的库还不告诉他。

### 检索与补全是两套东西

这是本模块最要紧的一条分界，两侧不共用打分路径。

| | 检索（`shared/tagdb/search.ts`，从插件搬运） | 补全（`shared/tagdb/completionMatch.ts`，新写） |
|---|---|---|
| 用途 | LLM 递来一个完整查询串，找出规范 tag | 用户逐字输入，过滤候选 |
| 形态 | **解析器**：精度优先，短查询被主动拒绝 | **过滤器**：召回优先，每次按键的成本才是约束 |
| 匹配 | CJK 归一 + trigram 预筛 + Levenshtein | 词首匹配（照抄 a1111-sd-webui-tagcomplete 的 `(^\|[^a-zA-Z])`） |
| 收口 | `searchOne` 的「≥0.85 全给、0.5~0.85 只给最高一个」 | 不收口，全量返回 |
| 索引 | trigram 倒排，键建在 `normalize`（**删**下划线括号） | 词首倒排，键建在 `foldForCompletion`（**留**符号） |

把解析器当过滤器用是行不通的，不是慢一点的问题：`getCandidates` 对 1 字符查询返回 null，2 字符的拉丁查询在 trigram 索引里零命中（`extractTrigrams` 对非 CJK 长名只产 trigram）。`calcSimilarity` 里那句 `hasCjk(nq) ? nq.length >= 2 : nq.length >= 3` 旁边记着事故：`nq="W"` 时一次查询返回 168 万字符。

补全的候选分三档排序，档内规则不同：

| 档 | 内容 | 档内排序 |
|---|---|---|
| 0 | 折叠后与查询完全相等 | 图数降序 |
| 1 | 词首命中 | 图数降序 |
| 2 | 完整检索（`matchEntry` ≥ 0.5），仅当查询长到 trigram 索引能用 | 分数降序，同分图数 |

档 2 的作用是捞回**词中间**的子串：查 `ress` 能命中 `red_dress`、`sundress`、`caress`，而词首档一个都给不了。**它不提供拼写纠错**——`getCandidates` 先按 trigram 预筛，`bleu` 与 `bluehair` 的 trigram 交集为空，Levenshtein 段根本走不到。

预筛与校验共用同一套「词首」定义（`matchStarts`），所以索引必然覆盖匹配器能接受的每个位置——这是构造保证，不是测试保证。

实测跨进程延迟（中位数）：单字符 `s` 查画师 17898 条 / 1037KB / 86ms；`bl` 1158 条 / 78KB / 5ms；`初音` 72 条 / 6KB / 1ms。加载完成后第一次查询约 609ms（V8 冷），之后稳定。**候选全量返回、不设条数上限**，渲染量由 CodeMirror 的 `maxRenderedOptions` 兜住——结果集大小与渲染成本是两件事。

**魔法书**复用 `TagExtrasLoader` 缓存的 `tag_browse.json` 与 `tag_gloss.json`（标签索引就绪后后台预热）。纯函数在 `main/tagdb/magicbook.ts`：分类树、整类列表、检索（匹配面同 browse_tags 的 `m`，多词同时命中；排序按标签名 › 释义 › 别名三档再按帖子数；传分类时先筛再截 500 条）、中文说明（带所属分类）、释义补充（只在查询含中文、补全偏好是 general 时，只匹配释义文字）。经 `magicbook:tree / list / search` 与 `tagdb:gloss` 暴露；`tagdb:complete` 的结果带 `gloss`，`glossMax` 控制追加多少条 `byGloss` 补充行（传了 `limit` 时封顶到剩余名额）。渲染进程的 D 站词条加载在 `state/wikiEntryLoad.ts`，WIKI 竖栏与魔法书各持请求代次。

---

## 出图与落盘

结构照搬画师串工具箱（错误分级、队列、落盘、记账的规则与文案都一致），领域从「画师串 × 例图」换成「一套提示词出 N 张」。

```
渲染进程  gen:start({ workspace, count })
   ↓
主进程 GenRunner（main/gen/runner.ts）
  预检：保存目录、NovelAI Token、已有一轮在跑 → 直接拒绝，不留轮次
  seed：每张随机逐张各随机；固定模式给了值全程用它，给 -1 就随机一次全程复用并立即写回参数区
  快照（本工具格式，只含参与本轮的角色）→ 拼接结果（按字段顺序拼接，画面文字按插件 applyTextRendering 接到末尾）
  _index.json 先记这一轮 → 队列逐张：请求 → 落盘 → 覆盖式记这一张 → gen:image
  429 暂停（这张留在队首，不记失败）；没填 Token / Token 失效 / 点数不足中止整批；其余错误按张重试
  终态才 finish；每张随机模式跑完把最后一张的 seed 写回参数区
```

**请求体按 koishi 插件的格式**，去掉负面预设与质量词（`ucPreset: 3`、`qualityToggle: false`）、不开 Variety Boost；透明背景才带 `straight_alpha`。角色负面词独立发送，与整图负面词互不相干。

**落盘**：`保存目录/YYYY-MM-DD/<5位序号>-<seed>.<ext>`，同目录 `_index.json` 记整轮快照、拼接结果与逐张记录。序号扫描目录取最大值 +1（重启、手删文件都不会乱）；图片字节原样落盘，不写自己的元数据。seed 取接口回报 → PNG 元数据 → 请求时的值。读取时 running/paused 推导为「已中断」，不回写。

**所有请求走 `appFetch`**；超时用 `raceAbort` 包住请求与读 body，不依赖 `net.fetch` 是否认 `AbortSignal`。

**界面**照工具箱：工具栏（跑图次数、生成、继续、取消、状态）贯穿全宽；左侧历史竖栏读最近「历史保留天数」天的轮次，跑图中最上面那条实时走进度；点「生成」自动弹出图弹窗，关掉不中断任务。弹窗里单击一张打开溯源信息——「本工具参数」是落盘的快照与拼接结果（快照带「LLM 请求」来源：LLM 回填成功时连同内容指纹记进工作区，生成时比对指纹判断回填后是否手改过，seed 不计；复制信息把来源随内容带回，见 `shared/llmProvenance.ts`），「图片元信息」直接读图片文件；双击格子或点预览图打开原图查看器（1:1 优先、滚轮缩放、拖拽平移）。图片一律经 `image:read` 读成 object URL，开发态与打包态一条路。

**复制信息**把快照整套覆盖到参数区，唯一例外是 seed：取图片元信息里的 seed（读不到用记录里的）并改成固定模式；固定模式在参数区与工具栏都有醒目提示。生成前 token 超限直接拦下，不发请求。

---

## WIKI 竖栏

右侧 400px 竖栏，按「画师 / 标签」两种数据源查 Danbooru，显示词条信息、wiki 正文、See also、例图；「跟随光标」时随正向提示词里光标所在的词自动查询；「加入」把当前词插回提示词里上次光标的位置。

**收起 = 整栏不渲染 + 不订阅光标广播**：开关是工具栏最右端的按钮（收起「◂ WIKI」、展开「WIKI ▸」高亮）。收起、跟随、数据源三项存 `localStorage`（`wiki.collapsed` / `wiki.follow-cursor` / `wiki.source`，读写 try/catch），读不到时默认展开、跟随开、标签源。

**数据流**：`PromptEditor`（整图与各角色的分块编辑器，`editorId` 分别是 `main` 与 `char:<id>`）在 `updateListener` 里对选区变化调 `cursorBus.emit`——但只在**有订阅者**时才取文档（`cursorBus.active()`），WIKI 栏收起或跟随关闭时没有订阅者，编辑器那侧零开销。WIKI 栏展开且跟随开着时订阅 `cursorBus`，用 `completionTargetAt(doc, specs, head)` 取光标处的词，交给 `useWiki.onCursorWord`（清洗掉 `{}`/`[]`/纯数字、同一个词不重复查询、400ms 防抖、`tagdb:lookup` 判定是否画师）→ `show(tag, source)` → 两源并发发请求；每次 `show` 带递增序号，旧序号的结果回来直接丢弃。

**标签源**：并发取 `tagInfo` + `wiki` + `posts`（最新 6 张，不排序。原先用 `order:score` 取评分最高，但 D 站对热门标签跑评分排序会数据库超时——百万帖级必返回 500、几十万帖级要 2–4 秒——已改为取最新）。wiki 正文里的 `!post #id` 内嵌图按页收集成 `id:1,2,3` 列表批量查询（每批最多 100 个），不逐张请求，免得几十上百个请求挤进全局令牌桶、把之后打开的词条一起堵住。**画师源**：并发取 `artist` + `wiki`，再用画师条目给的规范名（查不到就退回输入的规范化写法）查 `tags` 取总帖子数，`computePageBuckets` 算出新/中/旧三档页码（每页 20 张，各显示前 6 张；总页数不够分三档时退化显示现有页数，并提示「作品页数不足以分出新/中/旧三档」）。

**「加入」**：`editorRegistry.insertIntoLastEditor` 取最后聚焦的正向提示词编辑器与其当前选区，按 `insertTagAt` 规则（光标所在单元非空则插到单元末尾，自动补「, 」分隔）改写该字段并把焦点还回去；插不进去（从没聚焦过、那个框已卸载、改动被分块守卫拒绝）就退回 `clipboard:write-text` 并在词条头下方提示「已复制到剪贴板」。插入文本：画师是 `artist:` + 名字，所有 `_` 换成空格。

**NovelAI 额度**：顶栏那条来自 `GET {naiBaseUrl}/user/subscription`（移植自插件 `src/backend/nai-usage.ts`）。一次响应里既有剩余点数（`trainingStepsLeft`，赠送 + 购买）也有 V5 按时限额（`usage`）。`timeUntilNextPercent` 是「再涨 1% 需要多久」的恒定速率量，不是倒计时，文案必须写成「每 X +1%」。张数由设置里的 naiUsagePercentPerImage 换算——官方不给张数。查询走主进程（Token 不进渲染层），失败只在顶栏写一行，不影响出图。

**DText**：`shared/dtext.ts` 把 wiki 正文解析成节点树（标题降两级、列表、引用、代码块、行内样式、`[[内链]]`、外链、`!post #id` 内嵌图），`DText.tsx` 只负责渲染，不拼 HTML 字符串。内链点击在栏内切换词条；外链渲染成 `target="_blank"`，交给主进程 `setWindowOpenHandler`（只放行 http/https）用系统浏览器打开；站内相对链接补全成绝对地址。See also：识别标题文字为「see also」（不分大小写）的一节，把其中的内链收集成一行芯片，该节本身不进正文渲染。

Danbooru 失败是唯一的静默降级：不弹窗，只在词条头/正文/例图各自的区块里写一行灰字「D 站请求失败：原因」；本地标签库那部分（中文别名、分类）照常显示。

---

## 历史：三份不同的东西

一次生成产生三份互不相同的记录，分开存：

| | 存在哪 |
|---|---|
| 字段快照 + 参数 + 真正发出去的拼接结果 | `_index.json` 的一条记录 |
| 完整 LLM 对话（含 thinking、工具结果全文） | `llm/<transcriptId>.json` |
| 图片 | 日期目录下 |

LLM 对话落盘与 llmStale 在计划 5 实现。

对话单独落盘的原因：一轮 `search_tags` 的结果动辄几十 KB，塞进 `_index.json` 会拖垮历史列表启动时的全量扫描。

回填之后又被手工改过的记录会带 `llmStale` 标记，详情弹窗明确写出「这些参数在 LLM 回填后被手工改过，下面的对话不完全对应这张图」。

---

## 手机端

手机不是另一套后端，是主进程里多开的一个 HTTP 服务，业务全部转发到桌面端已有的那几样：`registerIpc` 返回的 `MainServices`（`GenRunner`、`LlmSession`、`AppEvents`、`configStore`、`stylesStore`、`workspaceStore`）在 `src/main/index.ts` 里建好之后，同一份引用既接给 IPC 也接给 `createMobileServer`——两条路走的是同一个在途保护、同一条事件总线，不会出现「IPC 说在跑，HTTP 说闲着」的两套真相。

**前端是独立子工程。** `src/mobile/` 用自己的 `vite.mobile.config.ts` 单独构建到 `out/mobile/`（`base: './'`，为以后 Capacitor 打包留的相对路径），由服务的静态托管把这个目录直接发出去；未知路径回落 `index.html` 给前端路由用，带扩展名的路径找不到就是真 404（回落成 HTML 会让浏览器拿着一份网页当 JS 解析，报错比 404 更难查）。它与桌面端渲染进程共用 `src/shared/`（字段定义、拼接、标红规则），不碰 `src/renderer/`——两套界面形态不同，没必要也不能共用 CodeMirror 那一层。

**鉴权与来源校验分两道闸。** 每个请求先看 `req.socket.remoteAddress`（`isPrivateAddress`），公网来源一律 403；绑定 `0.0.0.0` 只是为了让手机连得进来，不代表对外开放。过了这道才看令牌：`POST /api/pair` 用一次性配对码（4 位、5 分钟、用一次即废）换长期令牌，令牌只在 `devices.json` 里存哈希，明文只在配对那一次的响应里出现一次；之后每个请求带 `Authorization: Bearer`。两个例外（`/api/events`、`/api/image`）额外认 `?token=`——`EventSource` 和 `<img src>` 都没法带自定义请求头。响应一律不发 CORS 放行头，局域网里别的站点拿不到数据。

**LLM 与出图不新写一套。** `POST /api/llm/run`、`POST /api/gen/start` 校验入参后立刻回话（一轮动辄几十秒到十几分钟，手机上的 HTTP 请求、手机息屏都撑不住），真正的进度与结果一律走 `GET /api/events`（SSE）：`AppEvents` 上的 `llm`、`gen-progress`、`gen-image` 事件在 `routes.ts` 里转成手机认的 `MobileEvent` 形状再推给所有连接——这条转换故意分两套类型，SSE 是发到局域网上的，主进程内部事件以后加什么字段，不该自动漏出去。`LlmSession`、`GenRunner` 忙着时（不管是桌面端还是另一台手机发起的）新请求一律 409 `{ kind: 'busy' }`，`message` 是能直接显示的中文一句话。

**SSE 断线要能补，不能靠重发一轮。** 手机锁屏、切后台都会把长连接断掉，LLM 一轮跑完的时间点如果正好在断线期间，`llm-finished` 事件就永远收不到。做法是先落一条「最近一次跑完的结果」（挂在这台服务的 `SseHub` 上，一个服务一条，新的覆盖旧的）再推事件，手机重连后主动查一次 `GET /api/llm/last` 就能把回填补上，不需要用户重新发一遍指令。出图没有对应的补偿接口——落盘本身就是最终真相，重连后 `GET /api/history` 能看到跑完的那一轮。

**状态归属靠接口边界卡死，不是约定。** 手机的提示词、参数、指令区开关整包存在手机自己的 `localStorage`（`src/mobile/src/state.ts`），出图与 LLM 请求把这一份整包发过去；服务端处理这两个请求时**不读也不写** `workspace.json`——桌面端工作区是桌面端渲染进程自己防抖落盘的那一份，两边各管各的，免得出现「手机发一次请求，桌面端界面被悄悄改掉」。唯一的例外是 `POST /api/styles/:id/preset`（选为预设）：它读桌面端 `workspace.json`、只改 `console.presetId`、其余字段原样写回，然后 `events.emit({ kind: 'preset-changed', presetId })`——光落盘不够，桌面端渲染进程的工作区是内存态，不知道磁盘被改过，这条事件经 `ipc.ts` 广播给所有窗口，指令区才会跟着换名字。这是全服务唯一被允许写桌面端工作区的路径；画风内容本身（`styles.json`）两边共用、直接读写，不用走事件。

---

## 不静默降级

| 情形 | 必须让用户看见 |
|---|---|
| 标签库缺文件 | 关掉对应工具并写明是哪个文件 |
| token 超上限 | 生成前拦下，指出最长的块 |
| LLM 没调生成工具就结束 | 明说「模型没有给出参数」，原样显示它说了什么 |
| 参数做过规范化 | 在交互区列出处理说明 |
| 画风锁定退化 | 写明已退化成不锁定 |
| 导入 PNG 有字段缺失 | 列出哪些字段用了默认值兜底 |
| 429 暂停 / Token 失效中止 | 说明原因与下一步 |

Danbooru 失败是唯一的静默降级——它只是辅助查询，断网不该挡住出图。

---

## 从插件继承的兜底

这些是提示词压不住、只能靠代码处理的结构性缺陷：

- `sanitizeLlmArgs` — 递归解 HTML 实体
- `repairLlmArgs` — 后续参数漏进某个字符串值的尾部时还原成真参数；本该是数组/对象却收到 JSON 文本时解析回来，坏掉一个对象不连累其余
- `toQueryList` / `toCharacterList` — 查询词的任意形状（类数组对象 `{"0":…}`、包装对象、嵌套数组）归一成列表，不丢内容
- `buildAssistantContent` — assistant 轮次**原样回传 API 原始 content 块**。`thinking` 块带 signature，从 text + tool_use 重建会丢掉它，下一轮请求直接 400。OpenAI 兼容端点同理带回 `reasoning_content`
- `finalizeArgs` **就地修改**参数而不返回副本——参数会被三处消费（回填、落盘、展示），只在一条路径上处理会让另外两处是未处理版本

---

## 测试分层

纯函数优先。主进程模块不碰 `window`；渲染层里要被测的模块不在模块求值期碰 `window`，否则 node 环境 `import` 当场 ReferenceError。

| 层 | 跑的时机 |
|---|---|
| 单元 | 每次改动后，毫秒级，必须始终绿 |
| 集成 | 各步合并组装时 |
| 人工验收 | 合并后，用 `npm run preview` 跑构建产物——不是 `dev`，`dev` 下 `file://` 图片会被拦 |

每步都跑全量太慢，性价比不划算。

---

## 已知问题（暂缓）

**分块编辑器的排版不变式没有自动化测试。** 折行位置、光标坐标、框不被拆开，这些只能在真浏览器里量，node 环境的单元测试覆盖不到。落地时是用 Playwright 驱动 Electron 实测的（480~1586px 每 9px 一档的宽度扫描、随机打字模糊测试，并用故意改坏的版本确认检测有区分力），但那些脚本没有进仓库，改动编辑器的版面或装饰结构之后，要重新做一遍同等强度的实测。

**块尾有空格时，拼接逗号可能暂时落到行首。** 比如正在打 `smile, `：逗号前是普通空格，按断行规则空格之后可以折，宽度恰好卡在那里时逗号会换到下一行开头。打出下一个字就恢复。

## 明确不做

对比与矩阵（后续另想形式）、队列、权限配额、参考图（Vibe Transfer / Character Reference）、Web Search、图片防和谐、SD WebUI 后端、LoRA、多轮对话上下文。
