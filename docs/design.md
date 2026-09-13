# 设计说明

llm-nai-toolbox 的架构与关键取舍。使用方法见 [README](../README.md)。

---

## 一句话

把 `koishi-plugin-reforge` 的 LLM 交互层搬到桌面，界面与工程骨架取自「画师串工具箱」，**只保留 NovelAI**，并把「LLM 直接出图」改成「LLM 只回填字段，人确认后出图」。

> 权威定义在代码里：字段看 `src/shared/fields.ts`，段结构看 `src/shared/blockDoc.ts`。本文若与代码冲突，以代码为准。

---

## 进程模型

主进程包办全部 IO 与外部请求；渲染进程 `contextIsolation` 打开、不发任何外部 HTTP 请求。所有网络走 Electron 的 `net.fetch`，因此 NovelAI 接口、Danbooru 接口与例图共用同一处代理设置。

渲染进程里唯一的例外是 `<img src>` 加载 Danbooru 图片——它走 Electron session 的代理，与 `net.fetch` 是同一处配置，不必另开一条 IPC 通道。

### 模块

| 目录 | 职责 |
|---|---|
| `main/net.ts` | `appFetch`（`net.fetch`）与代理应用；主进程所有外部请求都走它 |
| `main/store.ts` · `config-store.ts` · `secret-store.ts` | `workspace.json` / `config.json` / `secrets.json` 的原子读写；密钥用 `safeStorage` 加密 |
| `renderer/components/` | 提示词面板、参数区、角色面板、设置抽屉——布局与交互照画师串工具箱 |
| `main/nai/` | 出图、PNG 元数据、zip 解包、落盘记账 |
| `main/danbooru/` | 只服务右侧 WIKI 区 |
| `main/tagdb/` | 本地标签库：检索、分类浏览、释义、角色特征、补全 |
| `main/llm/` | Claude 与 OpenAI 兼容双端点、工具定义、多轮 tool_use 循环 |
| `main/gen/` | 顺序发 N 张，无队列无并发控制 |
| `shared/` | 字段定义、分块文档、配置与工作区的类型/默认值/校验/自愈、token 计算——纯函数，两端共用 |
| `renderer/editor/` | CodeMirror 接线：装饰、守卫、快捷键 |

`shared/fields.ts` 是字段的唯一事实来源。分块装饰、提示词拼接、LLM 工具 schema 全部从这里取——各写一份必然漂移，漂移的表现是「界面上有这个块，拼接时被漏掉」。

---

## 一次 LLM 轮次

```
渲染进程  llm:run({ instruction, editMode, fields, characters, styleLock })
   ↓
主进程 runner
  1. system = 系统提示词 + 多角色附加 + SKILL 文档 + 分类目录 + 尾部注入
  2. user   = 指令 + [质量词] + [负面词] + [画风已锁定]
            + 修改模式开启时追加 <现有参数> 快照
  3. 循环 ≤ maxToolRounds：
       工具集 = generate_image(或 _characters) + search_tags
              + browse_tags + search_character_features + load_tag_manual
       调 LLM，逐事件推给渲染进程
       搜索类本地执行；命中生成工具即收口
       置信度 ≥ 0.85 → 下一轮撤掉搜索工具
       倒数第一轮只给生成工具，强制收口
   ↓
{ fields, characters, aspectRatio, seed, notices[], transcriptId }
   ↓
渲染进程写入分块编辑器与参数区
   ↓
「自动生成」开着 → 立即 gen:start
```

**每次发送都是全新一轮**，不累积对话历史。想在现有内容上改，用「修改模式」开关把编辑器当前内容一并送出。

工具名与 schema 与插件完全一致——那几份成品系统提示词（共 35KB）通篇引用这些名字，改名等于全部作废。差别只在 `generate_image` 的处理函数：它把参数交回渲染进程，而不是调 NovelAI。

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
- **同一个装饰来源里，范围相同的两个 mark 谁在外没有保证。** 增量更新时会建出不一致的嵌套，把一个框拆成几段，每段各画一个 `::before` 徽章（实机：中文后打空格再打字，徽章重复出现）。所以装饰分四个来源，靠来源优先级固定内外：拼接逗号 > 框 > 标签 > 全角逗号标红。以后再加 mark 装饰，优先级必须高于框那一层。
- **光标坐标不靠 `selection.assoc`。** 分隔符两侧的位置语义是固定的（前一段末尾 / 后一段起点），由分隔符 widget 的 `coordsAt` 直接给坐标。先前靠 assoc 的写法从未生效过：`dispatch({ selection: EditorSelection.cursor(pos, -1) })` 会被 state 用 `EditorSelection.single(anchor, head)` 重建，assoc 当场丢失。

