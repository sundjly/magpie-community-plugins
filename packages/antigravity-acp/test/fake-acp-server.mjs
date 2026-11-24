#!/usr/bin/env -S node
// A fake Antigravity ACP server, enough of one for the plugin's tests:
// initialize, authenticate, session/new with a model select,
// session/set_config_option, session/prompt (text, thought, and one client
// tool call through the MCP bridge the session was given), session/cancel,
// session/close.
//
// Prompt words the tests drive the failure paths with:
//   AUTHFAIL — the prompt is refused with -32000 (a lost sign-in)
//   FAILMID  — one chunk is streamed first, then the prompt is refused
//   DIEONCE  — the server exits on its first DIEONCE prompt, answers the
//              next one (the retry) normally, via a marker file
//   HANG     — the prompt never answers (for the soft-timeout test)
// The cwd of each session/new is written to $AGY_ACP_HOME/last-cwd, and each
// closed session id to $AGY_ACP_HOME/closed-sessions, and each process
// started to $AGY_ACP_HOME/spawns, for the tests to assert.
import { createInterface } from "node:readline"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const requireModule = createRequire(import.meta.url)

function encodeVarint(value) {
  const bytes = []
  let n = value
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80)
    n = Math.floor(n / 128)
  }
  bytes.push(n)
  return bytes
}

function encodeFieldVarint(field, value) {
  return value ? [...encodeVarint((field << 3) | 0), ...encodeVarint(value)] : []
}

function encodeFieldBytes(field, bytes) {
  return [...encodeVarint((field << 3) | 2), ...encodeVarint(bytes.length), ...bytes]
}

function encodeGenMetadata({ input = 0, output = 0, write = 0, read = 0, thinking = 0 }) {
  const usage = [
    ...encodeFieldVarint(2, input),
    ...encodeFieldVarint(3, output),
    ...encodeFieldVarint(4, write),
    ...encodeFieldVarint(5, read),
    ...encodeFieldVarint(9, thinking),
  ]
  const chat = encodeFieldBytes(4, usage)
  return Uint8Array.from(encodeFieldBytes(1, chat))
}

function writeGenMetadataRow(sessionId, idx, stats) {
  const baseDir = profileAuthDir || process.env.AGY_ACP_AUTH_DIR || path.join(os.homedir(), ".gemini", "antigravity-acp")
  const dir = path.join(baseDir, "conversations")
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, `${sessionId}.db`)
  const blob = encodeGenMetadata(stats)
  let db
  try {
    const { Database } = requireModule("bun:sqlite")
    db = new Database(dbPath)
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);")
    db.prepare("INSERT OR REPLACE INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)").run(idx, blob, blob.length)
  } finally {
    try { db?.close() } catch {}
  }
}

const MODELS = [
  { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  { value: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
]

const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
const reply = (id, result) => write({ jsonrpc: "2.0", id, result })
const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } })
const update = (sessionId, up) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: up } })

// one line per server process started, for the tests to count
try { fs.appendFileSync(path.join(process.env.AGY_ACP_HOME ?? os.tmpdir(), "spawns"), `${process.pid}\n`) } catch {}

const sessions = new Map()
const pendingPermissions = new Map()
const profileAuthDir = process.env.AGY_ACP_FORCE_FILE_STORAGE === "1"
  ? path.join(process.env.GEMINI_HOME, "antigravity-acp")
  : null
const profileToken = profileAuthDir && path.join(profileAuthDir, "acp_token.json")
const profileModels = profileToken ? MODELS.filter((m) => !m.value.endsWith("-high")) : MODELS
let nextId = 1
let nextSession = 1

const configOptions = (current) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: current, options: profileModels },
]

