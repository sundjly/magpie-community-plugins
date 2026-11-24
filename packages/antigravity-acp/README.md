# opencode-antigravity-acp-auth

English | [简体中文](README.zh-CN.md)

A magpie (OpenCode) provider plugin for **Google Antigravity through its official ACP server** — the agent runtime the Antigravity IDE speaks (`agy_acp_server.par`, served by dl.google.com), driven over Agent Client Protocol v1.

Adapted from [`pi-antigravity-acp-provider`](https://github.com/zacbemis/pi-antigravity-acp-provider) (MIT): the pinned runtime manifest, the runtime discovery order and install/validation flow, the model-family folding algorithm, the headless OAuth relay, and parts of the ACP session lifecycle are derived from it, reshaped for magpie's plugin contract. Its license notice is carried in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The plugin uses Google's official `agy_acp_server.par`. The runtime can reuse its existing sign-in or open Google's sign-in page for a separate account.

## Requirements

- **Bun** — magpie runs plugins on it and installs it for you.
- **`unzip`** (Linux only) for the one-time runtime extraction.
- First sign-in downloads the official ACP server (~112 MB archive, ~400 MB on disk, macOS arm64) to `~/.local/opt/agy-acp/`.

## How it works

- **Sign-in**: the ACP server stores each Google token. Magpie's OAuth record holds a local account marker.
  - **Add a separate Google account** creates a private profile and launches Google's sign-in. On SSH or headless Linux, follow the prompts to paste the final localhost callback URL. Accounts have separate directories under `accounts/` in the runtime root and share the official binaries.
  - *Use Antigravity's current Google sign-in* reuses the runtime's existing default sign-in.
  - *Gemini API key* — authenticated to the server with `_meta.api-key`.
- **Runtime**: found first to last at `AGY_ACP_BIN`, `~/.local/opt/agy-acp/current`, `~/.local/bin/agy_acp_server.par`, `PATH`. When none is there, the release pinned in `runtime-manifest.json` (SHA-256 and exact sizes checked, the extracted server validated over ACP before use) is downloaded to `~/.local/opt/agy-acp/versions/` and linked as `current`. Linux extraction needs `unzip` on the machine.
- **Requests and caching**: the first request sends the transcript as embedded Markdown, shortening large arguments from historical tool calls. A matching conversation can continue the same ACP session for up to thirty idle minutes (five while parked on a client tool call). Matching client tool results, together with any user text the client attached to the same turn, are delivered to the ACP prompt waiting for them. Claude Code's side queries (away recap, prompt suggestion, /btw) may continue the session but leave the main conversation's history untouched, and never disturb a parked turn. Changes to the configuration or transcript, and timeouts, cause a fresh session. Usage reports each reply's last model call, read per step from the local conversation store, so a multi-step tool loop never reads as a context overflow; ACP's cache counters travel back to Magpie with it. Creating `~/.local/opt/agy-acp/reuse.log` logs each session-reuse decision (metadata only) for diagnosis.
- **Failure paths**: a prompt that fails before anything of the reply exists rejects as a failed request — a lost sign-in marks the account expired, a server that dies under the request is retried once on a fresh one. Once the reply has started, an error rides as its tail. A prompt that outlives its timeout is cancelled on the server, not killed with it.
- **Models**: the server's effort-qualified ids are folded into one entry per family (`gemini-3.8-flash-low/-medium/-high` becomes `gemini-3.8-flash` with low/medium/high variants); the request's `reasoning_effort` picks the variant's exact id on the session.
- **Tools**: the loopback MCP bridge forwards tools declared by the client. ACP's `allow_once` is selected only for a declared bridge tool in the active session. The client applies its own permissions when deciding whether to execute the tool.
- **Account and quota**: the runtime's `/usage` command reports each account's five-hour and weekly limits. The card displays remaining capacity and reset times. When an isolated account grants email access, Google UserInfo supplies its email. The default system sign-in can be named in Magpie. Quota readings are for display.

## Switching accounts manually

Open Providers → Antigravity (ACP) → Accounts and enable only the account you want to use. Each account uses its own ACP process. Switching requires no new sign-in. If you sync your Magpie configuration to another computer, sign in to each separate account again there.

## Limits

- Antigravity's own file and shell tools never run; a model that insists on them will say it couldn't. The client agent's tools are the ones served.

## Ban risk, and magpie's built-in Antigravity

What gets accounts suspended is Google seeing the account used outside Antigravity. magpie's built-in `antigravity` provider says so itself ("use one you can afford to lose"): it connects to Google's Code Assist API with its own code, wearing a spoofed `antigravity/hub/<version>` user agent.

This plugin uses Google's official server authentication. Google can still see the ACP client identity, its request contents, and its usage patterns.

| | built-in `antigravity` | this plugin `antigravity-acp` |
| --- | --- | --- |
| talks to Google as | magpie's own code, spoofed IDE headers | the official ACP server binary |
| authentication | the account's OAuth token, refreshed by magpie | official ACP sign-in |
| accounts | a pool, per-account model catalogs merged | default login and separate account profiles |
| models | account-pool merge, magpie's own family folding | the server's live rollout catalog, folded in the plugin |
| usage | quota endpoints, tier cards | the quota each prompt answer carries |
| tool calls | served to the model API | the client's tools over a loopback MCP bridge; Antigravity's own tools are turned down |
| third-party account import | yes (Antigravity Manager, CLIProxyAPI) | no — the sign-in belongs to the server |
| extra deps | none | the downloaded official runtime (~400 MB), one process per account in use |

## Environment

- `AGY_ACP_BIN` — an `agy_acp_server.par` of your own, preferred over everything.
- `AGY_ACP_HOME` — moves `~/.gemini` and `~/.local` (sandboxes, tests).
- `AGY_ACP_AUTH_DIR` points to the default sign-in, and `AGY_ACP_RUNTIME_ROOT` locates the runtime and separate account profiles.
- `AGY_ACP_OAUTH_MODE` — `manual` (relay, paste the URL back) or `browser` (let the server open one).

## Test

```sh
bun test   # the whole plugin against a fake ACP server; no download, no Google
```

## License

MIT — see [LICENSE](../../LICENSE) at the repository root. Adapted from `pi-antigravity-acp-provider` (MIT); its notice is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
