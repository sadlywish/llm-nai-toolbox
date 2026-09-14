## 多角色写作细则
该块生成的内容写在"characters"字段内，不要混合在其他参数中
### 顶层 vs 角色，边界要清晰

| 内容 | 写在哪 |
|---|---|
| 总人数（2girls / 1girl 1boy） | 顶层 count |
| 质量词（masterpiece、very aesthetic 等） | 顶层 quality |
| 分级标签 rating:xxx | 顶层 count |
| 场景、时间、天气、光源方向、氛围 | 顶层 environment |
| 整体景别（upper body / cowboy shot） | 顶层 count 或 tags |
| **该角色的性别标记** `girl` / `boy` / `other` | 该角色 count |
| 角色名、发色、瞳色、发型、服装、配饰 | 该角色 appearance |
| 该角色的动作、姿势、表情、视线 | 该角色 tags |
| 该角色专属的负面词 | 该角色 negative_prompt |

### 角色里绝对不写的四类内容

1. **画风 / 画师** —— 画风是整幅画的。写进单个角色会让各角色画风互相打架
2. **背景 / 场景 / 光影 / 天气** —— 在每个角色里重复一遍，等于让模型画 N 次背景
3. **分级标签**（`rating:general` 等）—— 整幅画的属性
4. **质量词**（`masterpiece`、`very aesthetic`、`no text`）—— 同上

> 系统会在发请求前把这些内容从角色里剥掉并在日志告警，但别指望兜底——
> 关键词能识别，"garden background" 这种自然表述识别不了。


### 性别标记：写 `girl` 不是 `1girl`

官方原文：总人数标签"should always go into the **base prompt**
(e.g. `2girls, 2boys, outdoors`), then in each **character prompt**,
just specify `girl`, `boy`, or `other`, **without a number**"。

这一栏对应官方界面上每个角色的性别选择器。写成 `1girl` 会让模型在该角色位置上
再数一次人，容易多画出人来。

### 每个角色必须有区分度

多角色最常见的失败是"角色特征串味"（character bleeding）——
两个角色长得越像、描述越含糊，模型越容易把特征混在一起。

- **每个角色至少写清发色 + 瞳色 + 一件标志性服饰**，即使用户没提
- 两个角色发色相同时，用发型、服装、配饰拉开差距，并在 nltags 里点明区别
- 角色数越多，每个角色的描述越要短而准——堆细节反而加剧串味
- 角色的 appearance 里不要写别的角色的特征，哪怕是"和另一个人穿一样的衣服"

### 位置

- position 用归一化坐标 `"x,y"`，**0~1 的比例值**，x 左→右，y 上→下
- 常用布局：

| 场景 | 坐标 |
|---|---|
| 两人并排 | `"0.3,0.5"` / `"0.7,0.5"` |
| 三人并排 | `"0.2,0.5"` / `"0.5,0.5"` / `"0.8,0.5"` |
| 四人 | `"0.2,0.5"` / `"0.4,0.5"` / `"0.6,0.5"` / `"0.8,0.5"` |
| 一近一远 | 近 `"0.35,0.65"` / 远 `"0.65,0.4"` |
| 上下分层 | 上 `"0.5,0.3"` / 下 `"0.5,0.7"` |
| 居中单人 | `"0.5,0.5"` |

- 坐标是**构图倾向而非硬约束**，官方称之为"a nudge"，模型会在此基础上调整
- 人物贴边容易被裁切，除非刻意要出血，否则 x/y 尽量留在 0.15~0.85
- 亲密互动（拥抱、接吻）的两人坐标要靠近，如 `"0.42,0.5"` / `"0.58,0.5"`；
  拉太开会让模型倾向于画成两个独立个体
- 坐标之外，构图关系仍要在顶层 tags 和 nltags 里写清（如 back to back、
  side by side、one behind another）

### 互动方向标记

NovelAI 用**前缀**标记动作方向，贴在动作词前面，不加空格：

- 发起方：`source#动作`
- 承受方：`target#动作`
- 双向：两边都写 `mutual#动作`

| 场景 | 角色A | 角色B |
|---|---|---|
| A 抱 B | `source#hug` | `target#hug` |
| A 亲 B | `source#kiss` | `target#kiss` |
| 互相对视 | `mutual#eye contact` | `mutual#eye contact` |
| A 牵 B 的手 | `source#holding hands` | `target#holding hands` |
| A 递东西给 B | `source#handing over` | `target#handing over` |

注意事项：

- 官方明确说明这个语法"并非总是可靠"，所以**动作本身还要正常写一遍**：
  角色A 写 `source#hug, hug`，不要只留标记
- 顶层 tags 也要写上这个互动（如 `hug`），让模型知道整幅画在发生什么
- 没有跨角色互动时，绝对不要写这些标记——空标记会干扰模型

### 数量与取舍

- 2~4 个角色效果最稳；再多需要每个角色的描述都非常精简
- 画面里的路人、背景人群不要占用角色位，直接写进顶层 environment
  （如 `crowd, blurry background people`）
- 如果某个"角色"其实只是道具或宠物，也走顶层，不要占角色位

### nltags 的分工

- 顶层 nltags 仅描写：构图、角色之间的空间关系与互动、场景、光照。
- *顶层nl不需要在顶层复述分拆到角色部分的TAG出现的细节描述
- 角色的 nltags 只写这个角色自己，角色的NL部分需要完整覆盖角色自身的所有描述TAG
- **顶层 nltags 必须点明谁在哪、谁对谁做什么**，这是坐标和 source#/target# 之外最有效的一层保险
