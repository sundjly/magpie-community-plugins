# opencode-antigravity-acp-auth

[English](README.md) | 简体中文

一个 magpie（OpenCode）供应商插件：**通过 Google Antigravity 官方的 ACP 服务器使用 Antigravity** —— 即 Antigravity IDE 所依赖的 agent runtime（`agy_acp_server.par`，由 dl.google.com 分发），以 Agent Client Protocol v1 驱动。

改编自 [`pi-antigravity-acp-provider`](https://github.com/zacbemis/pi-antigravity-acp-provider)（MIT）：固定的运行时清单、运行时发现顺序与安装/验证流程、模型家族折叠算法、无头 OAuth relay，以及 ACP 会话生命周期的部分内容均派生自它，并按 magpie 的插件契约重塑。其许可声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

插件使用 Google 官方的 `agy_acp_server.par`。可以复用本机原有的 ACP 登录，也可以让运行时通过 Google 登录页建立独立账号。

## 前置要求

- **Bun** —— magpie 的插件运行在其上，会自动安装。
- **`unzip`**（仅 Linux）用于运行时的一次性解压。
- 首次登录会下载官方 ACP 服务器（压缩包约 112 MB，落盘约 400 MB，macOS arm64）到 `~/.local/opt/agy-acp/`。

## 工作方式

- **登录**：Google 令牌由 ACP 服务器保存。Magpie 的 OAuth 记录只保存本地账号标记。
  - **添加独立 Google 账号**会新建私有目录，启动官方 Google 登录。在 SSH 或无界面 Linux 上可按提示粘贴最终的 localhost 回调地址。账号保存在运行时目录的 `accounts/` 下，运行时可执行文件由账号共享。
  - *Use Antigravity's current Google sign-in* 复用运行时原有的登录。
  - *Gemini API key* —— 以 `_meta.api-key` 向服务器认证。
- **运行时**：按 `AGY_ACP_BIN`、`~/.local/opt/agy-acp/current`、`~/.local/bin/agy_acp_server.par`、`PATH` 的顺序查找。都没有时，下载 `runtime-manifest.json` 固定的版本（校验 SHA-256 与精确字节数，解压出的服务器先经 ACP 验明身份再启用）到 `~/.local/opt/agy-acp/versions/`，并链接为 `current`。Linux 解压需要机器上有 `unzip`。
- **请求与缓存**：首次请求把历史作为嵌入式 Markdown 上下文发给 ACP，并缩短历史工具调用的大段参数。账号、模型、指令、工具和已完成的历史一致时，后续用户消息可继续同一个 ACP 会话，空闲最多保留三十分钟（挂起等待客户端工具结果时为五分钟）。客户端工具结果按调用 ID 回到等待该结果的 ACP 回合，客户端在同一轮附带的用户文本也随最后一个结果一并送达。Claude Code 的旁路请求（暂离摘要、输入建议、/btw）可以续接会话，但不会改动主对话的历史，也不会打断挂起中的回合。配置变化、历史不匹配或等待超时会重建会话。用量按本地会话库逐步读取，只报每条回复最后一次模型调用的上下文，多步工具循环不会被误判为上下文溢出；ACP 的缓存计数也随之传回 Magpie。创建 `~/.local/opt/agy-acp/reuse.log` 后，会记录每次会话复用的决策（仅元数据），便于排查。
- **失败路径**：在回复尚未流出任何内容之前的 prompt 失败会作为失败请求抛出 —— 登录失效会把账户标记为 expired，服务器中途退出会在新服务器上重试一次。回复一旦开始，错误只作为回复末尾附注。超出时限的 prompt 会在服务器上被取消，而不是连服务器一起杀掉。
- **模型**：服务器带 effort 后缀的 id 折叠为每家族一条（`gemini-3.8-flash-low/-medium/-high` 变成 `gemini-3.8-flash`，带 low/medium/high variants）；请求的 `reasoning_effort` 在会话上选中对应的确切 id。
- **工具**：请求声明的工具通过本机 Magpie MCP 桥接交给客户端执行。ACP 的 `allow_once` 只用于当前会话已声明的桥接工具。客户端按自己的权限规则决定是否执行。
- **账号和额度**：插件通过官方 ACP 的 `/usage` 读取各账号的 5 小时和周额度，显示剩余比例和重置时间。新账号已授予邮箱权限时，通过 Google UserInfo 显示邮箱。复用系统登录的旧账号可在 Magpie 里手动命名。额度读数仅用于显示。

## 手动切换

在 Magpie 的「供应商 → Antigravity (ACP) → 账号」里，仅勾选要使用的账号。已有的登录和新增的账号各用自己的 ACP 进程。切换只需要改勾选，无需重新登录。同步 Magpie 配置后，其他电脑需要在本机重新登录独立账号。

## 限制

- Antigravity 自己的文件与命令工具永远不会执行；模型坚持要用时会说明它做不到。真正被提供的是客户端 agent 的工具。

## 封号风险，以及 magpie 内置的 Antigravity

导致账号被封的，是 Google 看到账号在 Antigravity 之外被使用。magpie 内置的 `antigravity` 供应商自己就这么警告（"用一个你丢得起的账号"）：它用自己的代码连接 Google 的 Code Assist API，戴着伪造的 `antigravity/hub/<version>` User-Agent。

本插件使用 Google 官方服务器的认证。Google 仍能看到 ACP 客户端身份、请求内容和调用方式。

| | 内置 `antigravity` | 本插件 `antigravity-acp` |
| --- | --- | --- |
| 以什么身份对接 Google | magpie 自己的代码，伪造 IDE 头 | 官方 ACP 服务器二进制 |
| 认证 | 账号的 OAuth 令牌，由 magpie 刷新 | 官方 ACP 登录 |
| 账号 | 池化，各账号模型目录合并 | 默认登录和独立账号目录 |
| 模型 | 账号池合并 + magpie 内置家族折叠 | 服务器实时 rollout 目录，插件内折叠 |
| 用量 | 配额端点、tier 卡片 | 每次 prompt 应答携带的配额 |
| 工具调用 | 提供给模型 API | 客户端工具经回环 MCP bridge；Antigravity 自有工具被拒绝 |
| 第三方账号导入 | 支持（Antigravity Manager、CLIProxyAPI） | 不支持 —— 登录归服务器所有 |
| 额外依赖 | 无 | 下载的官方运行时（约 400 MB），每个使用中的账号一个进程 |

## 环境变量

- `AGY_ACP_BIN` —— 你自己的 `agy_acp_server.par`，优先于一切。
- `AGY_ACP_HOME` —— 同时迁移 `~/.gemini` 与 `~/.local`（沙箱、测试）。
- `AGY_ACP_AUTH_DIR` 用于查找默认登录，`AGY_ACP_RUNTIME_ROOT` 指定运行时和独立账号的存放目录。
- `AGY_ACP_OAUTH_MODE` —— `manual`（relay，回贴 URL）或 `browser`（让服务器开浏览器）。

## 测试

```sh
bun test   # 全插件对着一个假 ACP 服务器跑；不下载、不登录 Google
```

## 许可

MIT —— 见仓库根目录的 [LICENSE](../../LICENSE)。改编自 `pi-antigravity-acp-provider`（MIT）；其声明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
