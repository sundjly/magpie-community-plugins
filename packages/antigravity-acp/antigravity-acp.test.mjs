// The plugin's tests, as bun:test (so the repository's `bun test` runs them):
// no download, no Google — the ACP server is faked by test/fake-acp-server.mjs
// behind AGY_ACP_BIN, and the sign-in it keeps is faked in a temporary
// AGY_ACP_HOME. Exercises the config, sign-in, models, usage, and the
// streaming / tool-call / non-streaming fetch paths end to end, plus the
// failure paths: a refused prompt (a lost sign-in), a refusal after the reply
// started, a server that dies under the request, and where the plugin lets
// the server work.
import { test, expect, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginPath = path.join(here, "index.mjs")

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"))
process.env.AGY_ACP_HOME = home
process.env.AGY_ACP_AUTH_DIR = path.join(home, ".gemini", "antigravity-acp")
fs.mkdirSync(process.env.AGY_ACP_AUTH_DIR, { recursive: true })
fs.writeFileSync(path.join(process.env.AGY_ACP_AUTH_DIR, "settings.json"), JSON.stringify({ auth: { type: "oauth-personal" } }))
fs.writeFileSync(path.join(process.env.AGY_ACP_AUTH_DIR, "acp_token.json"), JSON.stringify({ refresh_token: "x", email: "me@example.com" }))

// the fake server as an executable the launcher accepts (a shebang wrapper;
// it needs a POSIX shell, so on Windows every test is skipped). Each test
// starts a bun child cold, so a busy CI box gets 30 s instead of bun's 5 s
const onPosix = process.platform === "win32" ? test.skip : (name, fn, timeout = 30_000) => test(name, fn, timeout)
const bin = path.join(home, "bin")
fs.mkdirSync(bin, { recursive: true })
const wrapper = path.join(bin, "agy_acp_server.par")
fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, "test", "fake-acp-server.mjs")}" "$@"\n`, { mode: 0o755 })
process.env.AGY_ACP_BIN = wrapper

const { AntigravityAcpPlugin, _internal } = await import(pluginPath)

const logs = []
const plugin = await AntigravityAcpPlugin({
  client: {
    app: { log: async (o) => logs.push(String(o?.body?.message ?? o?.message ?? "")) },
    tui: { showToast: async (o) => logs.push(`toast: ${String(o?.body?.message ?? o?.message ?? "")}`) },
  },
  // magpie's own folder, as the host passes it — never to become the
  // server's cwd (that one holds auth.json)
  directory: path.join(home, "magpie-config"),
})