// mcpCallTool speaks just enough MCP over Streamable HTTP to list the
// bridge's tools and call the first one.
async function mcpCallTool(server, sessionId) {
  const post = (body) =>
    fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(server.headers ?? []).reduce((h, x) => ({ ...h, [x.name]: x.value }), {}) },
      body: JSON.stringify(body),
    }).then(async (res) => {
      const text = await res.text()
      return text ? JSON.parse(text) : null
    })
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp", version: "0" } } })
  await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  const tool = listed?.result?.tools?.[0]
  if (!tool) throw new Error("the bridge listed no tools")

  const requestPermission = (toolCall, targetSession = sessionId, options = [
    { kind: "allow_always", optionId: "always" },
    { kind: "allow_once", optionId: "once" },
    { kind: "reject_once", optionId: "reject" },
  ]) => new Promise((resolve) => {
    const id = `permission-${nextId++}`
    pendingPermissions.set(id, resolve)
    write({ jsonrpc: "2.0", id, method: "session/request_permission",
      params: { sessionId: targetSession, toolCall, options } })
  })
  const mcpTool = {
    title: `${server.name}_${tool.name}`,
    kind: "other",
    _meta: { is_mcp_tool_call: true, mcp: { server: server.name, tool: tool.name } },
  }
  const refused = await Promise.all([
    requestPermission({ title: mcpTool.title, rawInput: mcpTool._meta, kind: "execute" }),
    requestPermission({ ...mcpTool, _meta: { ...mcpTool._meta, mcp: { server: "another-mcp", tool: tool.name } } }),
    requestPermission({ ...mcpTool, _meta: { ...mcpTool._meta, mcp: { server: server.name, tool: "undeclared" } } }),
    requestPermission(mcpTool, "different-session"),
    requestPermission(mcpTool, sessionId, [{ kind: "allow_always", optionId: "always" }]),
  ])
  if (refused.some((response) => response?.outcome !== "cancelled")) throw new Error("Unrelated permission was allowed")
  const forwarded = await requestPermission(mcpTool)
  if (forwarded?.outcome !== "selected" || forwarded.optionId !== "once") throw new Error("Bridge permission was denied")
  const undeclared = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "undeclared" } })
  if (undeclared?.result?.isError !== true) throw new Error("The bridge accepted an undeclared tool")
  const called = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: { command: "echo hi", _from: "fake-acp" } } })
  return { name: tool.name, called }
}

