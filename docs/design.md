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
| `main/nai/` | 出图、PNG 元数据、zip 解包、落盘记账 |
| `main/danbooru/` | 只服务右侧 WIKI 区 |
| `main/tagdb/` | 本地标签库：检索、分类浏览、释义、角色特征、补全 |
| `main/llm/` | Claude 与 OpenAI 兼容双端点、工具定义、多轮 tool_use 循环 |
| `main/gen/` | 顺序发 N 张，无队列无并发控制 |
| `shared/` | 字段定义、分块文档的序列化与判定、token 计算——纯函数，两端共用 |
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

单个 CodeMirror 文档，用不可见的 `U+001F` 把十个字段切成**固定十段**，每个分隔符渲染成一个字段徽章，段落本身上底色。

段结构由 transaction filter 守着，**永不增减**——空字段也占位。这让光标归属与边界保护变成纯粹的区间判断，不需要处理「段被创建/销毁」的中间态。

文档永远是**单行**：一个字段值里混进换行，所有按字符位置算的区间就全部错位。这条不靠每个写入点各自留心，而是结构性地兜住——`sanitizeFieldText` 在每次写入时剥掉分隔符与换行，`isWellFormed` 也把两者都当损坏来判。没有哪个任务的验收专门测过回车或多行粘贴，这条不变量是事后从一个漏洞里补出来的，不是计划里写好的。

两条规则处理方式故意不同：

- 改动范围**跨越分隔符** → 整笔拒绝。裁剪的语义（保留哪一段？）没有唯一正确答案，猜错就是静默改坏用户的内容。
- 插入的**文本里含分隔符**（从别处粘来的） → 剥掉再插入。这里语义唯一，拒绝反而是「粘贴毫无反应」这种莫名其妙的表现。

装饰区间的计算放在 `shared/` 而不是编辑器文件里，且不 import CodeMirror——`Decoration` 必须在浏览器环境构造，掺进来这段就没法在 node 里单测，而区间算错正是最容易出、也最容易漏的那类 bug。

### 整图与角色是两套字段集

| | 整图（10 项） | 角色（5 项） |
|---|---|---|
| 字段 | `count style character artist appearance tags environment series nltags quality` | `count character appearance tags nltags` |
| `count` | 总人数、构图、镜头，自由标签 | 该角色的性别标记，`girl`/`boy`/`other` 三选一，渲染成选择器 |
| `character` | 多角色模式下必须留空 | 该角色的角色名 |

`negative_prompt` 与 `position` 是角色的**参数不是字段**，有各自的独立输入，绝不进分块流。

编辑器组件**接受字段集作为参数**，不引用任何模块级字段常量。

---

## 画风注入

三选一，决定 LLM 返回的 `artist` 字段怎么处理：不覆盖 / 用选用的预设覆盖 / 用编辑框当前内容覆盖。

后两档会把最终画风以 `[画风已锁定: …]` 注入上下文并要求模型不要写 `artist`。既然写了也会被丢，提前告知既省 token，又让 `appearance` 与 `environment` 不至于写出跟画风打架的内容。

两处退化明确处理：选了预设覆盖但预设列表为空 → 该项置灰；选了保持当前但 `artist` 块本来就空 → 退化成不锁定并写明，而不是注入一个空画风让模型犯迷糊。

---

## 本地标签库

随安装包分发，分文件惰性加载：`tags_index_v2`(29MB) 启动后异步载入，`tags_detail_v2`(41MB)、`tag_browse`、`tag_gloss`、`character_features` 各自首次用到才加载。

插件用的是同步 `readFileSync` + `JSON.parse`，搬到 Electron 主进程会卡住启动，所以改了加载策略。

**缺文件时对应的 LLM 工具直接不注册**，并在界面写明是哪个文件。不注册一个会失败的工具，也不静默降级。

检索沿用插件的三层：CJK 变体归一化 → Levenshtein 编辑距离 → Trigram 倒排索引预筛。标签转义风格取 NovelAI 的——它的加权语法不是 `()`，按 SD 那套转义反而会把反斜杠写进提示词。

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

**光标停在一个段的末尾时，会被画到下一个框的左缘。** 偏差约 21.4px（本框右内边距 8px + 下一框左外边距 14px）。文字内部的位置一律正确，只有段边界这一个位置错。

原因是段边界没有真实文本节点：分隔符被 `Decoration.replace` 隐藏，空段的整块由 widget 合成，CodeMirror 只能把那个位置的坐标解析到相邻元素上。非空段后面跟着非空段时，靠「把分隔符收进前一段的 mark」可以修好；但后面跟着空段时那个分隔符上挂着空段的 pill，widget 会被提到 mark 外面，这一招失效——而默认状态下后续段全是空的。

暂缓不修。相关的判定逻辑（`prefersBackwardAssoc`）与已生效的部分修法保留在代码里，注释记录了各条路径的实测结论。

## 明确不做

对比与矩阵（后续另想形式）、队列、权限配额、参考图（Vibe Transfer / Character Reference）、Web Search、图片防和谐、SD WebUI 后端、LoRA、多轮对话上下文。