const loaderOptions = await plugin.auth.loader(async () => ({ type: "oauth", refresh: "x" }))
const URL_ = "https://antigravity-acp.invalid/v1/chat/completions"
const chat = (body) =>
  loaderOptions.fetch(URL_, { method: "POST", headers: {}, body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hello" }], ...body }) })

onPosix("config registers the provider with fallback models", async () => {
  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider["antigravity-acp"]
  expect(p?.npm).toBe("@ai-sdk/openai-compatible")
  expect(p?.models?.["gemini-3.8-flash"]).toBeTruthy()
})

onPosix("resolveLaunch finds AGY_ACP_BIN", () => {
  const found = _internal.resolveLaunch()
  expect(found?.command).toBe(wrapper)
  expect(found?.source).toBe("env")
})

onPosix("sign-in with the current Google account", async () => {
  const method = plugin.auth.methods[1]
  const a = await method.authorize()
  expect(a.method).toBe("auto")
  const r = await a.callback()
  expect(r.type).toBe("success")
  expect(r.refresh).toBe("managed-by-the-acp-server")
  expect(r.accountId).toBe("me@example.com")
})

onPosix("models: the fake's effort-qualified ids, folded into families", async () => {
  const models = await plugin.provider.models({ id: "antigravity-acp", models: {} }, { auth: { type: "oauth", refresh: "x" } })
  const flash = models["gemini-3.8-flash"]
  expect(flash?.variants?.low?.reasoningEffort).toBe("low")
  expect(flash?.variants?.medium?.reasoningEffort).toBe("medium")
  expect(flash?.variants?.high?.reasoningEffort).toBe("high")
  const pro = models["gemini-3.1-pro"]
  expect(pro?.variants?.low).toBeTruthy()
  expect(pro?.variants?.high).toBeTruthy()
  expect(pro?.variants?.medium).toBeUndefined()
  expect(models["gemini-3.8-flash-low"]).toBeUndefined()
})

onPosix("streaming reply with the effort's variant, thought, usage and [DONE]", async () => {
  const res = await chat({ stream: true, model: "gemini-3.8-flash", reasoning_effort: "high" })
  expect(res.status).toBe(200)
  expect(String(res.headers.get("content-type"))).toContain("text/event-stream")
  const body = await res.text()
  // the model chosen from the effort lands in the reply text, so the
  // assertion doubles as a check that the variant was set on the session
  expect(body).toContain("from fake at gemini-3.8-flash-high")
  expect(body).toContain('"finish_reason":"stop"')
  expect(body).toContain("[DONE]")
  expect(body).not.toContain("gemini-3.8-flash-low")
})

onPosix("client tool called through the bridge, delivered as tool_calls", async () => {
  const res = await chat({
    stream: true,
    model: "gemini-3.1-pro",
    tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
    messages: [{ role: "user", content: "USE_TOOL please" }],
  })
  const body = await res.text()
  expect(body).toContain('"tool_calls"')
  expect(body).toContain('"finish_reason":"tool_calls"')
  const call = JSON.parse(body.split("\n").find((l) => l.includes("tool_calls"))?.replace(/^data: /, "") ?? "{}")
  const tc = call.choices?.[0]?.delta?.tool_calls?.[0]
  expect(tc?.function?.name).toBe("bash")
  const args = JSON.parse(tc.function.arguments)
  expect(args.command).toBe("echo hi")
  expect(args._from).toBe("fake-acp")
})

onPosix("streaming hides replayed tool history without losing the live tool call", async () => {
  const res = await chat({
    stream: true,
    tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
    messages: [{ role: "user", content: "USE_TOOL ECHO_HISTORY" }],
  })
  const chunks = (await res.text()).split("\n").filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)))
  const text = chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("")
  expect(text).toBe("I’m making the change.\n")
  expect(chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? []).map((call) => call.function.name)).toEqual(["bash"])
  expect(chunks.at(-1).choices[0].finish_reason).toBe("tool_calls")
})

test("history keeps a Write target and omits its large payload", () => {
  const { markdown } = _internal.buildPrompt({ messages: [
    { role: "user", content: "create the file" },
    { role: "assistant", tool_calls: [{
      function: { name: "Write", arguments: JSON.stringify({ file_path: "/tmp/example.py", content: "SYNTHETIC_FILE_BODY".repeat(140) }) },
    }] },
    { role: "tool", name: "Write", content: "file created" },
    { role: "user", content: "continue" },
  ] })
  expect(markdown).toContain("/tmp/example.py")
  expect(markdown).toContain("characters omitted")
  expect(markdown).not.toContain("SYNTHETIC_FILE_BODY")
  expect(markdown).toContain("file created")
})

onPosix("a client tool result resumes its ACP prompt and returns recorded cache usage", async () => {
  const messages = [{ role: "user", content: "USE_TOOL PARK_TOOL" }]
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }]
  const request = (history, stream = false) => loaderOptions.fetch(URL_, {
    headers: { "X-Magpie-Session": "pending-tool-test" },
    body: JSON.stringify({ model: "gemini-3.8-flash", messages: history, tools, stream }),
  })
  const first = await (await request(messages)).json()
  expect(first.choices[0].finish_reason).toBe("tool_calls")
  expect(first.usage.magpie_cache_unknown).toBe(true)
  const reply = first.choices[0].message
  const call = reply.tool_calls[0]
  call.function.arguments = '{"_from": "fake-acp", "command": "echo hi"}'
  const out = await (await request([...messages, reply,
    { role: "tool", tool_call_id: call.id, content: "SYNTHETIC_RESULT" }], true)).text()
  const text = out.split("\n").filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content ?? "").join("")
  expect(text).toBe("Client result: SYNTHETIC_RESULT")
  // ACP summed both chat turns' calls (810, 800 cached) and no per-step row
  // is readable, so the closing context is split per turn; the hit ratio holds
  expect(out).toContain('"prompt_tokens":405')
  expect(out).toContain('"cached_tokens":400')
  expect(out).not.toContain("[called ")
})