const handlers = {
  initialize() {
    return {
      protocolVersion: 1,
      agentInfo: { name: "antigravity-acp", version: "1.2.1" },
      authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
      agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true }, ...(process.env.FAKE_NO_CLOSE ? {} : { sessionCapabilities: { close: process.env.FAKE_CLOSE_NULL ? null : {} } }) },
    }
  },
  async authenticate() {
    await new Promise((r) => setTimeout(r, 50))
    if (profileToken) {
      const validProfile = process.env.GEMINI_HOME === path.join(process.env.HOME, ".gemini")
      const settings = JSON.parse(fs.readFileSync(path.join(profileAuthDir, "settings.json"), "utf8"))
      if (!validProfile || settings.auth?.type !== "oauth-personal" || process.env.GEMINI_API_KEY) {
        throw new Error("incorrect isolated account settings")
      }
      fs.writeFileSync(profileToken, '{"email":"second@example.com"}', { mode: 0o600 })
    }
    return {}
  },
  "session/new"(params) {
    if (profileToken && !fs.existsSync(profileToken)) throw new Error("authentication required")
    const id = `s-${nextSession++}`
    sessions.set(id, { model: "gemini-3.8-flash-low", mcp: params?.mcpServers?.[0] ?? null, prompts: 0 })
    update(id, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "usage" }] })
    // where the plugin lets the server work, for the test to assert
    try { fs.writeFileSync(path.join(process.env.AGY_ACP_HOME ?? os.tmpdir(), "last-cwd"), String(params?.cwd ?? "")) } catch {}
    return { sessionId: id, configOptions: configOptions(sessions.get(id).model), _meta: { antigravity: { tier: { name: profileToken ? "pro" : "ultra" } } } }
  },
  "session/set_config_option"(params) {
    const session = sessions.get(params?.sessionId)
    if (!session) fail(0, -32002, "no such session")
    if (params?.configId === "model") session.model = params.value
    return { configOptions: configOptions(session.model) }
  },
  async "session/prompt"(params) {
    const session = sessions.get(params?.sessionId)
    const continuing = session.prompts++ > 0
    const id = nextId++
    session.pending = id
    const text = (params?.prompt ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n")
    if (text === "/usage") {
      const remaining = profileToken ? 70 : 90
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text:
        `### Session Usage\n- **Session total:** 0\n\n### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** ${remaining}% remaining (resets Nov 30, 2026, 20:03 UTC)\n`,
      } })
      return { stopReason: "end_turn" }
    }
    // the failure paths throw out of the handler, so the wire answers with
    // the error (-32000), not with a refusal result — inside the try below
    // they would be swallowed into one
    if (/AUTHFAIL/.test(text)) throw new Error("authentication required")
    if (/HANG/.test(text)) return new Promise(() => {})
    if (/FAILMID/.test(text)) {
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial " } })
      throw new Error("authentication required")
    }
    try {
      if (/DIEONCE/.test(text)) {
        const marker = path.join(process.env.AGY_ACP_HOME ?? os.tmpdir(), "died-once")
        if (!fs.existsSync(marker)) {
          fs.writeFileSync(marker, "1")
          process.exit(3)
        }
      }
      if (session.mcp && /USE_TOOL/.test(text)) {
        if (/ECHO_HISTORY/.test(text)) {
          for (const chunk of ["I’m making the change.\n", "## Assistant's ", "tool calls\n[cal", "led Write] ", '{"content":"SYNTHETIC_FILE_BODY"}\n## Tool result\nSYNTHETIC_HISTORY']) {
            update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } })
            await new Promise((resolve) => setTimeout(resolve, 8))
          }
        }
        if (/STORE_USAGE/.test(text) && !/STORE_USAGE_NONE/.test(text)) {
          writeGenMetadataRow(params.sessionId, 0, { input: 5000, output: 120, read: 0, write: 0, thinking: 80 })
        }
        const call = await mcpCallTool(session.mcp, params.sessionId)
        if (/PARK_TOOL/.test(text)) {
          const value = (call.called?.result?.content ?? []).map((block) => block.text).join(" | ")
          update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Client result: ${value}` } })
          if (/STORE_USAGE_(BLOATED|NONE)/.test(text)) {
            // ACP's closing usage sums four model calls (5000, 5300, 5700, 6100
            // context tokens) while no per-step row is readable for the last three
            return { stopReason: "end_turn", usage: { totalTokens: 22400, inputTokens: 6200, outputTokens: 300, thoughtTokens: 100, cachedReadTokens: 15900, cachedWriteTokens: 0 } }
          }
          if (/STORE_USAGE/.test(text)) {
            if (!/STORE_USAGE_SKIP_FINAL/.test(text)) {
              writeGenMetadataRow(params.sessionId, 1, { input: 400, output: 60, read: 4900, write: 0, thinking: 20 })
            }
            return { stopReason: "end_turn", usage: { totalTokens: 10480, inputTokens: 5400, outputTokens: 180, thoughtTokens: 100, cachedReadTokens: 4900, cachedWriteTokens: 0 } }
          }
          return { stopReason: "end_turn", usage: { totalTokens: 815, inputTokens: 10, outputTokens: 5, cachedReadTokens: 800, cachedWriteTokens: 0 } }
        }
        update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: `fake tool ${call.name}`, kind: "other", status: "completed" })
        const taken = session.pending === id
        session.pending = null
        return { stopReason: taken ? "end_turn" : "cancelled" }
      }
      if (/THINK/.test(text)) update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } })
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } })
      await new Promise((r) => setTimeout(r, 30))
      const account = profileToken ? ` as ${JSON.parse(fs.readFileSync(profileToken, "utf8")).email}` : ""
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `from fake at ${session.model}${account}` } })
      if (session.pending !== id) return { stopReason: "cancelled" }
      session.pending = null
      const usage = continuing
        ? { totalTokens: 1015, inputTokens: 10, outputTokens: 5, cachedReadTokens: 1000, cachedWriteTokens: 0 }
        : { totalTokens: 15, inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cachedWriteTokens: 0 }
      if (continuing && params.prompt.some((block) => block.type === "resource")) {
        throw new Error("Continuation must omit the transcript already held by ACP")
      }
      return { stopReason: "end_turn", usage, _meta: { quota: { remaining: profileToken ? 70 : 90, limit: 100, tier: profileToken ? "pro" : "ultra" } } }
    } catch (e) {
      session.pending = null
      return { stopReason: "refusal", _meta: { details: String(e?.message ?? e) } }
    }
  },
  "session/cancel"(params) {
    const session = sessions.get(params?.sessionId)
    // the in-flight prompt sees the cleared pending and answers cancelled
    if (session) session.pending = null
    return undefined
  },
  "session/close"(params, id) {
    sessions.delete(params?.sessionId)
    // only a request (a frame with an id) counts; a notification is not recorded
    if (id !== undefined) try { fs.appendFileSync(path.join(process.env.AGY_ACP_HOME ?? os.tmpdir(), "closed-sessions"), `${params?.sessionId}\n`) } catch {}
    return {}
  },
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on("line", async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === undefined) {
    const resolve = pendingPermissions.get(msg.id)
    pendingPermissions.delete(msg.id)
    resolve?.(msg.result?.outcome)
    return
  }
  if (msg.id === undefined) {
    // a notification (session/cancel); still let it settle a pending prompt
    await handlers[msg.method]?.(msg.params, undefined)
    return
  }
  const fn = handlers[msg.method]
  if (!fn) return fail(msg.id, -32601, `${msg.method} is not supported`)
  try {
    const result = await fn(msg.params, msg.id)
    if (result !== undefined) reply(msg.id, result)
    else reply(msg.id, {})
  } catch (e) {
    fail(msg.id, -32000, String(e?.message ?? e))
  }
})