### 整图与角色是两套字段集

| | 整图（10 项） | 角色（5 项） |
|---|---|---|
| 字段 | `count style character artist appearance tags environment series nltags quality` | `count character appearance tags nltags` |
| `count` | 总人数、构图、镜头，自由标签 | 该角色的性别标记，`girl`/`boy`/`other` 三选一，渲染成选择器 |
| `character` | 多角色模式下必须留空 | 该角色的角色名 |

`negative_prompt` 与 `position` 是角色的**参数不是字段**，有各自的独立输入，绝不进分块流。

编辑器组件**接受字段集作为参数**，不引用任何模块级字段常量。

### 工作区与设置

一份工作区（`workspace.json`）：整图字段、画面文字、负面词、生成参数、角色列表、坐标定位开关。编辑防抖 500ms 落盘，关窗前同步冲刷一次。读回来的任何形状都先过 `normalizeWorkspace`：缺的补默认、类型不对的回默认、字段值里的换行剥掉、重复的角色 id 重新生成——重复 id 会让两个角色共用一个编辑器实例与撤销栈。

**画面文字不是字段**：它在提示词拼接完之后才接到末尾，提示词排序里没有它的位置，所以单独一个输入框。

设置（`config.json`）读写都过 `mergeConfig`：逐项按默认值的类型取用，只补缺不回退——存的是空串就是空串，随包默认文案只在文件不存在时出现一次（设置抽屉的「恢复默认」除外）。枚举、数值规则、字段顺序不合法的项回到默认值。

**字段顺序串必须恰好包含全部字段。** 它同时决定拼接顺序与编辑器里块的先后；插件允许漏写字段（漏掉的不拼接），这里不允许，否则会有一个看得见却发不出去的块。

API Key 在 `secrets.json`，渲染进程只知道「有没有存过」，明文不进渲染进程。

---

## 画风注入

三选一，决定 LLM 返回的 `artist` 字段怎么处理：不覆盖 / 用选用的预设覆盖 / 用编辑框当前内容覆盖。

后两档会把最终画风以 `[画风已锁定: …]` 注入上下文并要求模型不要写 `artist`。既然写了也会被丢，提前告知既省 token，又让 `appearance` 与 `environment` 不至于写出跟画风打架的内容。

两处退化明确处理：选了预设覆盖但预设列表为空 → 该项置灰；选了保持当前但 `artist` 块本来就空 → 退化成不锁定并写明，而不是注入一个空画风让模型犯迷糊。

---

## 本地标签库

随安装包分发。计划 2 只加载 `tags_index_v2`(29MB)，启动后异步读盘；`tags_detail_v2`(41MB)、`tag_browse`、`tag_gloss`、`character_features` 留给计划 3，各自首次用到才加载。

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

---

## 历史：三份不同的东西

一次生成产生三份互不相同的记录，分开存：

| | 存在哪 |
|---|---|
| 字段快照 + 参数 + 真正发出去的拼接结果 | `_index.json` 的一条记录 |
| 完整 LLM 对话（含 thinking、工具结果全文） | `llm/<transcriptId>.json` |
| 图片 | 日期目录下 |

对话单独落盘的原因：一轮 `search_tags` 的结果动辄几十 KB，塞进 `_index.json` 会拖垮历史列表启动时的全量扫描。

回填之后又被手工改过的记录会带 `llmStale` 标记，详情弹窗明确写出「这些参数在 LLM 回填后被手工改过，下面的对话不完全对应这张图」。

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
- `toArray` — 类数组对象 `{"0":…,"1":…}` 还原成数组
- `buildAssistantContent` — assistant 轮次**原样回传 API 原始 content 块**。`thinking` 块带 signature，从 text + tool_use 重建会丢掉它，下一轮请求直接 400
- 参数规范化**就地修改**而不返回副本——参数会被三处消费（发送、落盘、展示），只在发送路径处理会让落盘与展示是未处理版本

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