onPosix("tool results followed by attached user text still resume the parked ACP prompt", async () => {
  const messages = [{ role: "user", content: "USE_TOOL PARK_TOOL" }]
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }]
  const request = (history) => loaderOptions.fetch(URL_, {
    headers: { "X-Magpie-Session": "pending-tool-extra-text" },
    body: JSON.stringify({ model: "gemini-3.8-flash", messages: history, tools, stream: true }),
  })
  const first = await request(messages)
  const firstBody = await first.text()
  const call = firstBody.split("\n").filter((line) => line.startsWith("data: {"))
    .flatMap((line) => JSON.parse(line.slice(6)).choices[0].delta.tool_calls ?? [])[0]
  expect(call?.id).toBeTruthy()
  const reply = { role: "assistant", content: "", tool_calls: [{ id: call.id, type: "function", function: { name: "bash", arguments: call.function.arguments } }] }
  // Claude Code sends the tool_result and a system reminder in one user turn;
  // the OpenAI shape splits it into a tool message and a user message
  const out = await (await request([...messages, reply,
    { role: "tool", tool_call_id: call.id, content: "SYNTHETIC_RESULT" },
    { role: "user", content: "<system-reminder>SYNTHETIC_REMINDER</system-reminder>" }])).text()
  const text = out.split("\n").filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content ?? "").join("")
  expect(text).toBe("Client result: SYNTHETIC_RESULT | <system-reminder>SYNTHETIC_REMINDER</system-reminder>")
})

onPosix("a Claude Code side query keeps the main conversation's ACP session warm", async () => {
  const system = { role: "system", content: "Keep the same instructions." }
  const run = (history) => loaderOptions.fetch(URL_, {
    headers: { "X-Magpie-Session": "side-query-test", "X-Magpie-Caller-Agent": "claude" },
    body: JSON.stringify({ model: "gemini-3.8-flash", stream: false, messages: [system, ...history] }),
  }).then((r) => r.json())
  const main = [{ role: "user", content: "First turn" }]
  const first = await run(main)
  expect(first.usage.prompt_tokens_details.cached_tokens).toBe(0)
  const after = [...main, first.choices[0].message]
  const recap = await run([...after, { role: "user", content:
    "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown." }])
  expect(recap.usage.prompt_tokens_details.cached_tokens).toBe(1000)
  // the main line never saw the recap, and still continues the same session
  const next = await run([...after, { role: "user", content: "Next turn" }])
  expect(next.usage.prompt_tokens_details.cached_tokens).toBe(1000)
  // an ordinary diverging turn still starts over
  const branch = await run([...after, first.choices[0].message, { role: "user", content: "Different line" }])
  expect(branch.usage.prompt_tokens_details.cached_tokens).toBe(0)
})

onPosix("parked tool turns report per-step SQLite usage and reconcile the final turn without double-counting", async () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }]
  for (const [sessionHeader, promptText] of [
    ["store-usage-reconcile", "USE_TOOL PARK_TOOL STORE_USAGE"],
    ["store-usage-fallback", "USE_TOOL PARK_TOOL STORE_USAGE STORE_USAGE_SKIP_FINAL"],
  ]) {
    const messages = [{ role: "user", content: promptText }]
    const request = (history, stream = false) => loaderOptions.fetch(URL_, {
      headers: { "X-Magpie-Session": sessionHeader },
      body: JSON.stringify({ model: "gemini-3.8-flash", messages: history, tools, stream }),
    })
    const first = await (await request(messages)).json()
    expect(first.choices[0].finish_reason).toBe("tool_calls")
    expect(first.usage).toEqual({
      prompt_tokens: 5000,
      completion_tokens: 120,
      total_tokens: 5120,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 80 },
    })
    const reply = first.choices[0].message
    const call = reply.tool_calls[0]
    const secondBody = await (await request([...messages, reply,
      { role: "tool", tool_call_id: call.id, content: "SYNTHETIC_RESULT" }], true)).text()
    const finalUsage = secondBody.split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)))
      .find((chunk) => chunk.usage)?.usage
    expect(finalUsage).toEqual({
      prompt_tokens: 5300,
      completion_tokens: 60,
      total_tokens: 5360,
      prompt_tokens_details: { cached_tokens: 4900, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 20 },
    })
  }
})

