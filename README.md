# Jev Claude Code · 胜算云版

通过胜算云 Jev Decisions API 自动压缩 Claude Code 上下文。它不改写用户和助手文本，只删除已经不再需要的工具调用，或截短不再需要保留全文的工具结果。

## 30 秒接入

### Windows

在 PowerShell 或 CMD 中运行：

```sh
npx --yes github:DM010727/jev-claudecode-ssy
```

### macOS（不需要 Node/npm/npx）

macOS 终端运行：

```sh
curl -fsSL https://raw.githubusercontent.com/DM010727/jev-claudecode-ssy/main/install.sh | bash
```

macOS 原生脚本只依赖系统自带的 `curl`、`bash` 和 `plutil`，会直接提示输入胜算云 API Key。

安装器会自动：

1. 检查 Claude Code；低于 `2.1.274` 时调用官方更新命令。
2. 合并 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` 到用户设置，保留现有配置并在修改前备份。
3. 注册本仓库为插件 marketplace，并安装或更新插件。
4. 每次运行安装器都明确提示用户输入胜算云 API Key，再交给 Claude Code 的 `userConfig` 保存；不会因机器上已有环境变量而跳过输入。

完成后重启 Claude Code，或在当前会话执行 `/reload-plugins`。

### 直接对 Claude Code 说一句话

把下面这句话发给 Claude Code 即可：

> 请根据我的系统告诉我运行胜算云 Jev 插件的一键安装命令：Windows 使用 `npx --yes github:DM010727/jev-claudecode-ssy`，macOS 使用仓库 README 里的 `curl | bash` 命令；安装器会让我输入 API Key，完成后提醒我执行 `/reload-plugins`。

### 手动安装（备用）

```sh
claude plugin marketplace add DM010727/jev-claudecode-ssy
claude plugin install jev-claudecode-ssy@jev-claudecode-ssy
```

手动方式还需要在 `~/.claude/settings.json`（Windows 为 `%USERPROFILE%\.claude\settings.json`）中启用函数钩子：

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

## 胜算云接口

默认请求与 `typesafe-jev-decisions-openapi.json` 一致：

- Endpoint：`POST https://router.shengsuanyun.com/api/v1/decisions`
- 认证：`Authorization: Bearer <胜算云 API Key>`
- 默认模型：`jev-latest`
- 请求：`{ model, state, questions }`
- 响应：`{ model, answers, usage }`

插件优先读取 Claude Code 的敏感 `apiKey` 配置，也支持环境变量 `SSY_API_KEY`。不要把 Key 提交到 Git、写进源码或示例文件。

## 工作原理

1. 按 `tool_use_id` 配对工具调用和结果；第一条消息及最近消息固定保留。
2. 把完整对话状态发送给 Jev，但工具结果仅保留“成功/失败 + 字符数”摘要。
3. 对每个候选工具调用询问两个 `noul` 问题：调用本身是否仍重要、结果全文是否仍需要。
4. 按概率决定保留、仅截短结果或同时删除调用与结果。
5. Jev 请求失败、响应不合法或压缩收益不足时，自动回退 Claude Code 内置压缩。

默认在上下文达到 60% 时触发，最近 6 条消息不参与裁剪，只有预计至少减少 25% 才替换内置压缩。

## 配置

安装或启用插件时，Claude Code 会展示以下配置项：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `apiKey` | 推荐配置 | 胜算云 API Key，按敏感信息保存；也可使用 `SSY_API_KEY` |
| `model` | `jev-latest` | 胜算云 Jev 模型 |
| `keepThreshold` | `0.5` | 保留调用或结果的最低概率 |
| `preserveRecentMessages` | `6` | 固定保留的最近消息数 |
| `compactAtPercent` | `60` | 自动触发压缩的上下文百分比 |
| `minReductionRatio` | `0.25` | 接管内置压缩所需的最低缩减比例 |
| `maxStateTokens` | `25000` | 发送给 Jev 的状态预算 |
| `maxRequestTokens` | `30000` | 单次请求总预算 |
| `truncateHeadChars` | `300` | 截短结果时保留的头部字符数 |

## 作为 TypeScript 库使用

```sh
npm install github:DM010727/jev-claudecode-ssy
```

```ts
import { compactMessages, type Message } from 'jev-claudecode-ssy';

const messages: Message[] = [
  { role: 'user', text: '修复测试，禁止修改 generated 目录。', toolUses: [] },
];

const result = await compactMessages(messages, {
  apiKey: process.env.SSY_API_KEY,
  preserveRecentMessages: 4,
});

console.log(result.messages, result.stats);
```

可以通过 `baseUrl` 覆盖默认地址，通过实现 `JevAsker` 使用自定义传输层。完整构建块仍从包入口导出。

## 本地开发

```sh
npm install
npm run typecheck
npm test
npm run build
npm run validate:plugin
```

单元测试使用假 Jev 响应，不会请求胜算云，也不会消耗额度。若要从当前 checkout 直接加载：

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

## 限制

- 函数钩子仍属于 Claude Code 的早期能力，升级 Claude Code 后应重新运行类型检查和插件验证。
- Token 数为估算值，不是模型 tokenizer 的精确结果。
- Jev 给出的概率不是绝对证明；需要时 Claude Code 仍可重新运行工具。
