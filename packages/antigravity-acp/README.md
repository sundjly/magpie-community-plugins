# opencode-antigravity-acp-auth

A magpie (OpenCode) provider plugin for **Google Antigravity through its official ACP server** — the agent runtime the Antigravity IDE speaks (`agy_acp_server.par`, served by dl.google.com), driven over Agent Client Protocol v1.

Modeled on `pi-antigravity-acp-provider`, reshaped for magpie's plugin contract.

## How it works

- **Sign-in**: the ACP server owns the Google sign-in and decides alone where it keeps it (an install with the IDE signed in may carry no token file at all); the plugin stores a marker, never a token, and reads the sign-in's health from the server's own answers — a session can be made signed-out, but only a credential gets a prompt through. One Google sign-in is shared by every account of this provider on a machine. Three ways to sign in:
  - *Sign in with Google* — the server opens a browser. On SSH or a headless Linux the OAuth URL is captured and shown instead; paste the final localhost URL back.
  - *Use Antigravity's current Google sign-in* — a sign-in the Antigravity IDE already made on this machine.
  - *Gemini API key* — authenticated to the server with `_meta.api-key`.
- **Runtime**: found first to last at `AGY_ACP_BIN`, `~/.local/opt/agy-acp/current`, `~/.local/bin/agy_acp_server.par`, `PATH`. When none is there, the release pinned in `runtime-manifest.json` (SHA-256 and exact sizes checked, the extracted server validated over ACP before use) is downloaded to `~/.local/opt/agy-acp/versions/` and linked as `current`. Linux extraction needs `unzip` on the machine.
- **Requests**: each request arrives as the model's OpenAI Chat body (the models are on `@ai-sdk/openai-compatible`). The plugin turns it into one ACP session: the history rides as an embedded markdown context, the latest user text and images ride as prompt blocks, and the reply streams back as OpenAI chunks — `agent_message_chunk` as content, `agent_thought_chunk` as `reasoning_content`, the prompt's usage and quota as the final chunk.
- **Models**: the server's effort-qualified ids are folded into one entry per family (`gemini-3.8-flash-low/-medium/-high` becomes `gemini-3.8-flash` with low/medium/high variants); the request's `reasoning_effort` picks the variant's exact id on the session.
- **Tools**: the request's tools are served to the agent as an MCP bridge on loopback. A call there becomes the reply's `tool_calls` and ends the turn, the way a chat client expects. Antigravity's own tools are turned down (`session/request_permission` is answered *cancelled*), so nothing runs on this machine but what the client's agent asked for.
- **Usage**: the quota the last prompt's answer carried (`_meta.quota`) shows on the account's Usage card.

## Limits

- One Google sign-in per machine, shared by all accounts of this provider; "another account" means signing the machine in as someone else.
- Antigravity's own file and shell tools never run; a model that insists on them will say it couldn't. The client agent's tools are the ones served.
- Sessions are not warmed across requests: each request carries its conversation as context, as a stateless model API would.

## Environment

- `AGY_ACP_BIN` — an `agy_acp_server.par` of your own, preferred over everything.
- `AGY_ACP_HOME` — moves `~/.gemini` and `~/.local` (sandboxes, tests).
- `AGY_ACP_AUTH_DIR`, `AGY_ACP_RUNTIME_ROOT` — move the sign-in and the managed runtime separately.
- `AGY_ACP_OAUTH_MODE` — `manual` (relay, paste the URL back) or `browser` (let the server open one).

## Test

```sh
node test/smoke.mjs   # the whole plugin against a fake ACP server; no download, no Google
```