onPosix("a summed multi-step ACP total is never reported as the closing turn's context size", async () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }]
  for (const [sessionHeader, promptText, expected] of [
    // the parked turn measured 5000; the 17100-token remainder spans several calls
    ["store-usage-bloated", "USE_TOOL PARK_TOOL STORE_USAGE_BLOATED", { prompt: 5000, cached: 0, output: 180 }],
    // nothing measured: the 22100-token sum is split over the two chat turns
    ["store-usage-none", "USE_TOOL PARK_TOOL STORE_USAGE_NONE", { prompt: 11050, cached: 7950, output: 300 }],
  ]) {
    const messages = [{ role: "user", content: promptText }]
    const request = (history, stream = false) => loaderOptions.fetch(URL_, {
      headers: { "X-Magpie-Session": sessionHeader },
      body: JSON.stringify({ model: "gemini-3.8-flash", messages: history, tools, stream }),
    })
    const first = await (await request(messages)).json()
    expect(first.choices[0].finish_reason).toBe("tool_calls")
    const reply = first.choices[0].message
    const call = reply.tool_calls[0]
    const body = await (await request([...messages, reply,
      { role: "tool", tool_call_id: call.id, content: "SYNTHETIC_RESULT" }], true)).text()
    const usage = body.split("\n").filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6))).find((chunk) => chunk.usage)?.usage
    expect(usage.prompt_tokens).toBe(expected.prompt)
    expect(usage.prompt_tokens_details.cached_tokens).toBe(expected.cached)
    expect(usage.completion_tokens).toBe(expected.output)
    expect(usage.prompt_tokens).toBeLessThan(22100)
  }
})

onPosix("non-streaming reply with usage", async () => {
  const res = await chat({
    stream: false,
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
      { role: "tool", tool_call_id: "c1", name: "bash", content: "file.txt" },
    ],
  })
  const data = await res.json()
  expect(data.object).toBe("chat.completion")
  expect(data.choices?.[0]?.finish_reason).toBe("stop")
  expect(String(data.choices?.[0]?.message?.content)).toContain("Hello")
  expect(data.usage?.total_tokens).toBe(15)
})

onPosix("a matching Magpie conversation reuses ACP and forwards its recorded cache reads", async () => {
  const messages = [{ role: "system", content: "Keep the same instructions." }, { role: "user", content: "First turn" }]
  const model = "gemini-3.8-flash"
  const run = (history, { stream = false, subagent = "main", session = "cache-test" } = {}) =>
    loaderOptions.fetch(URL_, {
      headers: { "X-Magpie-Session": session, "X-Magpie-Caller-Agent": "claude", "X-Magpie-Subagent": subagent },
      body: JSON.stringify({ model, stream, messages: history }),
    })
  const first = await (await run(messages)).json()
  expect(first.usage.prompt_tokens_details.cached_tokens).toBe(0)
  const next = [...messages, first.choices[0].message, { role: "user", content: "Next turn" }]
  const continued = await (await run(next, { stream: true })).text()
  const usage = continued.split("\n").filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6))).find((chunk) => chunk.usage).usage
  expect(usage.prompt_tokens).toBe(1010)
  expect(usage.completion_tokens).toBe(5)
  expect(usage.prompt_tokens_details.cached_tokens).toBe(1000)
  const sibling = await (await run(next, { subagent: "sibling" })).json()
  expect(sibling.usage.prompt_tokens_details.cached_tokens).toBe(0)
  const branch = [messages[0], { role: "user", content: "Replace the earlier conversation" }, first.choices[0].message, next.at(-1)]
  const changed = await (await run(branch)).json()
  expect(changed.usage.prompt_tokens_details.cached_tokens).toBe(0)
  const noSession = await (await run(next, { session: "" })).json()
  expect(noSession.usage.prompt_tokens_details.cached_tokens).toBe(0)
})

onPosix("a refused prompt (-32000) fails the request and marks the sign-in expired", async () => {
  let err
  try {
    await chat({ messages: [{ role: "user", content: "AUTHFAIL" }] })
  } catch (e) {
    err = e
  }
  expect(err).toBeDefined()
  expect(String(err.message)).toMatch(/signed in again/)
  expect(err.signIn).toBe("expired")
})

onPosix("a refusal after the reply started rides as the reply's tail", async () => {
  const res = await chat({ stream: true, messages: [{ role: "user", content: "FAILMID" }] })
  expect(res.status).toBe(200)
  const body = await res.text()
  expect(body).toContain("partial")
  expect(body).toContain("[Antigravity: authentication required]")
  expect(body).toContain("[DONE]")
})

onPosix("a server that dies under the request is retried once on a fresh one", async () => {
  const res = await chat({ stream: false, messages: [{ role: "user", content: "DIEONCE" }] })
  expect(res.status).toBe(200)
  const data = await res.json()
  expect(String(data.choices?.[0]?.message?.content)).toContain("Hello")
  expect(fs.existsSync(path.join(home, "died-once"))).toBe(true)
})

