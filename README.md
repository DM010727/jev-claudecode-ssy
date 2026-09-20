# Jev Claude Code · 胜算云版

让 Claude Code 在长时间编码时，用 Jev 判断哪些旧工具调用仍然有用，再进行无摘要压缩。用户与 Claude 的文字对话保持原文，主要清理已经失去价值的工具调用和工具结果。

## 一分钟接入

准备好两样东西：

- 已安装并登录的 Claude Code
- 胜算云 API Key

### Windows

在 PowerShell 中运行：

```powershell
npx --yes github:DM010727/jev-claudecode-ssy
```

### macOS（不需要安装 Node.js 或 npx）

在“终端”中运行：

```bash
curl -fsSL https://raw.githubusercontent.com/DM010727/jev-claudecode-ssy/main/install.sh | bash
```

安装程序会直接提示输入胜算云 API Key。输入内容不会显示在屏幕上，按回车即可继续。安装完成后，重启 Claude Code，或在当前会话执行：

```text
/reload-plugins
```

> 已经安装过也可以直接重新运行同一条命令。安装程序每次都会询问 Key，并用新配置重装插件，适合更新版本或更换 Key。

## 也可以直接告诉 Claude Code

把下面这句话发给 Claude Code：

```text
请从 https://github.com/DM010727/jev-claudecode-ssy 安装 Jev 胜算云适配器；安装后提示我配置胜算云 API Key，并执行 /reload-plugins。
```

## 怎么确认已经生效

先进行一段包含读文件、搜索或执行命令的编码对话，然后运行：

```text
/compact
```

成功时会看到类似提示：

```text
kept 18/31 messages, no summary (...)
```

这表示 Jev 已经完成判断，Claude Code 使用清理后的原始消息继续工作，而不是把整个历史改写成一段摘要。

插件默认也会在上下文使用率达到 `60%` 时尝试自动压缩。

## 它是怎么接入 Jev 的

适配器注册了 Claude Code 的 `session.compact` 和 `turn.complete` hooks，工作过程如下：

```text
Claude Code 会话
    │
    ├─ 手动 /compact，或上下文达到 60%
    ▼
适配器读取当前消息和工具调用
    │
    ├─ 首条消息与最近 6 条消息固定保留
    ├─ 为较早的每个工具调用生成两个问题：
    │    1. 这个调用本身是否还重要？
    │    2. 它的完整结果是否还需要保留？
    ▼
胜算云 Jev Decisions API
POST https://router.shengsuanyun.com/api/v1/decisions
    │
    └─ 返回每个问题的保留概率
    ▼
适配器按阈值重建会话
    ├─ 保留仍有价值的调用和完整结果
    ├─ 删除已无价值的调用
    └─ 或把不再需要全文的工具结果截短
    ▼
Claude Code 使用精简后的原始对话继续编码
```

适配器使用胜算云提供的 OpenAI 兼容 Jev Decisions 接口，默认模型为 `jev-latest`。发送给 Jev 的状态包含任务目标、对话历史和工具调用信息；为了控制请求大小，工具结果不作为全文状态发送，过长内容还会逐级缩短。

## 对 Claude Code 编码对话有什么改变

普通的 Claude Code 压缩通常会把旧对话总结成一段新文本。总结能节省上下文，但可能丢失文件名、报错细节、用户原话或关键约束。

这个适配器成功运行后，改变的是“旧工具痕迹如何保留”，不是“文字对话如何改写”：

- 用户消息和 Claude 的文字回复保持原文，不生成替代它们的总结。
- 首条消息和最近的消息固定保留，避免当前任务意图与正在进行的步骤被清掉。
- Jev 对较早的工具调用逐项判断，例如读文件、搜索、命令输出是否还会影响下一步。
- 仍重要的工具调用及结果原样保留。
- 调用有用、但完整输出已不重要时，保留调用并截短结果；需要时 Claude 可以重新执行工具。
- 调用本身已经无关时，对应的调用和结果一起移除。
- 只有预计能达到最小压缩比例时才替换历史；收益太小、Key 无效、网络异常或 Jev 请求失败时，会自动回退到 Claude Code 自带的摘要压缩，不阻断工作。

因此，长时间改代码时，上下文会更偏向保留“真实对话 + 当前仍有用的证据”，减少大量已经消费完毕的日志、搜索结果和文件内容占用上下文。

## 常见问题

### macOS 提示 `command not found: npx`

macOS 直接使用不依赖 npx 的安装命令：

```bash
curl -fsSL https://raw.githubusercontent.com/DM010727/jev-claudecode-ssy/main/install.sh | bash
```

### 安装时没有让我输入 Key

重新运行上面的最新安装命令。`1.0.2` 及以上版本会在每次安装或更新时主动询问 Key，即使电脑中已经存在相关环境变量。

### 显示 `8 userConfig options not yet set`

这是正常提示。`apiKey` 已经由安装程序写入，其余 8 个高级选项使用默认值，不影响使用。

### 出现 `npm warn Unknown user config`

这是本机 npm 配置产生的警告，与本插件和胜算云 API 无关。只要后面显示安装完成即可。

### `/compact` 回退到 built-in summary

查看提示中的原因。常见情况包括 Key 无效、网络暂时不可用、对话中没有足够多的旧工具调用，或精简比例低于默认的 `25%`。插件会自动调用 Claude Code 原生压缩，因此不会卡住当前会话。

### 更新插件或更换 Key

重新运行与首次安装相同的 Windows 或 macOS 命令即可，不需要先卸载。

## 默认配置

| 配置项 | 默认值 | 作用 |
| --- | ---: | --- |
| `model` | `jev-latest` | 胜算云上的 Jev 模型 |
| `keepThreshold` | `0.5` | Jev 保留概率阈值 |
| `preserveRecentMessages` | `6` | 固定保留的最新消息数量 |
| `compactAtPercent` | `60` | 自动触发压缩的上下文占用百分比 |
| `minReductionRatio` | `0.25` | 接管历史所需的最小预计压缩比例 |
| `maxStateTokens` | `25000` | 单次 Jev 状态预算 |
| `maxRequestTokens` | `30000` | 单次完整请求预算 |
| `truncateHeadChars` | `300` | 截短工具结果时保留的开头字符数 |

这些参数无需手工设置即可使用。需要调整时，可在 Claude Code 中执行：

```text
/plugin configure jev-claudecode-ssy@jev-claudecode-ssy
```

## 开发与测试

项目要求 Node.js 18 或更高版本：

```bash
npm install
npm run typecheck
npm test
npm run build
npm run validate:plugin
```

仓库同时提供可独立调用的 TypeScript 压缩库，入口为 `src/index.ts`；Claude Code 适配层位于 `hooks/fast-jev.ts`。

## License

[MIT](LICENSE)
