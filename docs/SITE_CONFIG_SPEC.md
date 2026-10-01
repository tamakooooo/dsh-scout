# 网站配置与定位语言规格

对应开发计划 §3.1。这份规格是 S1 的开工前置：**agent 与插件之间唯一的契约**。定稿前不动 S1 的实现代码。

## 1. 一条硬规则：配置里永不出现 ref

现有快照的 `ref` 是 `'e' + 序号`，由**本次快照收集到的元素顺序**决定；`perform()` 靠它在同一份 DOM 状态下找回节点。任何 DOM 变动都会让旧 ref 指向别的元素。

所以：

- **配置只存定位器（locator），不存 ref。**
- **每次动作前重新解析**定位器，并重新核对前置条件。
- ref 仍然只用于「一次决策到一次执行」之间，不进磁盘。

## 2. 定位器：一个封闭的谓词集合

定位器是**对象**，不是字符串。键集合封闭：出现未列出的键即拒绝该配置。

```json
{
  "tag": "button",
  "role": "button",
  "text": { "equals": "打招呼" },
  "attr": [{ "name": "data-id", "equals": "..." }],
  "href": { "matches": "resume/(\\d+)" },
  "nth": 0,
  "within": { "tag": "div", "attr": [{ "name": "data-role", "equals": "card" }] }
}
```

| 键 | 语义 |
| --- | --- |
| `tag` | 标签名，小写 |
| `role` | 可访问角色 |
| `text` | 四者之一：`equals` / `contains` / `token`（整词）/ `matches`（正则），比对规范化后的可见文本 |
| `attr` | 数组，每项 `{ name, equals \| contains \| token \| matches }`。**类名一律用 `token`**：真实页面上 `contains: "recommend-item"` 会连带匹配所有 BEM 后代（`recommend-item__header` 等），把 20 张卡片变成 80 个 |
| `href` | 仅链接，取 `href` 属性 |
| `nth` | 过滤**之后**按下标取一个，0 起 |
| `within` | 在该定位器命中的元素**内部**再解析 |

- 所有条件**取交集**；`nth` 在交集之后生效。
- **不接受原始 CSS 字符串。** 理由：CSS 最容易写成 `km-carousel__item-wrapper--active` 这类生成类名，改版必碎，而且插件无法告诉人「是哪一条条件失效了」——谓词集合的每一条都可以被单独报告、单独排序。
- 需要匹配类名时用 `attr` 的 `contains`，并且该条会被标记为**不稳定条件**（见 §7）。

## 3. 卡片内相对定位：唯一需要两阶段的地方

招聘页面最核心的需求是「**第 N 张卡片里的打招呼按钮**」，而扁平快照表达不了卡片边界。用**卡片枚举 + 卡内定位**两阶段表达：

```json
{
  "cards": {
    "locator": { "tag": "li", "attr": [{ "name": "class", "contains": "card" }] },
    "sample": 20,
    "identity": { "from": "href", "matches": "resume/(\\d+)" }
  },
  "fields": {
    "name":  { "locator": { "attr": [{ "name": "class", "contains": "name" }] } },
    "city":  { "locator": { "text": { "matches": "^(北京|上海|广州|深圳).*" } } }
  },
  "actions": {
    "greet":  { "scope": "card", "type": "click", "locator": { "text": { "equals": "打招呼" } } },
    "detail": { "scope": "card", "type": "click", "locator": { "text": { "equals": "查看" } } }
  }
}
```

解析规则：

1. 用 `cards.locator` 枚举卡片容器。
2. 对每张卡片，在**该卡片元素内部**解析 `actions.*.locator` / `fields.*.locator`。
3. 卡内必须**恰好命中一个**。命中 0 个或 ≥2 个 → **该卡片的这个动作被拒绝**，并给出原因；不许猜、不许退化成「第一个」。
4. `identity` 从卡片或卡内链接提取稳定 ID；**提取不到就不参与跨次去重，也不自动发送**。

## 4. inspect：返回结构与预算

**实现说明**：工具名是 `browser_inspect`，而不是给 `browser_snapshot` 加一个 `inspect` 模式。两者输出的**字段集合完全不同**（快照是文本＋扁平元素表，inspect 是有界节点树＋重复组），塞进一个工具只能靠联合 schema 表达，还会弄脏原来那句「这就是决策层看到的状态」。拆分后各自的 schema 都是封闭的，各自可校验。