onPosix("the server works in the plugin's own workspace, never magpie's folder", async () => {
  await chat({ stream: false })
  const cwd = fs.readFileSync(path.join(home, "last-cwd"), "utf8")
  expect(cwd).toBe(path.join(_internal.runtimeRoot(), "workspace"))
  expect(cwd).not.toBe(path.join(home, "magpie-config"))
})

onPosix("pid files live in the plugin's runtime root, not ~/.gemini", async () => {
  await chat({ stream: false })
  const run = path.join(_internal.runtimeRoot(), "run")
  expect(fs.existsSync(path.join(run, `magpie-acp-pids-${process.pid}.json`))).toBe(true)
  const listed = fs.readdirSync(process.env.AGY_ACP_AUTH_DIR)
  expect(listed.filter((f) => f.startsWith("magpie-acp-pids"))).toEqual([])
})

onPosix("the session is closed over the wire when its request ends", async () => {
  await chat({ stream: false })
  // the fake advertises sessionCapabilities.close: {}, so the plugin sends
  // session/close as a real request; the fake records what it got. The
  // request rides the stdin pipe, so the record may lag the reply a little
  let closed = ""
  for (let i = 0; i < 40 && !closed; i++) {
    await new Promise((r) => setTimeout(r, 50))
    try { closed = fs.readFileSync(path.join(home, "closed-sessions"), "utf8") } catch {}
  }
  expect(closed.trim()).not.toBe("")
})

// ACP's capability is an object: omitted or null means the server can't close
for (const [label, flag] of [["omitted", "FAKE_NO_CLOSE"], ["null", "FAKE_CLOSE_NULL"]]) {
  onPosix(`no session/close is sent when the server's close capability is ${label}`, async () => {
    const conn = new _internal.AcpConnection({ command: wrapper, args: [], cwd: home, env: { ...process.env, [flag]: "1" } })
    conn.start()
    try {
      await conn.initialize()
      expect(conn.canClose).toBe(false)
      const session = await conn.newSession(home, [], 5_000)
      const file = path.join(home, "closed-sessions")
      fs.rmSync(file, { force: true })
      conn.closeSession(session.sessionId)
      await new Promise((r) => setTimeout(r, 300))
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      conn.kill()
    }
  })
}

onPosix("requests that arrive together share one server", async () => {
  _internal.shutdown()
  const spawns = path.join(home, "spawns")
  fs.rmSync(spawns, { force: true })
  const replies = await Promise.all([chat({ stream: false }), chat({ stream: false }), chat({ stream: false })])
  for (const r of replies) expect(r.status).toBe(200)
  expect(fs.readFileSync(spawns, "utf8").trim().split("\n")).toHaveLength(1)
})

onPosix("a long history is cut from its oldest end; the instructions stay", () => {
  const filler = "x".repeat(1000)
  const messages = [{ role: "system", content: "KEEP-ME" }]
  for (let i = 0; i < 600; i++) messages.push({ role: i % 2 ? "assistant" : "user", content: `m${i} ${filler}` })
  messages.push({ role: "user", content: "last" })
  const { markdown } = _internal.buildPrompt({ messages })
  expect(markdown.length).toBeLessThanOrEqual(400_000)
  expect(markdown).toContain("KEEP-ME")
  expect(markdown).toContain("[older context truncated]")
  expect(markdown).toContain("m599 ")
  expect(markdown).not.toContain("m0 ")
})

onPosix("a timed-out call is cancelled alone; the server lives on", async () => {
  const conn = new _internal.AcpConnection({ command: wrapper, args: [], cwd: home })
  conn.start()
  try {
    await conn.initialize()
    const session = await conn.newSession(home, [], 5_000)
    // HANG never answers; the 300ms wait runs out with killOnTimeout false
    const hang = conn.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "HANG" }] }, 300, false)
    await expect(hang.promise).rejects.toThrow(/didn't answer session\/prompt/)
    // the server is still with us and answers the next request
    expect(conn.live).toBe(true)
    const next = await conn.newSession(home, [], 5_000)
    expect(next.sessionId).toBeTruthy()
  } finally {
    conn.kill()
  }
})

onPosix("usage reads the account quota before any model request", async () => {
  const u = await plugin.auth.usage(async () => ({ type: "oauth", refresh: "x" }))
  expect(u.plan).toBe("ultra")
  expect(u.windows?.[0]?.name).toBe("Gemini · Weekly")
  expect(u.windows[0].used).toBe(10)
  expect(u.windows[0].resetsAt).toBe("2026-11-30T20:03:00.000Z")
  expect(u.windows[0].aside).toBe(true)
})

