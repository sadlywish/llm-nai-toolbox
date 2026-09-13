# llm-nai-toolbox

用 LLM 把一句中文需求翻译成 NovelAI 的结构化提示词，人确认后出图。

![状态](https://img.shields.io/badge/状态-设计完成，未开始实现-e0a458) ![平台](https://img.shields.io/badge/platform-Windows%20x64-555)

> **现在还不能用。** 仓库里只有设计规格与第一份实现计划，没有可运行的代码。下面的「怎么用」写的是做完之后的样子，先放在这里当验收标准。

---

## 它做什么

你在底部对话框里说一句话，模型去本地标签库里查标签、挑词，然后把结果**按字段填进编辑器**——人数构图归 `count`、画师归 `artist`、外观归 `appearance`、场景归 `environment`，各归各位。你看一眼、改几处，点生成。

它和直接拿聊天机器人写提示词的区别在于：产出是**结构化的十个字段**而不是一整串文本，所以每一段是什么、该不该改、改哪里，都看得见。

```
一句话需求 → LLM 多轮查标签 → 回填十个字段 → 你确认/微调 → NovelAI 出图
                                              ↑
                                    「自动生成」开着就跳过这一步
```

**只做 NovelAI。** 不接 SD WebUI / Forge。

---

## 怎么用

### 分块提示词编辑器

十个字段常驻，空的也占位——没有「未使用」这一说：

| 字段 | 放什么 |
|---|---|
| `count` | 人数、构图、镜头 |
| `style` | 画风标签 |
| `character` | 角色名 |
| `artist` | 画师名 |
| `appearance` | 发型、发色、瞳色、体型、服装、饰品 |
| `tags` | 动作、姿势、表情 |
| `environment` | 环境、背景、光影 |
| `series` | 作品名 |
| `nltags` | 自然语言补充 |
| `quality` | 质量词 |

文字连续流动不分栏，每段前挂一个字段徽章，底色区分。几件不那么显然的事：

- **块边界删不穿。** 退格到段首是跳到上一段末尾，不会把两段并成一段。空段也删不掉。
- **屏幕上占位，输出里不占位。** 空段拼接时整段跳过，不会留下多余逗号。
- **全角逗号只在标签类字段标红。** `nltags` 写的是中文自然语言，句子里的中文逗号合法，不标。
- **粘贴不自动拆分。** 从别处贴进来的整段提示词落在当前段，要拆另点「交给 LLM 拆分到各块」——猜错的代价比多点一下大。
- **`Ctrl + ↑/↓`** 调整光标所在权重，步进 0.05。

### LLM 对话

顶部是指令区：输入指令，下面一排是和 LLM 交互的开关——多角色（关闭 / 位置由模型安排 / 手动指定坐标）、在现有内容上修改、透明背景、画风。Ctrl+Enter 发送。

**每次发送都是全新一轮**，不累积历史。想在现有内容上改，打开「在现有内容上修改」——编辑器、负面词、参数、角色的当前内容会一起送出去。

日志区照 koishi 日志一行一条滚动（本轮工具集、每条搜索的匹配、token 用量……），顶部一条状态与「中止」。成功时把最终参数直接回填进编辑器、负面词、参数区与角色区；模型没给参数、请求失败、中止时编辑器内容一律不动。seed 不归模型管，由参数区决定。

### 画风注入

三选一，决定 LLM 返回的 `artist` 字段怎么处理：

| | |
|---|---|
| 不覆盖 | 原样写入 |
| 用选用的预设覆盖 | 丢弃模型返回的，写入预设下拉选中的那条 |
| 用当前 artist 块覆盖 | 丢弃模型返回的，保留 `artist` 段现有内容 |

后两档会把最终画风以 `[画风已锁定: …]` 告诉模型，让它别再写 `artist`，也别写出跟画风打架的外观和场景。

预设在顶栏的「画风维护」里维护：每条一个页签，名称 + 标签，改动即保存。指令区的预设下拉只列标签非空的预设。

### 右侧 WIKI 区

搜索走 Danbooru，**画师**与**标签**两种数据源用开关切。开着「跟随光标」时按光标所在的词自动切——落在画师词上切画师源，其余切标签源。

标签源会渲染 wiki 正文（含内嵌图），并把 `See also` 单独提成一行可点的相关标签。

### 历史

每张图存三份互不相同的东西：字段快照、**真正发给 NovelAI 的拼接结果**、产出这些字段的完整 LLM 对话。详情弹窗里参数分「分块 / 拼接结果」两个 Tab，对话独立一栏。

回填之后又手工改过的记录会被标上 `llmStale`——那张图不完全对应那段对话，弹窗里会写明。

---

## 构建

```bash
npm install
npm run dev        # 开发
npm run build      # 构建到 out/
npm run preview    # 跑构建产物，验收用这个
npm run dist       # 出 NSIS 安装包与便携版到 release/
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

Electron 31 + electron-vite + React 18 + TypeScript(strict) + zustand + CodeMirror 6。

主进程包办全部 IO 与外部请求；渲染进程 `contextIsolation` 打开、不发任何外部 HTTP。所有网络走 Electron 的 `net.fetch`，因此 LLM 接口、NovelAI 接口、Danbooru 接口与例图共用同一处代理设置。

### 构建前要自己放的文件

**标签库**（`resources/tagdb/`）。加起来 80MB+，不进仓库，但随安装包分发：

| 文件 | 体积 | 用途 |
|---|---|---|
| `tags_index_v2.json` | 29MB | 搜索索引与补全 |
| `tags_detail_v2.json` | 41MB | wiki 与展示字段 |
| `tag_browse.json` | 4.6MB | 分类浏览 |
| `tag_gloss.json` | 1.3MB | 中文释义与辨析 |
| `tag_deprecated.json` | 2KB | 废弃标签提醒 |
| `character_features_v2.csv` | 5.5MB | 角色官方外观 |

缺哪个，对应的 LLM 工具就**不注册**并在界面写明是哪个文件——不静默降级成一个会失败的工具。`tags_detail_v2.json` 只在设置里打开了任一类「返回 wiki」时才会被读。

**默认提示词**（`resources/prompts/`）。仓库里是空文件，需要自己填：

| 文件 | 对应配置项 |
|---|---|
| `system.md` | 主系统提示词 |
| `character.md` | 多角色附加提示词 |
| `tail.md` | 尾部注入（可以为空） |
| `quality.txt` | 质量词 |
| `negative.txt` | 默认负面提示词 |

这些是**初始化默认值，不是空白回退**：只在首次启动（`config.json` 不存在）时写进配置一次。之后配置里留空就是留空，不会被默认值悄悄顶回来。每个提示词框旁边有「恢复默认」按钮——升级不覆盖已有配置，那个按钮是拿到新版文案的唯一路径。

**随包文档**（`resources/prompts/tag-skill-core.md`、`resources/tag-manuals/`）。取自 koishi-plugin-reforge 现有版本，已在仓库里：前者常驻追加到系统提示词末尾，后者是 `load_tag_manual` 工具可调取的主题手册（设置里开启）。不进配置，构建时打进应用。

---

## 数据存在哪

`%APPDATA%\llm-nai-toolbox\`

| 文件 | 内容 |
|---|---|
| `config.json` | 设置项，**不含任何密钥** |
| `secrets.json` | NovelAI Token、LLM API Key、Danbooru API Key，用系统 DPAPI 加密 |
| `workspace.json` | 分块内容、参数、角色——你的工作状态 |
| `styles.json` | 画风预设（名称 + 标签） |
| `danbooru-cache/` | 画师条目与 wiki 的磁盘缓存 |

出的图不在这里，在设置的保存目录下按日期分子目录。同目录有 `_index.json` 记账、`llm/` 存每轮的完整对话。

加密绑定当前 Windows 用户，换机器/换用户后旧密文解不开，会当作「未设置」让你重填。

---

## 文档

| 文件 | 内容 |
|---|---|
| [设计说明](docs/design.md) | 架构、进程模型、一次 LLM 轮次的形状、分块编辑器的段结构、标签库、历史、容错清单 |
| [分块编辑器预览](docs/block-editor-preview.html) | 双击打开，看编辑器长什么样 |

---

## 来源

LLM 交互层（多轮 tool_use 循环、本地标签检索、字段化提示词拼接）来自 `koishi-plugin-reforge`。界面与工程骨架来自 `画师串工具箱`。

相对插件砍掉的：SD WebUI / Forge 后端、串行队列、群权限与每日配额、LoRA、参考图（Vibe Transfer / Character Reference）、Web Search、图片防和谐、多轮对话上下文。

## 许可

MIT