新的读取工具 `browser_inspect` 返回：

- `snapshotId`、`targetId`
- `cards`：最多 `sample`（默认 20）张卡的公共结构，不是每张卡的完整 DOM
- 每个节点：`tag`、`role`、`text`（截断 40 字）、`attributes`（过滤后）、`stable`（按属性逐项标注）、`childCount`、`index`
- `containers`：滚动容器与弹窗状态

**预算（必须是明确数字，且可配置）**：

| 项 | 默认 | 上限 |
| --- | --- | --- |
| 树深度 | 6 | 10 |
| 节点数 | 120 | 300 |
| 每节点保留属性 | 5 | 8 |
| 卡片采样 | 20 | 50 |
| 总字符 | 12000 | 40000 |

属性过滤：保留 `data-*`、`id`、`name`、`type`、`href`、`role`；类名**只在看起来稳定时**保留。

**稳定性判定**（`inspect` 逐项标注，供 agent 优先选择）：`data-*` → 稳定；`id` 含连续 4 位以上数字或哈希样后缀 → 不稳定；类名含哈希样后缀或连续数字 → 不稳定；`--modifier` 形式的状态修饰符 → 单独标注为状态，不作定位依据。

列表 DOM 很容易上万 token，所以这里不是「尽量完整」，而是**固定预算下的采样**。

## 5. 动作类型枚举

`read | click | type | scroll | wait`

- `read`：无副作用，任意位置可用。
- **没有 `select`**：执行器没有它的语义。词汇表里写一个没人实现的动作，等于邀请配置声明一个悄悄什么也不做的步骤；等执行器支持时再加回来。
- `click / type / select`：配置里**必须声明** `effect: "none" | "navigation" | "quota"`。

**但声明只允许升级，不允许降级。** 配置说「无副作用」不能让它绕过闸门 —— 那等于让 agent 自己批改自己的作业。插件按**可观测事实**判定后果：

- 目标文本命中已知的消耗配额词表（`打招呼` / `立即沟通` / `发起沟通` 等）；
- 或动作类型为 `type` 且后随提交类动作。

只要任一可观测信号判定为消耗配额，就走闸门；`effect: "quota"` 可以**额外**把它送进闸门，但 `effect: "none"` 永远不能把它放出来。这个枚举同时是确认闸门的新判据（开发计划 §1 表格第一行）。

## 6. 版本与失效

```json
{
  "version": 1,
  "domain": "example.com",
  "page": "candidate-list",
  "markers": [
    { "kind": "exists", "locator": { "attr": [{ "name": "data-role", "equals": "card" }] } },
    { "kind": "text", "locator": { "attr": [{ "name": "class", "contains": "job-pane" }] }, "contains": "推荐人才" }
  ],
  "validated": { "at": "<ISO 时间>", "hitRate": 0.95, "cards": 20, "version": 1 }
}
```

- **任一条 `markers` 不成立 → 立即返回 `needs_adaptation`，并指出是哪一条失效。** 不允许「marker 不成立但照样点」。
- `validated` 记录上次校验的时间、命中率与样本数；换版本即作废。
- 缓存命中时也要**先跑 markers 再复用**，不是信任缓存。

## 7. 校验契约

`validate` 对当前页面返回：

| 字段 | 含义 |
| --- | --- |
| `matched` | 卡片命中数 |
| `ambiguous` | 卡内动作命中 <1 或 ≥2 的卡片数 |
| `missing` | 字段未能提取的卡片数 |
| `hitRate` | 关键字段成功提取的比例 |
| `unstableConditions` | 依赖生成类名的条件清单 |
| `verdict` | `usable` / `degraded` / `stale` |

**进入发送路径的门槛**：`hitRate >= 0.9` 且 `ambiguous == 0` 且 `verdict == usable`。达不到则**可读、可诊断，但不可发送** —— 退回 `needs_adaptation`，由 agent 更新配置。

配置版本下的**第一条**打招呼仍进入原有确认闸门；之后才在授权范围内放开。

## 8. 明确不做

- 不存储 ref，不缓存 DOM 节点。
- 不执行 agent 生成的 JavaScript。
- 不接受原始 CSS 选择器字符串。
- 不信任配置自述的「无副作用」。
- marker 失效时不猜测目标，不发「尽量试着点」的动作。
- 卡内命中不唯一时不用「第一个」兜底。