onPosix("adding another Google account leaves the original login, models and quota independent", async () => {
  const originalToken = path.join(process.env.AGY_ACP_AUTH_DIR, "acp_token.json")
  const before = fs.readFileSync(originalToken, "utf8")
  const add = plugin.auth.methods.find((method) => method.labels?.zh === "添加独立 Google 账号")
  const previousKey = process.env.GEMINI_API_KEY
  process.env.GEMINI_API_KEY = "ambient-key-must-not-reach-the-profile"
  let second
  try {
    const flow = await add.authorize()
    expect(flow.method).toBe("auto")
    second = await flow.callback()
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = previousKey
  }
  expect(second.type).toBe("success")
  expect(second.refresh).toMatch(/^managed-by-the-acp-server:[0-9a-f]{32}$/)
  expect(second.accountId).toContain("second@example.com")
  expect(fs.readFileSync(originalToken, "utf8")).toBe(before)

  const legacy = { type: "oauth", refresh: "managed-by-the-acp-server" }
  const isolated = { ...second, type: "oauth" }
  const provider = { id: "antigravity-acp", models: {} }
  const firstModels = await plugin.provider.models(provider, { auth: legacy })
  const secondModels = await plugin.provider.models(provider, { auth: isolated })
  expect(firstModels["gemini-3.8-flash"].variants.high).toBeTruthy()
  expect(secondModels["gemini-3.8-flash"].variants.high).toBeUndefined()

  let selected = legacy
  const client = await plugin.auth.loader(async () => selected)
  const prompt = () => client.fetch(URL_, {
    method: "POST",
    body: JSON.stringify({
      model: "gemini-3.8-flash", reasoning_effort: "high", messages: [{ role: "user", content: "hello" }],
    }),
  }).then((r) => r.json()).then((r) => r.choices[0].message.content)
  expect(await prompt()).toBe("Hello from fake at gemini-3.8-flash-high")
  selected = isolated
  expect(await prompt()).toBe("Hello from fake at gemini-3.8-flash-medium as second@example.com")
  selected = legacy
  expect(await prompt()).toBe("Hello from fake at gemini-3.8-flash-high")
  expect((await plugin.auth.usage(async () => legacy)).windows[0].used).toBe(10)
  expect((await plugin.auth.usage(async () => isolated)).windows[0].used).toBe(30)
  expect(fs.readFileSync(originalToken, "utf8")).toBe(before)

  const profileId = second.refresh.split(":")[1]
  const tokenFile = path.join(_internal.runtimeRoot(), "accounts", profileId, ".gemini", "antigravity-acp", "acp_token.json")
  fs.unlinkSync(tokenFile)
  selected = isolated
  await expect(prompt()).rejects.toThrow("local Antigravity ACP sign-in is missing")
  selected = { ...isolated, refresh: "managed-by-the-acp-server:../../other" }
  await expect(prompt()).rejects.toThrow("Invalid Antigravity ACP profile")
})

onPosix("refresh leaves the sign-in to the server", async () => {
  const nothing = await plugin.auth.refresh({ type: "oauth", refresh: "x" })
  expect(nothing).toBeUndefined()
})

onPosix("sweepStaging removes a dead installer's staging dir, and only that", () => {
  const versions = path.join(_internal.runtimeRoot(), "versions")
  fs.mkdirSync(path.join(versions, ".install-dead"), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(versions, ".install-dead", "download.zip"), "partial archive")
  fs.mkdirSync(path.join(versions, "keepme", "x"), { recursive: true, mode: 0o700 })
  try {
    _internal.sweepStaging()
    expect(fs.existsSync(path.join(versions, ".install-dead"))).toBe(false)
    expect(fs.existsSync(path.join(versions, "keepme", "x"))).toBe(true)
  } finally {
    fs.rmSync(path.join(versions, "keepme"), { recursive: true, force: true })
  }
})

test("projectModels folds families, keeps one-offs", () => {
  const projected = _internal.projectModels([
    { modelId: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
    { modelId: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
    { modelId: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
    { modelId: "gemini-3.7-flash-tiered", name: "Gemini 3.7 Flash (Tiered)" },
  ])
  const ids = projected.map((m) => m.id)
  expect(ids).toContain("gemini-3.7-flash")
  expect(ids).toContain("gemini-3.7-flash-tiered")
})

afterAll(async () => {
  // the pooled servers hold the workspace open; let them go, wait for the
  // kills to land, then take the temporary home with us
  _internal.shutdown()
  await new Promise((r) => setTimeout(r, 500))
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})
