# Claude Code 函数钩子

`fast-jev.ts` 把 `session.compact` 会话交给仓库内的压缩库，并通过胜算云的 `POST /api/v1/decisions` 获取 Jev 决策。用户和助手文本保持原样；只有工具调用和结果可能被删除或截短。

Claude Code 在 `/compact` 阶段会拒绝插件的 `$.http.fetch`。本插件改用系统自带的 `curl` 子进程，并通过标准输入传递请求和 API Key；不会把 Key 放进命令行参数或临时文件。Windows 10/11 与 macOS 均自带 curl，因此不要求用户额外安装 Node/npm。

推荐从仓库根目录执行一键安装：

```sh
npx --yes github:DM010727/jev-claudecode-ssy
```

插件从敏感 `apiKey` 用户配置读取胜算云 Key，也支持 `SSY_API_KEY`。任何错误、无效响应、状态超限或压缩比例不足都会回退 Claude Code 内置压缩。

开发时可直接运行：

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

详见仓库根目录的 `README.md`。
