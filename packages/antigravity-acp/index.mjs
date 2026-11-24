// Google Antigravity through its official ACP server, as an OpenCode (v1)
// provider plugin for magpie.
//
// Antigravity's ACP server (agy_acp_server.par, dl.google.com) is the agent
// runtime the Antigravity IDE speaks. It owns the Google sign-in itself, and
// decides alone where it keeps it (an install with the IDE signed in may
// carry no token file at all), so the plugin stores a marker, never a token,
// and reads the sign-in's health from the server's own answers: a session
// can be made signed-out, but only a real credential gets a prompt through.
// Existing sign-ins keep the default profile. Additional Google accounts
// each use a private profile owned by the official ACP runtime.
//
// Start with the client transcript and keep the ACP session for a verified
// continuation. Client tools are served over a loopback MCP bridge.
// Only MCP tools declared by the client can be forwarded to it.
//
// The server is found, first to last: AGY_ACP_BIN, the managed install at
// ~/.local/opt/agy-acp/current, ~/.local/bin/agy_acp_server.par, PATH; when
// none is there, the release pinned in runtime-manifest.json is downloaded,
// checked against its SHA-256 and sizes, and validated over ACP before use.
import { spawn, execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const PROVIDER = "antigravity-acp"
// never contacted: every request is answered by the loader's fetch below
const API_BASE = "https://antigravity-acp.invalid/v1"
// the sign-in this plugin keeps: the ACP server holds the real tokens
const MANAGED = "managed-by-the-acp-server"
const PROFILE_MARKER = `${MANAGED}:`
const PROFILE_ID = /^[0-9a-f]{32}$/
const QUOTA_TTL = 60_000
const PROTOCOL_VERSION = 1
const INIT_TIMEOUT = 30_000
const AUTH_TIMEOUT = 3 * 60_000
const AUTH_RELAY_TIMEOUT = 10 * 60_000
const MODEL_STEP_TYPE = 15
const MODEL_STEP_DONE = 3
const STEP_USAGE_WAIT_MS = 1_000
const STEP_USAGE_SAME_GEN_WAIT_MS = 75
const STEP_USAGE_POLL_MS = 25
const requireModule = createRequire(import.meta.url)
const OP_TIMEOUT = 120_000
// the install lock goes stale after INSTALL_TIMEOUT + 5 min (see withInstallLock); the waiter waits as long
const INSTALL_TIMEOUT = 30 * 60_000
const PROMPT_TIMEOUT = 10 * 60_000
const MAX_FRAME = 32 << 20
const STDERR_MAX = 16 << 10
const RECONSTRUCTION_MAX = 400_000
const HISTORICAL_ARGUMENT_LIMIT = 1200
const MAX_TOOLS = 64
const SCHEMA_MAX = 64 << 10
// an idle conversation keeps its ACP session this long; one parked on a client
// tool call is bounded by the prompt timeout anyway
const IDLE_SESSION_TIMEOUT = 30 * 60_000
const PARKED_SESSION_TIMEOUT = 5 * 60_000
const MAX_IDLE_SESSIONS = 16
// chromium writes this on stdout during browser sign-in; it isn't ACP
const BROWSER_NOISE = /opening in existing browser session/i

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, "runtime-manifest.json"), "utf8"))
const RELEASE = MANIFEST.releases.at(-1)
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version

// homeDir is where the Antigravity sign-in and the managed runtime live
// (~/.gemini, ~/.local); AGY_ACP_HOME moves them all, for tests and sandboxes.
const homeDir = () => process.env.AGY_ACP_HOME || os.homedir()
const runtimeRoot = () => process.env.AGY_ACP_RUNTIME_ROOT || path.join(homeDir(), ".local", "opt", "agy-acp")
const authDir = (profile) => profile
  ? path.join(profile, ".gemini", "antigravity-acp")
  : process.env.AGY_ACP_AUTH_DIR || path.join(homeDir(), ".gemini", "antigravity-acp")

// what the plugin runs with, set when magpie loads it
const ctx = { client: null }

const note = (message) => { try { ctx.client?.app?.log?.({ service: "antigravity-acp", level: "info", message }) } catch {} }
const toast = (message, variant = "info") => { try { ctx.client?.tui?.showToast?.({ title: "Antigravity (ACP)", message, variant }) } catch {} }

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return null } }

const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const executable = (p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false }
}

// ---- the ACP server's command --------------------------------------------------

const binaryName = () => (process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par")

// directOrWrapper: a .par that starts with a shebang is a wrapper script and
// takes no arguments; a native one wants the server's empty --uid on Linux.
function launchArgs(command) {
  if (process.platform === "win32") return []
  try {
    const fd = fs.openSync(command, "r")
    const bytes = Buffer.alloc(2)
    const n = fs.readSync(fd, bytes, 0, 2, 0)
    fs.closeSync(fd)
    if (bytes.subarray(0, n).toString("utf8") === "#!") return []
  } catch {}
  return process.platform === "linux" ? ["--uid="] : []
}

// resolveLaunch is where a server already on this machine is, first to last:
// AGY_ACP_BIN, the managed current release, ~/.local/bin, PATH.
function resolveLaunch() {
  const env = process.env.AGY_ACP_BIN?.trim()
  if (env) {
    const tilde = env.match(/^~([\/\\])(.*)$/)
    const p = tilde ? path.join(homeDir(), tilde[2]) : env
    if (executable(p)) return { command: p, args: launchArgs(p), source: "env" }
  }
  const managed = path.join(runtimeRoot(), "current", binaryName())
  if (executable(managed)) {
    const installed = readJSON(path.join(path.dirname(managed), "install-integrity.json"))
    if (installed && installed.version !== RELEASE.version) return null
    return { command: managed, args: launchArgs(managed), source: "managed" }
  }
  const userBin = path.join(homeDir(), ".local", "bin", "agy_acp_server.par")
  if (executable(userBin)) return { command: userBin, args: launchArgs(userBin), source: "user-bin" }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, binaryName())
    if (executable(p)) return { command: p, args: launchArgs(p), source: "path" }
  }
  return null
}

function platformKey() {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch
  if (process.platform === "darwin") return `darwin-${arch}`
  if (process.platform === "linux") return `linux-${arch}`
  if (process.platform === "win32") return `windows-${arch}`
  throw new Error(`Google publishes no Antigravity ACP build for ${process.platform}/${process.arch}`)
}

const runFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10 * 60_000 }, (e, stdout, stderr) =>
      e ? reject(Object.assign(e, { stderr: String(stderr ?? "").slice(0, 400) })) : resolve(String(stdout)))
  })

// children tracks every process the plugin started, so a graceful exit takes
// them along; a killed magpie leaves the pid file for the next start to reap.
const children = new Set()
function track(child) {
  children.add(child)
  child.once("close", () => children.delete(child))
}
process.on("exit", () => {
  for (const c of children) { try { c.kill("SIGKILL") } catch {} }
  // this host's own pid file goes with it; other hosts' stay for their next start
  try { fs.rmSync(pidFile(), { force: true }) } catch {}
})

// ---- installing the managed runtime --------------------------------------------

function isInstalled(dir, asset) {
  return [asset.binaryName, asset.harnessName].every((name) => {
    try { return fs.statSync(path.join(dir, name)).size === asset[`${name === asset.binaryName ? "binaryBytes" : "harnessBytes"}`] } catch { return false }
  })
}

function pointCurrentAt(destination) {
  const current = path.join(runtimeRoot(), "current")
  if (process.platform !== "win32") {
    const next = path.join(runtimeRoot(), `.current-${randomUUID()}`)
    fs.symlinkSync(destination, next, "dir")
    try { fs.renameSync(next, current) } finally { fs.rmSync(next, { force: true }) }
    return
  }
  fs.rmSync(current, { force: true, recursive: true })
  fs.symlinkSync(destination, current, "junction")
}

let installLock = null
async function withInstallLock(fn) {
  const dir = path.join(runtimeRoot(), ".install-lock")
  // a second installer waits for as long as the first may hold the lock —
  // a slow download isn't a stuck one
  const wait = INSTALL_TIMEOUT + 5 * 60_000
  const end = Date.now() + wait
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 })
  for (;;) {
    try { fs.mkdirSync(dir); break } catch (e) {
      if (e?.code !== "EEXIST") throw e
      let born = 0
      try { born = fs.statSync(dir).mtimeMs } catch {}
      // a lock left by a dead process is taken back, but only after longer
      // than the download it guards can run: a slow first install never has
      // its lock taken while it is still working
      if (Date.now() - born > wait) { try { fs.rmdirSync(dir) } catch {} }
      if (Date.now() > end) throw new Error(`another Antigravity ACP install has been running for over ${Math.round(wait / 60_000)} minutes`)
      await sleep(1000)
    }
  }
  installLock = dir
  try { return await fn() } finally { installLock = null; try { fs.rmdirSync(dir) } catch {} }
}

async function ensureRuntime() {
  const found = resolveLaunch()
  if (found) return found
  toast("The Antigravity ACP server isn't installed; downloading it (a large download)…")
  await withInstallLock(async () => {
    if (resolveLaunch()) return
    await installLatest()
  })
  const made = resolveLaunch()
  if (!made) throw new Error("the Antigravity ACP server didn't install; set AGY_ACP_BIN to an agy_acp_server.par of your own")
  return made
}

// sweepStaging takes the staging dirs a killed installer left in versions/:
// each held a partial download, and only its dead owner ever names them
function sweepStaging() {
  const versions = path.join(runtimeRoot(), "versions")
  let entries
  try { entries = fs.readdirSync(versions) } catch { return }
  for (const name of entries) {
    if (!name.startsWith(".install-")) continue
    try { fs.rmSync(path.join(versions, name), { recursive: true, force: true }) } catch {}
  }
}

async function installLatest() {
  const key = platformKey()
  const release = RELEASE
  const asset = release.platforms[key]
  if (!asset) throw new Error(`the pinned Antigravity ACP ${release.version} has no build for ${key}`)
  const root = runtimeRoot()
  const versions = path.join(root, "versions")
  fs.mkdirSync(versions, { recursive: true, mode: 0o700 })
  // installLatest runs only under the install lock, so any .install-* still
  // in versions/ belongs to a dead installer and is safe to take away
  sweepStaging()
  const destination = path.join(versions, asset.archiveSha256.slice(0, 16))
  if (isInstalled(destination, asset)) return pointCurrentAt(destination)

  const staging = fs.mkdtempSync(path.join(versions, ".install-"))
  const runtime = path.join(staging, "runtime")
  fs.mkdirSync(runtime, { mode: 0o700 })
  try {
    const archive = path.join(staging, "download.zip")
    note(`downloading Antigravity ACP ${release.version} for ${key}`)
    await download(asset, archive)
    note("extracting the Antigravity ACP server")
    await extract(archive, runtime, asset)
    fs.rmSync(archive, { force: true })
    if (process.platform !== "win32") {
      for (const name of [asset.binaryName, asset.harnessName]) fs.chmodSync(path.join(runtime, name), 0o755)
    }
    if (process.platform === "darwin") {
      for (const name of [asset.binaryName, asset.harnessName]) await runFile("xattr", ["-d", "com.apple.quarantine", path.join(runtime, name)]).catch(() => "")
    }
    note("checking the downloaded server over ACP")
    await validateInstall(runtime, asset, release.version)
    fs.writeFileSync(path.join(runtime, "install-integrity.json"), JSON.stringify({
      version: release.version, platform: key, archive: asset.archive, archiveSha256: asset.archiveSha256,
      installedAt: new Date().toISOString(), by: "@magpie-community/opencode-antigravity-acp-auth",
    }, null, 2) + "\n", { mode: 0o600 })
    try {
      fs.renameSync(runtime, destination)
    } catch (e) {
      if (!isInstalled(destination, asset)) throw e
    }
    pointCurrentAt(destination)
    toast(`Antigravity ACP ${release.version} is ready.`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

async function download(asset, destination) {
  const res = await fetch(asset.archive, { signal: AbortSignal.timeout(INSTALL_TIMEOUT) })
  if (!res.ok || !res.body) throw new Error(`the Antigravity ACP download said HTTP ${res.status}`)
  const hash = createHash("sha256")
  const out = fs.createWriteStream(destination, { mode: 0o600 })
  let received = 0
  let said = 0
  try {
    for await (const chunk of res.body) {
      received += chunk.byteLength
      if (received > asset.archiveBytes) throw new Error("the Antigravity ACP download is bigger than its manifest says")
      hash.update(chunk)
      const percent = Math.floor((received / asset.archiveBytes) * 100)
      if (percent >= said + 25) { said = percent; note(`downloading Antigravity ACP: ${percent}%`) }
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r))
    }
  } catch (e) {
    out.destroy()
    throw e
  }
  out.end()
  await new Promise((r, j) => { out.on("finish", r); out.on("error", j) })
  if (received !== asset.archiveBytes) throw new Error(`the Antigravity ACP download is ${received} bytes; the manifest says ${asset.archiveBytes}`)
  const sha = hash.digest("hex")
  if (sha !== asset.archiveSha256) throw new Error(`the Antigravity ACP download's SHA-256 is ${sha}; the manifest says ${asset.archiveSha256}`)
}

async function extract(archive, runtime, asset) {
  const keep = new Set([asset.binaryName, asset.harnessName])
  if (process.platform === "win32") {
    const quote = (s) => s.replace(/'/g, "''")
    await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath '${quote(archive)}' -DestinationPath '${quote(runtime)}' -Force`])
    for (const entry of fs.readdirSync(runtime)) if (!keep.has(entry)) fs.rmSync(path.join(runtime, entry), { recursive: true, force: true })
    return
  }
  try {
    await runFile("unzip", ["-o", "-q", archive, asset.binaryName, asset.harnessName, "-d", runtime])
  } catch (e) {
    if (e?.code === "ENOENT") throw new Error("unzip isn't on this machine; install it, or set AGY_ACP_BIN to an Antigravity ACP server you already have")
    throw new Error(`unzipping the Antigravity ACP server failed: ${e?.stderr || e?.message || e}`)
  }
  const names = new Set(fs.readdirSync(runtime))
  for (const name of keep) if (!names.has(name)) throw new Error(`the Antigravity ACP archive has no ${name}`)
}

// validateInstall starts the downloaded server once and takes its word for
// what it is, the way the reference provider does: protocol 1, the
// antigravity-acp agent, the version the manifest pinned.
async function validateInstall(runtime, asset, version) {
  const command = path.join(runtime, asset.binaryName)
  const conn = new AcpConnection({ command, args: launchArgs(command), cwd: runtime })
  conn.start()
  try {
    const init = await conn.initialize(2 * 60_000)
    const said = init?.agentInfo?.version
    if (init?.protocolVersion !== PROTOCOL_VERSION || init?.agentInfo?.name !== "antigravity-acp" ||
      (said !== version && said !== `agy_acp_server_${version}`)) {
      throw new Error(`the downloaded server called itself ${init?.agentInfo?.name ?? "unknown"} ${said ?? "of an unknown version"}; ${version} was expected`)
    }
  } finally {
    conn.kill()
  }
}

// ---- stale servers ---------------------------------------------------------

// A magpie killed hard leaves its ACP server running; the pid file lets the
// next start take it back. Only a process whose command line names the
// server is killed, so a recycled pid costs nothing.
// Each host process keeps its own pid file, named for it: a server belongs
// to the process that spawned it, and only a host that has died has its
// servers reaped. One shared file would have every magpie process killing
// every other's live server (a CLI command would take down the app's).
// the pid files live in the plugin's own runtime root, not the server's
// sign-in folder (~/.gemini), which is the server's to keep
const runDir = () => path.join(runtimeRoot(), "run")
const pidFile = (owner = process.pid) => path.join(runDir(), `magpie-acp-pids-${owner}.json`)
let reaped = false
async function reapStale() {
  if (reaped) return
  reaped = true
  try {
    fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 })
    for (const f of fs.readdirSync(runDir())) {
      const owner = f.match(/^magpie-acp-pids-(\d+)\.json$/)?.[1]
      if (owner !== undefined && Number(owner) !== process.pid && !alive(Number(owner))) {
        await reapFile(path.join(runDir(), f))
      }
    }
  } catch {}
}

async function reapFile(file) {
  const all = readJSON(file)
  if (Array.isArray(all)) {
    for (const e of all.slice(-8)) {
      if (!e || typeof e.pid !== "number" || e.pid === process.pid) continue
      if (await isAgyServer(e.pid)) killTree(e.pid)
    }
  }
  try { fs.rmSync(file, { force: true }) } catch {}
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function isAgyServer(pid) {
  try {
    if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("agy_acp_server")
    if (process.platform === "darwin") return (await runFile("ps", ["-p", String(pid), "-o", "args="])).includes("agy_acp_server")
    if (process.platform === "win32") {
      const out = await runFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"])
      return out.toLowerCase().includes("agy_acp_server")
    }
  } catch {}
  return false
}

function killTree(pid) {
  try {
    if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {})
    else process.kill(pid, "SIGKILL")
  } catch {}
}

function notePid(command, pid) {
  try {
    const all = (readJSON(pidFile()) ?? []).filter((e) => e && e.pid !== pid)
    all.push({ pid, at: Date.now(), command })
    fs.mkdirSync(path.dirname(pidFile()), { recursive: true, mode: 0o700 })
    fs.writeFileSync(pidFile(), JSON.stringify(all.slice(-8)))
  } catch {}
}
// ---- the ACP wire ----------------------------------------------------------

// AcpConnection is one server process, newline-delimited JSON-RPC over its
// stdio. Requests carry a deadline; a deadline, a protocol error or the
// process's death fails every request still waiting.
class AcpConnection {
  constructor({ command, args = [], cwd, env }) {
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.noise = 0
    this.dead = null
    this.nextId = 1
    this.pending = new Map()
    this.updaters = new Set()
    this.clientBridges = new Map()
    this.server = null
    this.init = null
    this.initResult = null
    this.stderrTail = ""
    this.#child = null
  }

  #child

  start() {
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.#child = child
    track(child)
    notePid(this.command, child.pid)
    // a server that can't start (ENOENT, EACCES) raises "error", and a write
    // to one that just died raises EPIPE on stdin; either left alone would
    // take the whole host down
    child.on("error", (e) => this.#fail(new Error(`the Antigravity ACP server could not be started: ${e?.message ?? e}`)))
    child.stdin?.on?.("error", () => {})
    let buffer = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      if (buffer.length > MAX_FRAME) return this.#fail(new Error("the Antigravity ACP server said more than one frame can hold"))
      let at
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        this.#line(line)
      }
    })
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_MAX)
    })
    this.dead = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        resolve({ code, signal })
        this.#fail(new Error(`the Antigravity ACP server exited (${signal ? `signal ${signal}` : `code ${code}`})${this.stderrTail.trim() ? `: ${this.stderrTail.trim().split("\n").at(-1)}` : ""}`))
      })
    })
    this.dead.catch(() => {})
  }

  #line(line) {
    const text = line.trim()
    if (!text) return
    if (!text.startsWith("{")) {
      if (BROWSER_NOISE.test(text)) { this.noise++; return }
      return this.#fail(new Error(`the Antigravity ACP server wrote a line that isn't ACP: ${text.slice(0, 200)}`))
    }
    let msg
    try { msg = JSON.parse(text) } catch {
      return this.#fail(new Error("the Antigravity ACP server wrote JSON that doesn't read"))
    }
    if (msg.method === undefined && msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(acpError(msg.error))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === undefined && msg.id === null && msg.error) {
      // an error with no request behind it (a body the server couldn't read)
      // is a broken transport, not one failed call
      return this.#fail(acpError(msg.error))
    }
    if (typeof msg.method !== "string") return
    if (msg.id !== undefined) {
      // A client MCP tool can be forwarded to the client for execution.
      // The ACP process has no permission to execute its native tools.
      Promise.resolve(this.#serve(msg))
        .then(
          (r) => (r === UNHANDLED ? this.respondError(msg.id, -32601, `${msg.method} is not supported`) : this.respond(msg.id, r)),
          (e) => this.respondError(msg.id, -32603, String(e?.message ?? e)),
        )
      return
    }
    if (msg.method === "session/update") {
      for (const up of this.updaters) { try { up(msg.params ?? {}) } catch {} }
    }
  }

  async #serve(msg) {
    if (msg.method !== "session/request_permission") return UNHANDLED
    const { sessionId, toolCall, options } = msg.params ?? {}
    const option = this.clientBridges.get(sessionId)?.permissionOption(toolCall, options)
    return { outcome: option
      ? { outcome: "selected", optionId: option.optionId }
      : { outcome: "cancelled" } }
  }

  #write(obj) {
    if (!this.#child?.stdin?.writable) throw new Error("the Antigravity ACP server isn't running")
    this.#child.stdin.write(JSON.stringify(obj) + "\n")
  }

  respond(id, result) { try { this.#write({ jsonrpc: "2.0", id, result }) } catch {} }
  respondError(id, code, message) { try { this.#write({ jsonrpc: "2.0", id, error: { code, message } }) } catch {} }

  request(method, params, timeoutMs = OP_TIMEOUT) {
    return this.call(method, params, timeoutMs).promise
  }

  // call is request with a handle to give the wait up: a prompt cancelled
  // early leaves the pending table, so its timeout can't fire later. A
  // timed-out call takes the server down only when killOnTimeout says so
  // (the default): one stuck prompt is cancelled on the server instead, so
  // it can't take down every other request riding the same process
  call(method, params, timeoutMs = OP_TIMEOUT, killOnTimeout = true) {
    if (!this.#child) throw new Error("the Antigravity ACP server was never started")
    const id = this.nextId++
    let timer
    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.pending.delete(id)
        if (killOnTimeout) this.kill()
        reject(new Error(`the Antigravity ACP server didn't answer ${method} within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
    })
    try { this.#write({ jsonrpc: "2.0", id, method, params }) } catch (e) {
      const p = this.pending.get(id)
      if (p) { clearTimeout(p.timer); this.pending.delete(id) }
      throw e
    }
    return {
      promise,
      abandon: () => {
        const p = this.pending.get(id)
        if (p) { clearTimeout(p.timer); this.pending.delete(id); p.resolve(null) }
      },
    }
  }

  notify(method, params) { try { this.#write({ jsonrpc: "2.0", method, params }) } catch {} }

  initialize(timeoutMs = INIT_TIMEOUT) {
    this.init ??= this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "opencode-antigravity-acp-auth", title: "Antigravity (ACP) for magpie", version: VERSION },
    }, timeoutMs).then(
      (r) => { this.initResult = r; return r },
      (e) => { this.init = null; this.initResult = null; throw e },
    )
    return this.init
  }

  // live is whether the server process is still with us
  get live() {
    const child = this.#child
    return !!child && child.exitCode === null && !child.killed
  }

  authenticate(params, timeoutMs = AUTH_TIMEOUT) {
    return this.request("authenticate", params, timeoutMs)
  }

  async newSession(cwd, mcpServers = [], timeoutMs = OP_TIMEOUT) {
    const out = await this.request("session/new", { cwd, mcpServers }, timeoutMs)
    if (typeof out?.sessionId !== "string" || !out.sessionId) throw new Error("the Antigravity ACP server made no session")
    return out
  }

  onSessionUpdate(fn) {
    this.updaters.add(fn)
    return () => this.updaters.delete(fn)
  }

  #fail(error) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
    // a server that spoke nonsense or died is no good to the pool: stop it,
    // so a live-looking process isn't handed out again
    this.kill()
  }

  cancel(sessionId) { this.notify("session/cancel", { sessionId }) }

  // canClose is whether the server advertised the session/close capability:
  // ACP's session/close is a request, and still unstable — an agent offers it
  // with agentCapabilities.sessionCapabilities.close, an object ({} means
  // supported; omitted or null means not), and a server without it would
  // never answer a request for it
  get canClose() {
    const close = this.initResult?.agentCapabilities?.sessionCapabilities?.close
    return close != null && typeof close === "object"
  }

  // closeSession asks the server to close a session once its request is over,
  // as a request (it is one in ACP), with a short wait and no failure anyone
  // waits on: a server that doesn't take the method or answer in time just
  // leaves the session to its own accounting
  closeSession(sessionId) {
    if (!this.canClose) return
    this.call("session/close", { sessionId }, 5_000, false).promise.catch(() => {})
  }

  kill() {
    this.init = null
    this.initResult = null
    const child = this.#child
    if (!child) return
    try { child.stdin?.end() } catch {}
    try { child.kill() } catch {}
    const flee = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 1500)
    flee.unref?.()
  }
}

const UNHANDLED = Symbol("unhandled")

function acpError(e) {
  const error = new Error(String(e?.message ?? "the Antigravity ACP server refused"))
  if (typeof e?.code === "number") error.code = e.code
  const detail = typeof e?.data?.details === "string" ? e.data.details : ""
  if (detail) error.message = `${error.message}: ${detail.slice(0, 300)}`
  return error
}

const isAuthError = (e) => e?.code === -32000 || /authentication required/i.test(String(e?.message ?? ""))

// ---- the Google sign-in the server keeps -----------------------------------

// localAuth is what can be read of the server's sign-in without asking it:
// the settings' auth kind, and an email when a token file names one. It is
// never a verdict — the server decides where its tokens live — only a hint.
function localAuth(profile) {
  const dir = authDir(profile)
  const settings = readJSON(path.join(dir, "settings.json"))
  const token = readJSON(path.join(dir, "acp_token.json"))
  const kind = typeof settings?.auth?.type === "string" ? settings.auth.type : undefined
  const email = typeof token?.email === "string" ? token.email : ""
  return { kind, email }
}

const profileUsers = new Map()

// File-backed accounts already grant email access. Use Google's public
// UserInfo endpoint and keep only the email; ACP still owns model auth.
async function profileUser(profile) {
  const local = localAuth(profile).email
  if (local || !profile || !hasProfileToken(profile)) return local
  const now = Date.now()
  const cached = profileUsers.get(profile)
  if (cached && now < cached.until) return cached.request
  const request = (async () => {
    const credential = readJSON(path.join(authDir(profile), "acp_token.json"))
    if (!credential?.scopes?.includes("https://www.googleapis.com/auth/userinfo.email")) return ""
    const parameters = new URLSearchParams({ grant_type: "refresh_token" })
    for (const field of ["client_id", "client_secret", "refresh_token"]) {
      if (typeof credential[field] !== "string" || !credential[field]) return ""
      parameters.set(field, credential[field])
    }
    try {
      const options = { redirect: "error", signal: AbortSignal.timeout(6000) }
      const token = await fetch("https://oauth2.googleapis.com/token", { ...options, method: "POST", body: parameters })
      if (!token.ok) return ""
      const { access_token: access } = await token.json()
      if (typeof access !== "string" || !access) return ""
      const user = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        ...options, headers: { Authorization: `Bearer ${access}` },
      })
      if (!user.ok) return ""
      const info = await user.json()
      return info.email_verified === true && typeof info.email === "string" ? info.email : ""
    } catch {
      return ""
    }
  })()
  const entry = { until: now + 60 * 60_000, request }
  profileUsers.set(profile, entry)
  request.then((email) => { if (!email) entry.until = now + QUOTA_TTL })
  return request
}

// configureDefaultAuth writes the settings the server reads before its first
// sign-in, as the reference provider does; a token already there wins.
function configureDefaultAuth(profile) {
  const dir = authDir(profile)
  if (isFile(path.join(dir, "acp_token.json"))) return
  const settingsPath = path.join(dir, "settings.json")
  const settings = readJSON(settingsPath)
  if (settings?.auth && typeof settings.auth === "object") return
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, auth: { type: "oauth-personal" } }, null, 2) + "\n", { mode: 0o600 })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const expired = (message) => Object.assign(new Error(message), { signIn: "expired" })

const profilePath = (id) => path.join(runtimeRoot(), "accounts", id)

function newProfile() {
  const id = randomUUID().replaceAll("-", "")
  const directory = profilePath(id)
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 })
  fs.mkdirSync(directory, { mode: 0o700 })
  return { id, directory }
}

// A profile marker is a local reference, never a credential. If copied to
// another machine, it must not silently pick up that machine's default login.
function accountScope(auth) {
  if (auth?.type === "api") return `api:${createHash("sha256").update(auth.key).digest("hex")}`
  const marker = auth?.refresh
  if (typeof marker !== "string" || !marker.startsWith(PROFILE_MARKER)) return "oauth"
  const id = marker.slice(PROFILE_MARKER.length)
  if (!PROFILE_ID.test(id)) throw expired("Invalid Antigravity ACP profile; add this Google account again")
  return id
}

function hasProfileToken(profile) {
  try {
    for (const dir of [profile, path.dirname(authDir(profile)), authDir(profile)]) {
      if (!fs.lstatSync(dir).isDirectory()) return false
    }
    const file = fs.lstatSync(path.join(authDir(profile), "acp_token.json"))
    return file.isFile() && file.size > 0 && (process.platform === "win32" || !(file.mode & 0o077))
  } catch {
    return false
  }
}

const PROFILE_ENV = [
  "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR",
]

function profileEnv(profile) {
  const env = {}
  for (const name of PROFILE_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return {
    ...env,
    HOME: profile,
    ...(process.platform === "win32" ? { USERPROFILE: profile, APPDATA: path.join(profile, "appdata"), LOCALAPPDATA: path.join(profile, "localappdata") } : {}),
    GEMINI_HOME: path.join(profile, ".gemini"),
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    XDG_CONFIG_HOME: path.join(profile, "config"),
    XDG_DATA_HOME: path.join(profile, "data"),
    XDG_STATE_HOME: path.join(profile, "state"),
    XDG_CACHE_HOME: path.join(profile, "cache"),
  }
}

// ---- the managed runtime's pooled connections ------------------------------

const pools = new Map() // account scope → {conn, ready}

// workDir is the folder the server process runs in and every session is
// given as its cwd — a folder of the plugin's own under the managed runtime,
// never magpie's config folder (the one that holds auth.json with every
// plugin account's tokens): an agent's read tools list and read their cwd
// without asking, and the server writes its workspace files here too.
const workDir = (profile) => {
  const dir = profile
    ? path.join(runtimeRoot(), "workspaces", path.basename(profile))
    : path.join(runtimeRoot(), "workspace")
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch {}
  return dir
}

// Each saved account gets its own process. The runtime owns Google OAuth;
// API-key accounts authenticate explicitly on their own connections.
async function connectionFor(auth) {
  const scope = accountScope(auth)
  const profile = PROFILE_ID.test(scope) ? profilePath(scope) : null
  if (profile && !hasProfileToken(profile)) {
    throw expired("The local Antigravity ACP sign-in is missing or unreadable; add this Google account again")
  }
  const have = pools.get(scope)
  // a server still starting is shared by every request that arrives meanwhile,
  // so concurrent first requests don't each start (and leak) their own
  if (have && (!have.conn || have.conn.live)) return have.ready
  have?.conn?.kill()
  const entry = { conn: null, ready: null }
  entry.ready = (async () => {
    await reapStale()
    const launch = await ensureRuntime()
    const cwd = workDir(profile)
    const conn = new AcpConnection({ command: launch.command, args: launch.args, cwd, env: profile ? profileEnv(profile) : undefined })
    conn.start()
    entry.conn = conn
    try {
      const init = await conn.initialize()
      if (auth?.type === "api") {
        const method = (init?.authMethods ?? []).find((m) => {
          const meta = m?._meta ?? null
          return (meta && "api-key" in meta) || /api key/i.test(String(m?.name ?? ""))
        })
        if (!method) throw new Error("this Antigravity ACP server offers no Gemini API-key sign-in")
        await conn.authenticate({ methodId: method.id, _meta: { "api-key": auth.key } }, 60_000)
      }
    } catch (e) {
      conn.kill()
      throw e
    }
    return conn
  })()
  entry.ready.then(
    (conn) => conn.dead.then(() => { if (pools.get(scope) === entry) pools.delete(scope) }),
    () => { if (pools.get(scope) === entry) pools.delete(scope) },
  )
  pools.set(scope, entry)
  return entry.ready
}

// ---- OAuth relay for hosts without a browser -------------------------------

// The server opens the OAuth page in a browser itself and never says the URL.
// Where no browser can open (SSH, a headless Linux), the browser command is
// replaced with a capture helper: the URL comes here, magpie shows it, and
// the final localhost URL the user pastes is relayed to the server's own
// loopback listener.
const shouldUseRelay = () => {
  const mode = process.env.AGY_ACP_OAUTH_MODE?.trim().toLowerCase()
  if (mode === "manual") return true
  if (mode === "browser") return false
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) return true
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

class OAuthRelay {
  constructor(env) {
    if (process.platform === "win32") throw new Error("the manual OAuth relay isn't on Windows yet; sign in where a browser can open")
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-oauth-"))
    fs.chmodSync(this.dir, 0o700)
    this.capture = path.join(this.dir, "authorization-url")
    const helper = (name) => {
      const p = path.join(this.dir, name)
      // the capture file's path reaches the script through the environment,
      // never through a quoted string: a TMPDIR with a quote in it must not
      // break the script, let alone run its contents
      fs.writeFileSync(p, `#!/bin/sh\numask 077\nprintf '%s\\n' "$1" > "$AGY_ACP_CAPTURE"\n`, { mode: 0o700 })
      return p
    }
    const browser = helper("capture-browser")
    this.env = {
      ...env,
      BROWSER: browser,
      AGY_ACP_CAPTURE: this.capture,
      PATH: `${this.dir}${path.delimiter}${env.PATH ?? ""}`,
    }
  }

  async waitUrl(signal, timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs
    for (;;) {
      if (signal?.aborted) throw new Error("the sign-in was cancelled")
      const text = (() => { try { return fs.readFileSync(this.capture, "utf8").trim() } catch { return "" } })()
      if (text) return this.#parse(text)
      if (Date.now() > end) throw new Error(`Antigravity offered no OAuth URL within ${Math.round(timeoutMs / 1000)} seconds`)
      await sleep(200)
    }
  }

  #parse(text) {
    let url
    try { url = new URL(text) } catch { throw new Error("Antigravity gave an OAuth URL that doesn't read") }
    if (url.protocol !== "https:" || url.hostname !== "accounts.google.com") throw new Error(`Antigravity gave an unexpected OAuth URL (${url.hostname})`)
    const redirect = url.searchParams.get("redirect_uri")
    const state = url.searchParams.get("state")
    if (!redirect || !state) throw new Error("Antigravity's OAuth URL is missing its redirect or state")
    return { url: url.toString(), redirect: new URL(redirect), state }
  }

  // forward hands the pasted callback URL (or bare code) to the server's own
  // loopback listener, which finishes the exchange.
  async forward(input, authorization) {
    let callback
    const value = String(input ?? "").trim()
    if (!value) throw new Error("paste the final localhost URL, or the code in it")
    if (/^https?:\/\//i.test(value)) {
      callback = new URL(value)
    } else {
      callback = new URL(authorization.redirect)
      const params = value.includes("=") ? new URLSearchParams(value.replace(/^\?/, "")) : undefined
      callback.searchParams.set("code", params?.get("code") ?? value)
      callback.searchParams.set("state", params?.get("state") ?? authorization.state)
    }
    if (callback.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname) || !callback.port) {
      throw new Error("the pasted URL isn't the localhost callback the sign-in expects")
    }
    if (callback.origin !== authorization.redirect.origin || callback.pathname !== authorization.redirect.pathname) {
      throw new Error("the pasted URL doesn't match this sign-in's callback")
    }
    if (callback.searchParams.get("state") !== authorization.state) throw new Error("the pasted URL is for another sign-in")
    if (!callback.searchParams.get("code") && !callback.searchParams.get("error")) throw new Error("the pasted URL carries no code")
    const res = await fetch(callback, { redirect: "manual", signal: AbortSignal.timeout(30_000) })
    await res.body?.cancel().catch(() => {})
    if (res.status >= 400) throw new Error(`the Antigravity OAuth callback said HTTP ${res.status}`)
  }

  dispose() { try { fs.rmSync(this.dir, { recursive: true, force: true }) } catch {} }
}

// ---- signing in ------------------------------------------------------------

// googleSignIn runs the server's own Google sign-in: in a browser where one
// can open, else through the relay (show the URL, paste the callback back).
async function addGoogleAccount(_inputs, { signal } = {}) {
  const launch = await ensureRuntime()
  signal?.throwIfAborted()
  const profile = newProfile()
  const directory = profile.directory
  const cwd = workDir(directory)
  const env = profileEnv(directory)
  const relayWait = new AbortController()
  let conn, relay, timer, kept = false, cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    clearTimeout(timer)
    signal?.removeEventListener("abort", cleanup)
    relayWait.abort()
    try { conn?.kill() } catch {}
    relay?.dispose()
    if (!kept) {
      const remove = () => {
        for (const dir of [directory, cwd]) {
          try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
        }
      }
      if (conn?.dead) conn.dead.then(remove)
      else remove()
    }
  }
  const finish = async (callbackSignal) => {
    signal?.throwIfAborted()
    callbackSignal?.throwIfAborted()
    const result = await done(conn, cwd, profile)
    signal?.throwIfAborted()
    callbackSignal?.throwIfAborted()
    kept = result.type === "success"
    return result
  }
  try {
    configureDefaultAuth(directory)
    relay = shouldUseRelay() ? new OAuthRelay(env) : null
    conn = new AcpConnection({ command: launch.command, args: launch.args, cwd, env: relay?.env ?? env })
    conn.start()
    signal?.addEventListener("abort", cleanup, { once: true })
    signal?.throwIfAborted()
    timer = setTimeout(cleanup, AUTH_RELAY_TIMEOUT + 5 * 60_000)
    timer.unref?.()
    const init = await conn.initialize()
    const method = (init?.authMethods ?? []).find((m) => /log\s*in\s+with\s+google|google\s+account|oauth-personal/i.test(`${m?.id ?? ""} ${m?.name ?? ""}`))
    if (!method) throw new Error("this Antigravity ACP server offers no Google sign-in")
    const authentication = conn.authenticate({ methodId: method.id }, relay ? AUTH_RELAY_TIMEOUT : AUTH_TIMEOUT)
    authentication.catch(() => {})
    if (relay) {
      const authorization = await Promise.race([
        relay.waitUrl(relayWait.signal, AUTH_RELAY_TIMEOUT),
        authentication.then(() => ({ reused: true }), () => Promise.reject(new Error("the Google sign-in failed before its page opened"))),
      ])
      if (authorization.reused) {
        try {
          const result = await finish()
          if (result.type !== "success") throw new Error(result.error)
          return { url: "", instructions: "", method: "auto", callback: async () => result }
        } finally { cleanup() }
      }
      return {
        url: authorization.url,
        instructions: "Open this URL in a browser (anywhere you like) and finish the Google sign-in. Google then lands on a localhost page that may fail to load — that is fine. Paste the complete final URL from the address bar here.",
        method: "code",
        callback: async (code, { signal: callbackSignal } = {}) => {
          callbackSignal?.addEventListener("abort", cleanup, { once: true })
          try {
            callbackSignal?.throwIfAborted()
            await relay.forward(code, authorization)
            await authentication
            return await finish(callbackSignal)
          } finally {
            callbackSignal?.removeEventListener("abort", cleanup)
            cleanup()
          }
        },
      }
    }
    return {
      url: "",
      instructions: "Choose the Google account you want to add in the browser window that Antigravity opened.",
      method: "auto",
      callback: async (_code, { signal: callbackSignal } = {}) => {
        callbackSignal?.addEventListener("abort", cleanup, { once: true })
        try {
          callbackSignal?.throwIfAborted()
          await authentication
          return await finish(callbackSignal)
        } finally {
          callbackSignal?.removeEventListener("abort", cleanup)
          cleanup()
        }
      },
    }
  } catch (e) {
    // a failure is the host's to show: authorize throws, the sign-in RPC
    // errors, and magpie says why (a made-up return value would only break
    // the contract)
    cleanup()
    throw e
  }
}

// Magpie stores the local marker as its OAuth record, so each profile can
// be selected independently. The provider never copies the Google token.
function saved(profile) {
  const marker = profile ? PROFILE_MARKER + profile.id : MANAGED
  const email = localAuth(profile?.directory).email
  const accountId = profile ? `${email || "Google ACP"} · ${profile.id.slice(-8)}` : email
  return {
    type: "success", refresh: marker, access: marker,
    expires: Date.now() + 10 * 365 * 24 * 3600 * 1000,
    ...(accountId ? { accountId } : {}),
  }
}

// signedIn proves the server really has a credential by asking it for one
// word: a session is made signed-out too, but only a credential gets a
// prompt through. The server answers an existing sign-in at once; without
// one it drives the browser itself.
async function signedIn(conn, cwd) {
  const session = await conn.newSession(cwd, [], 60_000)
  try {
    const r = await conn.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Reply with exactly: OK" }] }, 90_000)
    if (r?.stopReason !== "end_turn" && r?.stopReason !== "cancelled") throw new Error("the server did not answer the probe")
  } finally {
    conn.cancel(session.sessionId)
    conn.closeSession(session.sessionId)
  }
}

// done checks the sign-in took and saves the marker.
async function done(conn, cwd, profile) {
  if (profile && !hasProfileToken(profile.directory)) {
    return { type: "failed", error: "Antigravity did not save this Google sign-in in its isolated profile" }
  }
  try {
    await signedIn(conn, cwd)
  } catch (e) {
    return { type: "failed", error: isAuthError(e) ? "the sign-in didn't take: Antigravity still asks for authentication" : String(e?.message ?? e) }
  }
  const result = saved(profile)
  if (profile) {
    const email = await profileUser(profile.directory)
    if (email) result.accountId = `${email} · ${profile.id.slice(-8)}`
  }
  return result
}

// currentSignIn takes the Google sign-in the server already has (an install
// with the Antigravity IDE signed in usually has one): the probe settles it.
async function currentSignIn() {
  const launch = await ensureRuntime()
  const cwd = workDir()
  const conn = new AcpConnection({ command: launch.command, args: launch.args, cwd })
  conn.start()
  try {
    await conn.initialize()
    try {
      await signedIn(conn, cwd)
    } catch {
      throw new Error("Antigravity has no Google sign-in on this machine yet; sign in with the browser one first")
    }
  } catch (e) {
    if (e?.message?.includes("no Google sign-in")) throw e
    throw new Error("the Antigravity ACP server could not be started: " + String(e?.message ?? e))
  } finally { conn.kill() }
  return {
    url: "",
    instructions: localAuth().email ? `Using Antigravity's Google sign-in as ${localAuth().email}.` : "Using Antigravity's Google sign-in.",
    method: "auto",
    callback: async () => saved(),
  }
}

// ---- models ----------------------------------------------------------------

const FALLBACK_MODELS = {
  "gemini-3.8-flash": family("Gemini 3.8 Flash", ["low", "medium", "high"]),
  "gemini-3.7-flash": family("Gemini 3.7 Flash", ["low", "medium", "high"]),
  "gemini-3.6-flash": family("Gemini 3.6 Flash", ["low", "medium", "high"]),
  "gemini-3.1-pro": family("Gemini 3.1 Pro", ["low", "high"]),
}

function family(name, efforts) {
  return {
    name,
    reasoning: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 65_536 },
    variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])),
  }
}

// sessionModels reads a session's model list, from the config option named
// "model" or the older models field.
function sessionModels(state) {
  const selector = (state?.configOptions ?? []).find((o) => o?.type === "select" && (o.category === "model" || o.id === "model"))
  if (selector) {
    const values = (selector.options ?? []).flatMap((entry) => (Array.isArray(entry?.options) ? entry.options : [entry]))
    return values.filter((v) => typeof v?.value === "string").map((v) => ({ modelId: v.value, name: typeof v.name === "string" ? v.name : v.value }))
  }
  return (state?.models?.availableModels ?? []).filter((m) => typeof m?.modelId === "string")
}

const thinkingSelector = (state) => (state?.configOptions ?? []).find((option) =>
  option?.type === "select" && (option.id === "thinking_level" || option.category === "thought_level"),
)

function sessionCatalog(state) {
  const options = (thinkingSelector(state)?.options ?? []).flatMap((entry) => entry?.options ?? [entry])
  const efforts = options.map((entry) => entry?.value).filter((value) => typeof value === "string")
  return projectModels(sessionModels(state)).map((model) => (
    model.efforts.length || !model.id.startsWith("gemini-") ? model : { ...model, efforts }
  ))
}

// projectModels folds Antigravity's effort-qualified ids into one entry per
// family (gemini-3.8-flash-low/-medium/-high is "gemini-3.8-flash", with the
// levels it has as variants). An id whose name or id says no level, and a
// family of one, stay a model of their own.
function projectModels(raw) {
  const effortOf = (id, name) => {
    let m = String(name ?? "").match(/^(.+?)\s*\((low|medium|high)\)$/i)
    if (m) return { base: m[1].trim(), effort: m[2].toLowerCase() }
    m = String(id).match(/^(.+)-(low|medium|high)$/)
    if (m) return { base: m[1], effort: m[2] }
    return null
  }
  const groups = new Map()
  for (const m of raw) {
    const parsed = effortOf(m.modelId.trim(), m.name)
    if (!parsed || !m.modelId.trim().startsWith("gemini-")) continue
    const key = parsed.base.toLowerCase()
    const group = groups.get(key) ?? { name: parsed.base, members: [] }
    group.members.push({ ...m, effort: parsed.effort, base: parsed.base })
    groups.set(key, group)
  }
  const seen = new Set()
  const out = []
  for (const m of raw) {
    const id = m.modelId.trim()
    if (seen.has(id)) continue
    const parsed = effortOf(id, m.name)
    const group = parsed ? groups.get(parsed.base.toLowerCase()) : undefined
    if (group && group.members.length >= 2) {
      if (seen.has(group.name.toLowerCase())) continue
      seen.add(group.name.toLowerCase())
      for (const member of group.members) seen.add(member.modelId.trim())
      const byEffort = {}
      for (const member of group.members) byEffort[member.effort] ??= member.modelId.trim()
      const bases = group.members.map((x) => x.modelId.trim().replace(/-(low|medium|high)$/, ""))
      const id2 = bases.length && bases.every((b) => b === bases[0]) ? bases[0] : group.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "")
      // the plain id only when the family really has an unqualified member:
      // a family of qualified ids alone (the usual rollout) has none, and a
      // request without an effort takes the highest tier instead
      const plainMember = group.members.find((x) => !/-(low|medium|high)$/.test(x.modelId.trim()))
      out.push({
        id: id2,
        name: group.name,
        efforts: Object.keys(byEffort),
        byEffort,
        plain: plainMember ? plainMember.modelId.trim() : "",
      })
      continue
    }
    seen.add(id)
    out.push({ id, name: String(m.name ?? "").trim() || id, efforts: [], byEffort: {}, plain: id })
  }
  return out
}

// Resolve variants from the session that will actually serve the request.
// Two accounts can be on different model rollouts.
function resolveServerId(model, effort, models) {
  const fam = models.find((m) => m.id === model) ?? fallbackFamilies.get(model)
  const pick = (...levels) => { for (const l of levels) if (fam?.byEffort[l]) return fam.byEffort[l]; return "" }
  if (fam) {
    if (!effort || effort === "none") return fam.plain || pick("high", "medium", "low") || model
    if (effort === "minimal") return fam.plain || pick("low", "medium", "high") || model
    if (effort === "xhigh" || effort === "max") return pick("high", "medium", "low") || model
    if (effort === "low") return pick("low", "medium", "high") || model
    if (effort === "medium") return pick("medium", "high", "low") || model
    return pick("high", "medium", "low") || model
  }
  const guess = effort === "minimal" || effort === "none" ? "low" : effort === "xhigh" || effort === "max" ? "high" : effort
  return guess && ["low", "medium", "high"].includes(guess) ? `${model}-${guess}` : model
}

const fallbackFamilies = new Map()

// the fallbacks are indexed the way a discovery would: a request naming one
// resolves to the server's effort-qualified id even before (or without) a
// models listing, and without an effort asked, at the highest tier there is
for (const [id, m] of Object.entries(FALLBACK_MODELS)) {
  fallbackFamilies.set(id, {
    byEffort: Object.fromEntries(Object.keys(m.variants).map((e) => [e, `${id}-${e}`])),
    plain: "",
  })
}

async function discoverModels(auth) {
  const conn = await connectionFor(auth)
  const session = await conn.newSession(conn.cwd, [])
  try { return sessionCatalog(session) } finally { conn.closeSession(session.sessionId) }
}

function magpieModel(provider, m) {
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name,
    api: { id: m.id, url: API_BASE, npm: "@ai-sdk/openai-compatible" },
    limit: { context: 1_000_000, output: 65_536 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    variants: Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: e }])),
  }
}

// ---- the MCP bridge --------------------------------------------------------

// Bridge serves the request's tools to the agent as one MCP server on
// loopback. A call there is the model asking for a client tool: the call is
// handed to the turn (it becomes tool_calls), and the bridge answers that it
// was delivered, since the client's result comes with the user's next message.
const BRIDGE_NAME = "magpie"

class Bridge {
  constructor(tools) {
    this.token = randomUUID().replaceAll("-", "")
    this.tools = tools.slice(0, MAX_TOOLS).map((t, i) => {
      const fn = t?.type === "function" ? t.function ?? {} : t ?? {}
      const raw = typeof fn.name === "string" ? fn.name : `tool-${i}`
      const name = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || `tool-${i}`
      let schema = fn.parameters
      if (schema === undefined || schema === null || typeof schema !== "object" || Array.isArray(schema)) schema = { type: "object", properties: {} }
      return { mcp: name, name: raw, description: typeof fn.description === "string" ? fn.description.slice(0, 4000) : "", schema }
    })
    this.onCall = null
    this.server = null
    this.url = ""
  }

  get empty() { return this.tools.length === 0 }

  start() {
    if (this.empty) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // #handle is async: a rejection left alone would be unhandled
        Promise.resolve(this.#handle(req, res)).catch(() => {
          try {
            if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "bridge error" } }))
          } catch {}
        })
      })
      server.on("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address()
        this.url = `http://127.0.0.1:${port}/mcp`
        resolve()
      })
      this.server = server
    })
  }

  descriptor() {
    if (this.empty) return null
    return { type: "http", name: BRIDGE_NAME, url: this.url, headers: [{ name: "Authorization", value: `Bearer ${this.token}` }] }
  }

  permissionOption(toolCall, options) {
    // The official runtime sends structured MCP provenance. The text title
    // and raw arguments cannot grant access to a native or unrelated tool.
    const meta = toolCall?._meta
    if (!this.onCall || meta?.is_mcp_tool_call !== true || meta.mcp?.server !== BRIDGE_NAME ||
      !this.tools.some((entry) => entry.mcp === meta.mcp.tool) || !Array.isArray(options)) return undefined
    return options.find((option) => option?.kind === "allow_once" &&
      typeof option.optionId === "string" && option.optionId)
  }

  async #handle(req, res) {
    if (req.method !== "POST" || req.url !== "/mcp") return res.writeHead(405).end()
    if ((req.headers.authorization ?? "") !== `Bearer ${this.token}`) return res.writeHead(401).end()
    let body = ""
    for await (const chunk of req) {
      body += chunk
      if (body.length > (1 << 20)) return res.writeHead(413).end()
    }
    let messages
    try { messages = JSON.parse(body) } catch { return res.writeHead(400).end() }
    const batch = Array.isArray(messages)
    const replies = []
    for (const msg of batch ? messages : [messages]) {
      const reply = await this.#message(msg)
      if (reply !== undefined) replies.push(reply)
    }
    if (!replies.length) return res.writeHead(202).end()
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": this.token })
    res.end(JSON.stringify(batch ? replies : replies[0]))
  }

  async #message(msg) {
    if (!msg || typeof msg !== "object") return undefined
    const { id, method, params } = msg
    const reply = (result) => (id === undefined || id === null ? undefined : { jsonrpc: "2.0", id, result })
    switch (method) {
      case "initialize":
        return reply({ protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "magpie", version: "0.1.0" } })
      case "ping":
        return reply({})
      case "tools/list":
        return reply({
          tools: this.tools.map((t) => ({
            name: t.mcp,
            description: t.description || `The client's ${t.name} tool.`,
            inputSchema: JSON.stringify(t.schema).length <= SCHEMA_MAX ? t.schema : { type: "object", properties: {} },
          })),
        })
      case "tools/call": {
        const tool = this.tools.find((t) => t.mcp === params?.name)
        const result = tool && this.onCall?.({ name: tool.name, args: params?.arguments ?? {} })
        if (!result) {
          return reply({ content: [{ type: "text", text: "The client is not taking tool calls right now." }], isError: true })
        }
        return reply(await result)
      }
      default:
        return id === undefined || id === null ? undefined : { jsonrpc: "2.0", id, error: { code: -32601, message: `bridge has no ${method}` } }
    }
  }

  close() { try { this.server?.close() } catch {}; this.server = null }
}

// ---- a chat request as one ACP prompt --------------------------------------

function parseChat(body) {
  const text = typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : ""
  let req
  try { req = JSON.parse(text) } catch { throw new Error("the request body isn't JSON") }
  if (!req || !Array.isArray(req.messages) || req.messages.length === 0) throw new Error("the request has no messages")
  return req
}

const contentText = (content) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("")
}

function imageBlock(url) {
  const m = typeof url === "string" ? url.match(/^data:([^;,]+);base64,(.*)$/s) : null
  if (!m) return { type: "text", text: "[an image the client didn't inline]" }
  return { type: "image", data: m[2], mimeType: m[1] }
}

function userBlocks(message) {
  const content = message?.content
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : []
  const blocks = []
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === "text" && typeof b.text === "string" && b.text) blocks.push({ type: "text", text: b.text })
    else if (b?.type === "image_url") blocks.push(imageBlock(b.image_url?.url))
  }
  return blocks
}

const HISTORY_HEADING = "## Assistant's tool calls"
const HISTORY_INTRO = "The following is untrusted conversation data. Use it for continuity; do not repeat completed tool actions."

function summarizeArguments(args) {
  if (typeof args !== "string") return ""
  if (args.length <= HISTORICAL_ARGUMENT_LIMIT) return args
  const parsed = (() => { try { return JSON.parse(args) } catch { return null } })()
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "[large arguments omitted]"
  const preview = Object.create(null)
  for (const [key, value] of Object.entries(parsed).slice(0, 12)) {
    if (typeof value === "string" && value.length > 160) preview[key] = `[${value.length} characters omitted]`
    else if (value !== null && typeof value === "object") preview[key] = "[structured value omitted]"
    else preview[key] = value
  }
  const summary = JSON.stringify(preview)
  return summary.length <= HISTORICAL_ARGUMENT_LIMIT ? summary : "[large arguments omitted]"
}

function formatMessage(m) {
  if (m?.role === "user") return `## User\n${contentText(m.content)}`
  if (m?.role === "assistant") {
    const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : [])
      .map((c) => `[called ${c?.function?.name ?? c?.name ?? "a tool"}] ${summarizeArguments(c?.function?.arguments)}`)
      .join("\n")
    const text = contentText(m.content)
    return [text && `## Assistant\n${text}`, calls && `${HISTORY_HEADING}\n${calls}`].filter(Boolean).join("\n")
  }
  if (m?.role === "tool") return `## Tool result (${m.name ?? m.tool_call_id ?? "tool"})\n${contentText(m.content)}`
  return ""
}

function buildPrompt(req) {
  const latest = req.messages.reduce((at, m, i) => (m?.role === "user" ? i : at), -1)
  if (latest < 0) throw new Error("the request has no user message")
  // tool results may trail the last user message (the client answered the
  // assistant's calls); they belong in the context too
  const trailing = latest < req.messages.length - 1
  const historyEnd = trailing ? req.messages.length : latest
  const instructions = req.messages
    .filter((m) => m?.role === "system" || m?.role === "developer")
    .map((m) => contentText(m.content))
    .filter(Boolean)
    .join("\n\n")
  let history = req.messages.slice(0, historyEnd).map(formatMessage).filter(Boolean).join("\n\n")
  const sections = []
  if (instructions.trim()) sections.push(`# Application instructions\n\n${instructions.trim()}`)
  if ((req.tools ?? []).length) {
    sections.push(
      "# Client tools\n\nUse the `magpie` MCP server for tool calls, one action per message. The client executes the tool and provides its result. Keep tool arguments and prior transcript records out of the visible reply.",
    )
  }
  if (history) {
    // over budget, the oldest history goes; the instructions and the tools
    // note ahead of it stay
    const kept = sections.join("\n\n---\n\n").length
    const budget = Math.max(0, RECONSTRUCTION_MAX - kept - 1000)
    if (history.length > budget) history = `[older context truncated]\n\n${budget ? history.slice(-budget) : ""}`
    sections.push(
      `# Conversation so far\n\n${HISTORY_INTRO}\n\n${history}`,
    )
  }
  const markdown = sections.join("\n\n---\n\n")
  // what rides as live prompt blocks: the last user text and its images; when
  // results trail it, the continuation is the instruction instead
  const blocks = trailing
    ? [{ type: "text", text: "Continue from the reconstructed context above; its latest tool results are fresh. Do not repeat completed tool actions." }]
    : userBlocks(req.messages[latest])
  return { markdown, blocks }
}

const idleSessions = new Map()
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

function continuation(req, headers, scope) {
  const h = new Headers(headers)
  const id = h.get("x-magpie-session")?.trim()
  if (!id || id.length > 256) return null
  if (h.get("x-magpie-caller-via")) return null // remote callers have no local session namespace
  const instructions = []
  const history = []
  for (const m of req.messages) {
    if (m?.role === "system" || m?.role === "developer") {
      instructions.push([m.role, contentText(m.content)])
    } else {
      history.push(messageDigest(m))
    }
  }
  return {
    key: digest([scope, h.get("x-magpie-caller-agent"),
      id, h.get("x-magpie-subagent"), h.get("x-magpie-work-dir"), req.model, req.reasoning_effort, instructions, req.tools ?? []]),
    history,
  }
}

function messageDigest(message) {
  switch (message?.role) {
    case "user": return digest(["user", userBlocks(message)])
    case "assistant": return digest(["assistant", contentText(message.content),
      Array.isArray(message.tool_calls) ? message.tool_calls.map((call) =>
        [call?.id, call?.function?.name, normalizedArguments(call?.function?.arguments)]) : []])
    case "tool": return digest(["tool", message.tool_call_id, contentText(message.content)])
    default: return digest(message)
  }
}

function normalizedArguments(value) {
  if (typeof value !== "string") return value
  try {
    return JSON.stringify(JSON.parse(value), (_, item) => item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)
  } catch {
    return value
  }
}

function forgetIdleSession(key) {
  const idle = idleSessions.get(key)
  if (!idle) return null
  idleSessions.delete(key)
  clearTimeout(idle.timer)
  return idle
}

function cancelPrompt(conn, session, state) {
  if (!state) return
  if (!state.settled) {
    conn.cancel(session.sessionId)
    state.prompt.abandon()
  }
  for (const resolve of state.results.values()) {
    resolve({ content: [{ type: "text", text: "The client tool turn was closed." }], isError: true })
  }
  state.results.clear()
}

function disposeSession({ conn, session, bridge, parked }) {
  cancelPrompt(conn, session, parked)
  conn.closeSession(session.sessionId)
  bridge.close()
}

// Session-reuse diagnostics: one line per decision (roles, counts and the
// first mismatching index only; never message content). Off unless
// AGY_ACP_REUSE_LOG names a file or <runtime root>/reuse.log already exists.
function reuseLog(event) {
  const file = process.env.AGY_ACP_REUSE_LOG || path.join(runtimeRoot(), "reuse.log")
  if (!process.env.AGY_ACP_REUSE_LOG && !fs.existsSync(file)) return
  try { fs.appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n") } catch {}
}

// Claude Code forks the main conversation for side queries (away recap,
// prompt suggestion, /btw): same instructions and tools, the main history plus
// one fixed-prompt user message, and the answer never joins the main history.
const SIDE_QUERY_MARKERS = [
  "The user stepped away and is coming back. Recap in under",
  "[SUGGESTION MODE: Suggest what the user might naturally type next",
  "This is a side question from the user. You must answer this question directly",
]

function isSideQuery(message) {
  if (message?.role !== "user") return false
  const text = contentText(message.content).slice(0, 4000)
  return SIDE_QUERY_MARKERS.some((marker) => text.includes(marker))
}

function takeSession(client, conn, req, side = false) {
  if (!client) return null
  const peek = idleSessions.get(client.key)
  if (side && peek && (peek.parked || peek.conn !== conn ||
    !peek.history.every((message, i) => client.history[i] === message) ||
    client.history.length !== peek.history.length + 1)) {
    // a side query never disturbs a main turn it can't cleanly continue
    reuseLog({ take: "side-bypass", key: client.key.slice(0, 12), parked: Boolean(peek.parked) })
    return null
  }
  const idle = forgetIdleSession(client.key)
  if (!idle) {
    reuseLog({ take: "no-idle", key: client.key.slice(0, 12), idleKeys: [...idleSessions.keys()].map((k) => k.slice(0, 12)), n: client.history.length })
    return null
  }
  const mismatch = idle.history.findIndex((message, i) => client.history[i] !== message)
  const added = req.messages.filter((m) => m?.role !== "system" && m?.role !== "developer").slice(idle.history.length)
  if (idle.conn === conn && conn.live && mismatch < 0) {
    if (!idle.parked && added.length === 1 && added[0]?.role === "user") {
      reuseLog({ take: side ? "resume-side" : "resume", key: client.key.slice(0, 12), n: client.history.length })
      return idle
    }
    // Tool results may be followed by the user text of the same client turn
    // (Claude Code attaches system reminders, or a message typed while the
    // tool ran); it rides along with the last result.
    const size = idle.parked?.results.size ?? 0
    const results = added.slice(0, size)
    const extra = added.slice(size)
    if (idle.parked && !idle.parked.settled && size && results.length === size &&
      new Set(results.map((m) => m?.tool_call_id)).size === size &&
      results.every((m) => m?.role === "tool" && idle.parked.results.has(m.tool_call_id)) &&
      extra.every((m) => m?.role === "user")) {
      reuseLog({ take: "resume-parked", key: client.key.slice(0, 12), n: client.history.length, extra: extra.length })
      return { ...idle, added: results, extra }
    }
  }
  reuseLog({ take: "dispose", key: client.key.slice(0, 12), sameConn: idle.conn === conn, live: conn.live, mismatch,
    idleN: idle.history.length, n: client.history.length, parked: Boolean(idle.parked), settled: idle.parked?.settled,
    pending: idle.parked ? [...idle.parked.results.keys()] : undefined,
    added: added.map((m) => [m?.role, m?.tool_call_id, Array.isArray(m?.tool_calls) ? m.tool_calls.length : undefined]) })
  disposeSession(idle)
  return null
}

function keepSession(client, state, turn, mainHistory = null) {
  const discard = (key) => {
    const old = forgetIdleSession(key)
    if (old) disposeSession(old)
  }
  discard(client.key)
  if (idleSessions.size >= MAX_IDLE_SESSIONS) discard(idleSessions.keys().next().value)
  state.bridge.onCall = null
  const assistant = { role: "assistant", content: turn.text,
    tool_calls: turn.calls.map((call) => ({ id: call.id, function: { name: call.name, arguments: call.args } })) }
  const history = mainHistory ?? [...client.history, messageDigest(assistant)]
  const timer = setTimeout(() => discard(client.key), state.parked ? PARKED_SESSION_TIMEOUT : IDLE_SESSION_TIMEOUT)
  timer.unref?.()
  idleSessions.set(client.key, { ...state, history, timer })
  reuseLog({ keep: state.parked ? "parked" : "idle", key: client.key.slice(0, 12), n: history.length, calls: turn.calls.map((c) => c.id) })
}

const HISTORY_ECHO_MARKERS = [
  `${HISTORY_HEADING}\n[called `,
  `${HISTORY_HEADING}\r\n[called `,
  HISTORY_INTRO,
]
const MAX_ECHO_PREFIX = Math.max(...HISTORY_ECHO_MARKERS.map((marker) => marker.length - 1))

class HistoryEchoFilter {
  pending = ""
  repeated = false

  write(chunk) {
    if (this.repeated) return ""
    const text = this.pending + chunk
    let start = text.length
    for (const marker of HISTORY_ECHO_MARKERS) {
      const at = text.indexOf(marker)
      if (at !== -1) start = Math.min(start, at)
    }
    if (start < text.length) {
      this.repeated = true
      this.pending = ""
      return text.slice(0, start)
    }
    // The renderer can split the heading across messages. Hold only a
    // suffix that can still become a transcript marker.
    let tail = Math.min(text.length, MAX_ECHO_PREFIX)
    while (tail && !HISTORY_ECHO_MARKERS.some((marker) => marker.startsWith(text.slice(-tail)))) tail--
    this.pending = tail ? text.slice(-tail) : ""
    return text.slice(0, text.length - tail)
  }

  flush() {
    const text = this.pending
    this.pending = ""
    return text
  }
}

// A turn ends when ACP replies, calls a client tool, or is cancelled.
class Turn {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.text = ""
    this.thought = ""
    this.historyEcho = new HistoryEchoFilter()
    this.calls = []
    this.quota = null
    this.canContinue = false
    this.stop = null
    this.error = null
    this.ending = false
    this.#settle = null
    this.#say = null
    this.ended = new Promise((r) => (this.#settle = r))
    // firstSaid resolves once the turn has said anything (or ended), so the
    // reply can decide between starting to stream and failing the request
    this.firstSaid = new Promise((r) => (this.#say = r))
    this.onEvent = null
  }

  #settle
  #say

  #saidSomething() {
    if (this.#say && this.said) { const s = this.#say; this.#say = null; s() }
  }

  // said is whether any of the reply exists yet — text, thought or a client
  // tool call. Until something was said, a failed turn is a failed request
  // (it rejects, and magpie may mark the sign-in or retry on a fresh
  // server), never a reply whose text is the error.
  get said() { return !!(this.text || this.thought || this.calls.length) }

  update(params) {
    if (this.stop) return
    const u = params?.update ?? {}
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      this.text += this.historyEcho.write(u.content.text)
      this.onEvent?.()
    } else if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text") {
      this.thought += u.content.text
      this.onEvent?.({ kind: "thought", text: u.content.text })
    }
    // ACP tool progress is separate from the client's tool_calls response.
    this.#saidSomething()
  }

  addCall(name, args) {
    if (this.stop || this.calls.length >= 16) return false
    const call = { id: `call_${randomUUID().replaceAll("-", "").slice(0, 16)}`, name, args: JSON.stringify(args ?? {}) }
    this.calls.push(call)
    this.#saidSomething()
    if (!this.ending) {
      this.ending = true
      // a moment for parallel calls of the same turn to arrive too
      setTimeout(() => this.finish("tool_calls"), 300).unref?.()
    }
    return call
  }

  finish(reason) {
    if (this.stop) return
    this.text += this.historyEcho.flush()
    if (this.historyEcho.repeated && !this.text.trim() && !this.calls.length) {
      this.text = "[Antigravity repeated the conversation history. Please retry the request.]"
    }
    this.stop = reason
    this.#settle?.()
    this.#say?.()
    this.#settle = null
    this.#say = null
  }

  fail(error) {
    if (this.stop) return
    this.text += this.historyEcho.flush()
    this.error = error
    this.stop = "error"
    this.#settle?.()
    this.#say?.()
    this.#settle = null
    this.#say = null
  }
}

// Use the runtime's announced /usage command. It returns Markdown, so read
// only the quota section and ignore the session-token counters.
function usageWindows(text) {
  const windows = []
  let inQuota = false
  let family = ""
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/)
    if (heading) {
      inQuota = /^Quota Limits$/i.test(heading[1])
      family = ""
      continue
    }
    if (!inQuota) continue
    const group = line.match(/^-\s+\*\*([^*]+)\*\*\s*$/)
    if (group) {
      family = /^Gemini Models$/i.test(group[1]) ? "Gemini" : group[1]
      continue
    }
    const match = line.match(/^\s+-\s+\*\*(Weekly|Five Hour) Limit Remaining:\*\*\s+(\d+(?:\.\d+)?)%\s+remaining(?:\s+\(resets (.+)\))?/i)
    if (!family || !match) continue
    const remaining = Number(match[2])
    if (remaining < 0 || remaining > 100) continue
    const weekly = match[1].toLowerCase() === "weekly"
    const reset = match[3] ? Date.parse(match[3]) : NaN
    windows.push({
      name: `${family} · ${weekly ? "Weekly" : "5 hours"}`,
      span: weekly ? 604800 : 18000,
      used: Math.round((100 - remaining) * 100) / 100,
      ...(Number.isFinite(reset) ? { resetsAt: new Date(reset).toISOString() } : {}),
      aside: true,
    })
  }
  return windows
}

async function readRuntimeUsage(auth) {
  const conn = await connectionFor(auth)
  const commands = new Set()
  const output = []
  const updates = []
  let session
  let collect = false
  const onUpdate = ({ sessionId, update }) => {
    if (!session) {
      if (update?.sessionUpdate === "available_commands_update") updates.push({ sessionId, update })
      return
    }
    if (sessionId !== session.sessionId) return
    if (update?.sessionUpdate === "available_commands_update") {
      for (const command of update.availableCommands ?? []) commands.add(command.name)
    }
    if (collect && update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      output.push(update.content.text)
    }
  }
  const unsubscribe = conn.onSessionUpdate(onUpdate)
  try {
    session = await conn.newSession(conn.cwd, [], 10_000)
    for (const update of updates) onUpdate(update)
    const tier = session._meta?.antigravity?.tier?.name || "Antigravity"
    const deadline = Date.now() + 1800
    while (!commands.has("usage") && Date.now() < deadline) await sleep(50)
    if (!commands.has("usage")) return { plan: tier, windows: [] }
    collect = true
    const request = conn.call("session/prompt", {
      sessionId: session.sessionId, prompt: [{ type: "text", text: "/usage" }],
    }, 10_000, false)
    const reply = await request.promise
    const windows = reply?.stopReason === "end_turn" ? usageWindows(output.join("")) : []
    return { plan: tier, windows }
  } finally {
    unsubscribe()
    if (session) {
      conn.cancel(session.sessionId)
      conn.closeSession(session.sessionId)
    }
  }
}

const accountQuotas = new Map()
const usageReads = new Map()

async function accountUsage(auth) {
  const scope = accountScope(auth)
  const profile = PROFILE_ID.test(scope) ? profilePath(scope) : undefined
  const account = profile ? profileUser(profile) : localAuth().email || (auth.type === "oauth" ? "原 Google 账号" : "")
  const previous = usageReads.get(scope)
  const at = Date.now()
  let reading = previous
  if (!reading || at - reading.at >= QUOTA_TTL) {
    reading = {
      at,
      request: readRuntimeUsage(auth).catch((error) => {
        if (error?.signIn === "expired" || isAuthError(error)) throw expired("Antigravity asks to be signed in again")
        return { plan: "Antigravity", windows: [] }
      }),
    }
    usageReads.set(scope, reading)
  }
  const [current, user] = await Promise.all([reading.request, account])
  if (current.windows.length) return { ...current, ...(user ? { user } : {}) }

  const lastQuota = accountQuotas.get(scope)
  const plan = lastQuota?.tier || current.plan
  if (typeof lastQuota?.used === "number" && at - lastQuota.at < QUOTA_TTL) {
    const w = { name: "Antigravity quota", used: lastQuota.used, aside: true }
    if (lastQuota.resetsAt) w.resetsAt = lastQuota.resetsAt
    return { plan, ...(user ? { user } : {}), windows: [w] }
  }
  return { plan, ...(user ? { user } : {}), windows: [{ name: "Antigravity quota", display: "ACP quota unavailable", aside: true }] }
}

function noteQuota(response) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
  const usage = response?.usage ?? {}
  const quota = response?._meta?.quota ?? {}
  const remaining = num(quota.remainingRequests) ?? num(quota.remainingQueries) ?? num(quota.remaining)
  const limit = num(quota.requestLimit) ?? num(quota.queryLimit) ?? num(quota.limit)
  const reset = quota.resetTimestamp ?? quota.resetAt ?? quota.reset_time
  const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : undefined
  const cacheRead = count(usage.cachedReadTokens)
  const cacheWrite = count(usage.cachedWriteTokens)
  const input = num(usage.inputTokens ?? usage.input_tokens) ?? num(quota.token_count?.input_tokens) ?? 0
  const output = num(usage.outputTokens ?? usage.output_tokens) ?? num(quota.token_count?.output_tokens) ?? 0
  const total = num(usage.totalTokens)
  // ACP 1.5.2 reports uncached input separately, while earlier servers
  // can include cached input. When supplied, the total identifies the shape.
  const cache = (cacheRead ?? 0) + (cacheWrite ?? 0)
  const inclusive = total !== undefined && total === input + output && cache <= input
  const said = {
    at: Date.now(),
    tier: typeof (quota.tier ?? quota.plan) === "string" ? (quota.tier ?? quota.plan) : "",
    used: remaining !== undefined && limit ? Math.round(Math.max(0, Math.min(100, (1 - remaining / limit) * 100)) * 10) / 10 : undefined,
    resetsAt: (typeof reset === "number" && reset > 1e12 ? new Date(reset) : typeof reset === "number" ? new Date(reset * 1000) : Date.parse(reset) ? new Date(reset) : null)?.toISOString?.() ?? "",
    input: input + (inclusive ? 0 : cache),
    output,
    thought: num(usage.thoughtTokens) ?? 0,
    cacheRead,
    cacheWrite,
  }
  return said
}

function usageOf(q) {
  if (!q || !(q.input || q.output)) return { magpie_cache_unknown: true }
  const hasCache = q.cacheRead !== undefined
  return {
    prompt_tokens: q.input,
    completion_tokens: q.output,
    total_tokens: q.input + q.output,
    ...(hasCache || q.cacheWrite !== undefined ? { prompt_tokens_details: {
      ...(q.cacheRead !== undefined ? { cached_tokens: q.cacheRead } : {}),
      ...(q.cacheWrite !== undefined ? { cache_write_tokens: q.cacheWrite } : {}),
    } } : {}),
    ...(hasCache ? {} : { magpie_cache_unknown: true }),
    ...(q.thought ? { completion_tokens_details: { reasoning_tokens: q.thought } } : {}),
  }
}

// Per-model-call usage from antigravity-acp's local conversation SQLite store.
// ACP reports accumulated usage only when session/prompt completes, so parked
// tool-call turns read completed rows from gen_metadata (with steps fallback)
// and the closing turn reconciles against the final ACP total.
let sqliteOpener

function loadSqliteOpener() {
  if (sqliteOpener !== undefined) return sqliteOpener
  sqliteOpener = null
  try {
    const { Database, constants } = requireModule("bun:sqlite")
    if (typeof Database === "function") {
      const flags = constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI
      sqliteOpener = (target) => {
        const db = new Database(target, flags)
        return {
          all: (sql, ...args) => {
            const stmt = db.prepare(sql)
            try { return stmt.all(...args) } finally { stmt.finalize() }
          },
          close: () => db.close(),
        }
      }
      return sqliteOpener
    }
  } catch {}
  try {
    const { DatabaseSync } = requireModule("node:sqlite")
    if (typeof DatabaseSync === "function") {
      sqliteOpener = (target) => {
        const db = new DatabaseSync(target, { readOnly: true, timeout: 0 })
        return {
          all: (sql, ...args) => db.prepare(sql).all(...args),
          close: () => db.close(),
        }
      }
      return sqliteOpener
    }
  } catch {}
  return sqliteOpener
}

function sessionStorePath(sessionId, profile) {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(String(sessionId))) return null
  return path.join(authDir(profile), "conversations", `${sessionId}.db`)
}

function readVarint(buf, at) {
  let value = 0
  let scale = 1
  for (let i = 0; i < 10; i++) {
    const byte = buf[at + i]
    if (byte === undefined) return null
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 }
    scale *= 128
  }
  return null
}

function walkProto(buf, fn) {
  let at = 0
  while (at < buf.length) {
    const tag = readVarint(buf, at)
    if (!tag || tag.value < 8) return false
    at = tag.next
    const field = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    if (wire === 0) {
      const item = readVarint(buf, at)
      if (!item) return false
      at = item.next
      fn(field, wire, item.value)
    } else if (wire === 2) {
      const len = readVarint(buf, at)
      if (!len || len.next + len.value > buf.length) return false
      fn(field, wire, buf.subarray(len.next, len.next + len.value))
      at = len.next + len.value
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4
      if (at > buf.length) return false
    } else {
      return false
    }
  }
  return true
}

const protoCount = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)

function decodeUsageProto(buf) {
  const usage = { input: 0, output: 0, write: 0, read: 0, thinking: 0 }
  const ok = walkProto(buf, (field, wire, n) => {
    if (wire !== 0) return
    if (field === 2) usage.input = protoCount(n)
    else if (field === 3) usage.output = protoCount(n)
    else if (field === 4) usage.write = protoCount(n)
    else if (field === 5) usage.read = protoCount(n)
    else if (field === 9) usage.thinking = protoCount(n)
  })
  return ok ? usage : null
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

function decodeStepUsage(metadata) {
  const buf = toBytes(metadata)
  if (!buf) return null
  let stats = null
  const ok = walkProto(buf, (field, wire, value) => {
    if (field === 9 && wire === 2) stats = decodeUsageProto(value)
  })
  return ok ? stats : null
}

function decodeGenerationUsage(data) {
  const buf = toBytes(data)
  if (!buf) return null
  let stats = null
  let valid = true
  const ok = walkProto(buf, (field, wire, chat) => {
    if (field !== 1 || wire !== 2) return
    valid = walkProto(chat, (sub, subWire, value) => {
      if (sub === 4 && subWire === 2) {
        stats = decodeUsageProto(value)
        if (!stats) valid = false
      }
    }) && valid
  })
  return ok && valid && stats ? stats : null
}

function isCheckpointedWal(file) {
  if (fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`) || fs.existsSync(`${file}-journal`)) return false
  let fd
  try {
    fd = fs.openSync(file, "r")
    const header = new Uint8Array(20)
    if (fs.readSync(fd, header, 0, 20, 0) < 20) return false
    return header[18] === 2 && header[19] === 2
  } catch {
    return false
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
  }
}

function immutableStoreUri(resolved) {
  if (process.platform === "win32" && resolved.startsWith("\\\\")) {
    return `file:${resolved.replace(/[%?# ]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}?immutable=1`
  }
  return `${pathToFileURL(resolved).href}?immutable=1`
}

function queryStoreTable(db, sql, ...args) {
  try {
    return db.all(sql, ...args)
  } catch (error) {
    if (/no such table|no such column/i.test(String(error?.message ?? ""))) return null
    throw error
  }
}

function withReadOnlyStore(file, fn) {
  if (typeof file !== "string" || !file || file.includes("\0")) return null
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved)) return null
  const open = loadSqliteOpener()
  if (!open) return null
  const run = (target) => {
    let db
    try {
      db = open(target)
      return fn(db)
    } finally {
      try { db?.close() } catch {}
    }
  }
  if (isCheckpointedWal(resolved)) {
    try {
      const result = run(immutableStoreUri(resolved))
      if (!fs.existsSync(`${resolved}-wal`)) return result
    } catch {
      if (!fs.existsSync(`${resolved}-wal`)) return null
    }
  }
  try {
    return run(resolved)
  } catch {
    return null
  }
}

function maxCompletedModelStep(db) {
  const rows = queryStoreTable(db,
    `SELECT COALESCE(MAX(idx), -1) AS idx FROM steps WHERE step_type = ${MODEL_STEP_TYPE} AND status = ${MODEL_STEP_DONE}`)
  const idx = Number(rows?.[0]?.idx)
  return Number.isSafeInteger(idx) ? idx : null
}

function modelStepsAfter(db, afterIdx) {
  const rows = queryStoreTable(db,
    `SELECT idx, metadata FROM steps WHERE step_type = ${MODEL_STEP_TYPE} AND status = ${MODEL_STEP_DONE} AND idx > ? ORDER BY idx`,
    afterIdx)
  if (!rows) return null
  const steps = []
  for (const row of rows) {
    const idx = Number(row.idx)
    const usage = decodeStepUsage(row.metadata)
    if (!Number.isSafeInteger(idx) || !usage) continue
    steps.push({ idx, ...usage })
  }
  return steps
}

function modelUsageCursor(file) {
  if (typeof file !== "string" || !file || file.includes("\0")) return null
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved)) return { source: null, idx: -1, generationIdx: -1 }
  return withReadOnlyStore(resolved, (db) => {
    const genRows = queryStoreTable(db, "SELECT COALESCE(MAX(idx), -1) AS idx FROM gen_metadata")
    const generationIdx = Number(genRows?.[0]?.idx)
    const step = maxCompletedModelStep(db)
    if (Number.isSafeInteger(generationIdx)) {
      return step === null ? { source: "gen_metadata", idx: generationIdx }
        : { source: null, idx: step, generationIdx }
    }
    return step === null ? null : { source: "steps", idx: step }
  })
}

function modelUsageAfter(file, cursor) {
  if (!cursor) return null
  return withReadOnlyStore(file, (db) => {
    if (cursor.source !== "steps") {
      const after = cursor.source === "gen_metadata" ? cursor.idx : cursor.generationIdx
      const rows = queryStoreTable(db, "SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx", after)
      if (rows) {
        const steps = []
        let pending = false
        for (const row of rows) {
          const idx = Number(row.idx)
          const usage = decodeGenerationUsage(row.data)
          if (!Number.isSafeInteger(idx)) return null
          if (!usage || !(usage.input + usage.read + usage.write + usage.output + usage.thinking)) {
            pending = true
            continue
          }
          pending = false
          steps.push({ idx, ...usage })
        }
        if (steps.length || pending || cursor.source === "gen_metadata") {
          return { source: "gen_metadata", steps, ...(pending ? { pending: true } : {}) }
        }
      }
      if (cursor.source === "gen_metadata") return null
    }
    const steps = modelStepsAfter(db, cursor.idx)
    return steps === null ? null : { source: "steps", steps }
  })
}

async function resolveStepUsage(promptState, { final = false, acpQuota = null, sawOutput = false } = {}) {
  if (!promptState?.stepsFile || !promptState.stepCursor) return null
  if (!fs.existsSync(promptState.stepsFile)) return null
  const measured = promptState.measured
  const expected = final && acpQuota ? acpQuota.input : null
  const promptSum = (steps) => steps.reduce((sum, item) => sum + item.input + item.read + item.write, measured.prompt)
  const isComplete = (steps) => {
    if (!steps?.length) return false
    if (expected === null) return true
    return promptSum(steps) >= expected
  }
  const canShareGeneration = !final && !sawOutput && measured.prompt > 0 && promptState.stepCursor.source !== null
  const start = performance.now()
  let batch = modelUsageAfter(promptState.stepsFile, promptState.stepCursor)
  for (;;) {
    if (!batch || isComplete(batch.steps)) break
    const waitMs = canShareGeneration && !batch.pending ? STEP_USAGE_SAME_GEN_WAIT_MS : STEP_USAGE_WAIT_MS
    if (performance.now() - start >= waitMs) break
    await new Promise((resolve) => setTimeout(resolve, STEP_USAGE_POLL_MS))
    batch = modelUsageAfter(promptState.stepsFile, promptState.stepCursor)
  }
  if (!batch) return null
  const steps = batch.steps
  if (!isComplete(steps)) {
    const withinExpected = final && expected !== null && measured.prompt > 0 &&
      measured.prompt >= expected &&
      measured.prompt <= expected + Math.max(16, Math.ceil(expected * 0.01))
    if (!batch.pending && !steps?.length && (canShareGeneration || withinExpected)) {
      const context = measured.context || 0
      return {
        at: Date.now(),
        tier: "",
        used: undefined,
        resetsAt: "",
        input: context,
        output: 0,
        thought: 0,
        cacheRead: context,
        cacheWrite: 0,
      }
    }
    return null
  }
  const prompt = promptSum(steps)
  if (expected !== null && prompt > expected + Math.max(16, Math.ceil(expected * 0.01))) return null
  const last = steps.at(-1)
  const output = steps.reduce((sum, item) => sum + Math.max(item.output, item.thinking), 0)
  const thought = steps.reduce((sum, item) => sum + item.thinking, 0)
  for (const item of steps) {
    measured.input += item.input
    measured.read += item.read
    measured.write += item.write
    measured.output += Math.max(item.output, item.thinking)
    measured.thought += item.thinking
  }
  measured.prompt = prompt
  measured.context = last.input + last.read + last.write
  measured.lastRead = last.read
  measured.lastWrite = last.write
  promptState.stepCursor = { source: batch.source, idx: last.idx }
  return {
    at: Date.now(),
    tier: "",
    used: undefined,
    resetsAt: "",
    input: last.input + last.read + last.write,
    output,
    thought,
    cacheRead: last.read,
    cacheWrite: last.write,
  }
}

function subtractMeasuredUsage(acpQuota, measured) {
  const acpRead = acpQuota.cacheRead ?? 0
  const acpWrite = acpQuota.cacheWrite ?? 0
  const acpUncached = Math.max(0, acpQuota.input - acpRead - acpWrite)
  const input = Math.max(0, acpUncached - measured.input)
  const read = Math.max(0, acpRead - measured.read)
  const write = Math.max(0, acpWrite - measured.write)
  const output = Math.max(0, acpQuota.output - measured.output)
  const thought = Math.min(output, Math.max(0, acpQuota.thought - measured.thought))
  return {
    ...acpQuota,
    input: input + read + write,
    output,
    thought,
    cacheRead: acpQuota.cacheRead !== undefined ? read : undefined,
    cacheWrite: acpQuota.cacheWrite !== undefined ? write : undefined,
  }
}

// Per-step rows were unreadable for the closing turn. The ACP total (minus
// what parked turns already reported) is still right for billing output, but
// its prompt side may span several model calls, and chat clients read a
// reply's prompt tokens as the context size — a summed tool loop reads as
// >100% and forces a compaction. Context only grows within a session, so a
// remainder under twice the last measured call is that one call; anything
// larger is reported as a lower bound, never as the inflated sum.
function fallbackFinalUsage(acpQuota, promptState) {
  const measured = promptState?.measured
  const segments = Math.max(1, promptState?.segments || 1)
  if (segments === 1 && !(measured?.prompt > 0)) return acpQuota
  const rest = measured?.prompt > 0 ? subtractMeasuredUsage(acpQuota, measured) : acpQuota
  const context = measured?.context || 0
  if (context > 0) {
    if (rest.input < 2 * context) return rest
    return { ...rest, input: context, cacheRead: measured.lastRead, cacheWrite: measured.lastWrite }
  }
  // nothing measured: the sum covers at least one call per chat turn
  const scale = (n) => (n === undefined ? undefined : Math.round(n / segments))
  return { ...rest, input: scale(rest.input), cacheRead: scale(rest.cacheRead), cacheWrite: scale(rest.cacheWrite) }
}

async function setSessionModel(conn, session, modelId) {
  const selector = (session?.configOptions ?? []).find((o) => o?.type === "select" && (o.category === "model" || o.id === "model"))
  if (selector) {
    const out = await conn.request("session/set_config_option", { sessionId: session.sessionId, configId: selector.id, value: modelId })
    if (Array.isArray(out?.configOptions)) session.configOptions = out.configOptions
    return
  }
  await conn.request("session/set_model", { sessionId: session.sessionId, modelId })
}

async function setThinkingLevel(conn, session, effort) {
  const selector = thinkingSelector(session)
  if (!selector || !effort || effort === "none") return
  const options = (selector.options ?? []).flatMap((entry) => entry?.options ?? [entry])
  const available = new Set(options.map((entry) => entry?.value))
  const preferred = {
    minimal: ["minimal", "low"],
    xhigh: ["xhigh", "extra", "max", "high"],
    max: ["max", "extra", "xhigh", "high"],
    ultra: ["max", "extra", "xhigh", "high"],
  }[effort] ?? [effort]
  const value = [...preferred, "high", "medium", "low"].find((level) => available.has(level))
  if (value && value !== selector.currentValue) {
    await conn.request("session/set_config_option", { sessionId: session.sessionId, configId: selector.id, value })
  }
}

const SSE_HEAD = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }

function streamReply(req, run, onCancel, quota) {
  const id = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()
  let controller = null
  const stream = new ReadableStream({
    start(c) { controller = c },
    // a reader that went away (the client hung up) ends the turn too, so the
    // prompt doesn't run on unheard
    cancel() {
      controller = null
      try { onCancel?.() } catch {}
    },
  })
  const push = (delta, finish = null) => {
    try {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model: req.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`))
    } catch {}
  }
  const sink = {
    open: () => push({ role: "assistant", content: "" }),
    text: (t) => push({ content: t }),
    thought: (t) => push({ reasoning_content: t }),
    toolCalls: (calls) => {
      for (const [i, c] of calls.entries()) push({ tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: c.args } }] })
    },
    note: (t) => push({ content: t }),
    done: (finish) => {
      try { controller?.enqueue(encoder.encode(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model: req.model,
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
        usage: usageOf(quota?.()),
      })}\n\n`)) } catch {}
      try { controller?.enqueue(encoder.encode("data: [DONE]\n\n")) } catch {}
      try { controller?.close() } catch {}
      controller = null
    },
  }
  ;(async () => {
    try {
      await run(sink)
    } catch (e) {
      sink.note(`\n[Antigravity: ${String(e?.message ?? e)}]`)
      sink.done("stop")
    }
  })()
  return new Response(stream, { status: 200, headers: SSE_HEAD })
}

function wholeReply(req, turn, finish, signal) {
  let content = turn.text
  if (turn.error && !signal?.aborted) content += `${content ? "\n" : ""}[Antigravity: ${String(turn.error.message ?? turn.error)}]`
  const message = { role: "assistant", content }
  if (turn.thought) message.reasoning_content = turn.thought
  if (turn.calls.length) message.tool_calls = turn.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } }))
  return Response.json({
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usageOf(turn.quota),
  })
}

// handleChat is the loader's fetch: the whole upstream. A prompt that fails
// before anything of the reply exists rejects: a lost sign-in marks the
// account expired, and a server that died under the request (or spoke a line
// that wasn't ACP) is retried once on a fresh one. Once the reply has
// started, an error rides as its tail — a reply is never doubled.
async function handleChat(getAuth, input, init, retried = false) {
  const auth = await getAuth()
  if (!auth || (auth.type !== "oauth" && auth.type !== "api")) throw expired("Antigravity is not signed in; sign in from the provider's page")
  const scope = accountScope(auth)
  const profile = PROFILE_ID.test(scope) ? profilePath(scope) : null

  const req = parseChat(init?.body)
  const wantStream = req.stream === true
  const signal = init?.signal
  const client = continuation(req, init?.headers, scope)
  let bridge
  let conn
  let turn
  let session
  let resumed = false
  let sessionClosed = false
  const closeSession = () => {
    if (!session || sessionClosed) return
    sessionClosed = true
    try { conn.closeSession(session.sessionId) } catch {}
  }
  let stopUpdates = () => {}
  let onAbort = () => {}
  let cleanup = () => bridge?.close()
  try {
    conn = await connectionFor(auth)
    const capabilities = await conn.initialize().then((i) => i?.agentCapabilities, () => null)
    turn = new Turn("")
    const side = Boolean(client) && isSideQuery(req.messages.at(-1))
    const idle = takeSession(client, conn, req, side)
    const promptCaps = capabilities?.promptCapabilities ?? {}
    let prompt
    if (idle) {
      resumed = true
      session = idle.session
      bridge = idle.bridge
      prompt = idle.parked ? [] : userBlocks(req.messages.at(-1))
    } else {
      const { markdown, blocks } = buildPrompt(req)
      prompt = [...blocks]
      if (markdown) {
        prompt.unshift(promptCaps.embeddedContext === true
          ? { type: "resource", resource: { uri: `urn:magpie:antigravity-acp:context/${digest(markdown)}`, mimeType: "text/markdown", text: markdown } }
          : { type: "text", text: markdown })
      }
      if (!prompt.length) throw new Error("the request's last user message is empty")
      bridge = new Bridge(req.tools ?? [])
      if (!bridge.empty) await bridge.start()
      session = await conn.newSession(conn.cwd, bridge.descriptor() ? [bridge.descriptor()] : [])
      const model = String(req.model ?? "")
      const effort = String(req.reasoning_effort ?? "")
      const models = sessionCatalog(session)
      // Keep the old explicit "-xhigh" ids usable after a runtime upgrade.
      const fallbackModel = model.endsWith("-xhigh") && !models.some((entry) => entry.id === model)
        ? models.find((entry) => entry.id === model.slice(0, -"-xhigh".length)) : undefined
      await setSessionModel(conn, session, resolveServerId(fallbackModel?.id ?? model, fallbackModel ? "xhigh" : effort, models))
      await setThinkingLevel(conn, session, fallbackModel ? "xhigh" : effort)
    }
    if (!prompt.length && !idle?.parked) throw new Error("the request's last user message is empty")
    turn.sessionId = session.sessionId
    if (promptCaps.image !== true) prompt = prompt.map((block) => block.type === "image"
      ? { type: "text", text: "[an image was omitted: this Antigravity server does not take image input]" } : block)
    stopUpdates = conn.onSessionUpdate((params) => {
      if (params?.sessionId === session.sessionId) turn.update(params)
    })
    // from here the teardown has more to undo; the reply can also outlive
    // this function when it streams, so cleanup waits for the turn
    cleanup = () => { stopUpdates(); bridge.close() }
    let promptState = idle?.parked
    let parked = false
    let aborted = false
    let cleaned = false
    if (!bridge.empty) {
      bridge.onCall = ({ name, args }) => {
        if (aborted || signal?.aborted) return false
        const call = turn.addCall(name, args)
        if (!call) return false
        if (!client) return { content: [{ type: "text", text: "Delivered to the client. The result will be attached to the next request." }] }
        return new Promise((resolve) => promptState.results.set(call.id, resolve))
      }
      conn.clientBridges.set(session.sessionId, bridge)
    }
    onAbort = () => {
      if (cleaned || parked) return
      aborted = true
      conn.cancel(session.sessionId)
      turn.finish("stop")
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    cleanup = () => {
      if (cleaned) return
      cleaned = true
      signal?.removeEventListener("abort", onAbort)
      stopUpdates()
      conn.clientBridges.delete(session.sessionId)
      bridge.onCall = null
      if (parked && !promptState.settled && conn.live) {
        keepSession(client, { conn, session, bridge, parked: promptState }, turn)
      } else if (client && turn.canContinue && turn.text && !turn.historyEcho.repeated &&
        !turn.calls.length && !aborted && !signal?.aborted && conn.live &&
        !(side && idleSessions.has(client.key))) {
        // a side answer stays out of the main history: the session is kept
        // for the main conversation's next turn (with the side exchange
        // inside it, which is harmless context)
        keepSession(client, { conn, session, bridge }, turn, side ? client.history.slice(0, -1) : null)
      } else {
        if (client) reuseLog({ drop: true, key: client.key.slice(0, 12), parked, settled: promptState?.settled, live: conn.live,
          canContinue: turn.canContinue, text: Boolean(turn.text), echo: turn.historyEcho.repeated, calls: turn.calls.length,
          stop: turn.stop, aborted, signalAborted: Boolean(signal?.aborted) })
        cancelPrompt(conn, session, promptState)
        closeSession()
        bridge.close()
      }
    }

    if (aborted) throw signal.reason
    if (idle?.parked) {
      promptState.segments = (promptState.segments || 1) + 1
      const pending = promptState.results
      promptState.results = new Map()
      const extra = (idle.extra ?? []).flatMap((message) => userBlocks(message))
      idle.added.forEach((result, i) => {
        const content = userBlocks(result)
        if (i === idle.added.length - 1) content.push(...extra)
        pending.get(result.tool_call_id)({
          content,
          ...(result.is_error === true ? { isError: true } : {}),
        })
      })
    } else {
      const stepsFile = sessionStorePath(session.sessionId, profile)
      const stepCursor = modelUsageCursor(stepsFile)
      // Keep pending MCP responses with the ACP prompt until the client
      // returns the matching tool results or the session expires.
      const started = conn.call("session/prompt", { sessionId: session.sessionId, prompt }, PROMPT_TIMEOUT, false)
      promptState = {
        prompt: started,
        results: new Map(),
        settled: false,
        stepsFile,
        stepCursor,
        segments: 1,
        measured: { prompt: 0, input: 0, read: 0, write: 0, output: 0, thought: 0, context: 0, lastRead: 0, lastWrite: 0 },
      }
      started.promise.then(() => { promptState.settled = true }, () => { promptState.settled = true })
    }
    const promptReply = promptState.prompt.promise
    promptReply.catch((e) => {
      if (/didn't answer session\/prompt/.test(String(e?.message ?? ""))) { try { conn.cancel(session.sessionId) } catch {} }
    })

    // settleTurn ends the turn the first time the chat protocol must: the
    // prompt answered, a client tool was called, or the request was aborted.
    const settleTurn = async () => {
      const outcome = await Promise.race([
        turn.ended.then(() => "turn"),
        promptReply.catch((error) => error),
      ])
      if (outcome === "turn") {
        parked = Boolean(client && !aborted && !signal?.aborted && !promptState.settled &&
          turn.stop === "tool_calls" && promptState.results.size)
        if (parked) bridge.onCall = null
        if (!aborted && !signal?.aborted && turn.stop === "tool_calls") {
          const stepQuota = await resolveStepUsage(promptState, {
            final: false,
            sawOutput: Boolean(turn.text || turn.thought),
          })
          if (stepQuota) turn.quota = stepQuota
        }
      } else if (outcome instanceof Error) {
        turn.fail(outcome)
      } else {
        const acpQuota = outcome ? noteQuota(outcome) : null
        if (acpQuota) {
          accountQuotas.set(scope, acpQuota)
          // ACP's session/prompt usage is the sum over every model call in the
          // prompt. Chat clients read a reply's prompt tokens as the current
          // context size, so always report the last model call instead —
          // otherwise a long tool loop reports >100% and forces a compaction.
          const stepQuota = promptState?.stepCursor
            ? await resolveStepUsage(promptState, {
              final: true,
              acpQuota,
              sawOutput: Boolean(turn.text || turn.thought),
            })
            : null
          turn.quota = stepQuota
            ? {
              ...acpQuota,
              input: stepQuota.input,
              output: stepQuota.output,
              thought: stepQuota.thought,
              cacheRead: stepQuota.cacheRead,
              cacheWrite: stepQuota.cacheWrite,
            }
            : fallbackFinalUsage(acpQuota, promptState)
        }
        turn.canContinue = outcome?.stopReason === "end_turn"
        turn.finish(turn.calls.length ? "tool_calls" : stopOf(outcome))
      }
    }

    const finishOf = () => (turn.calls.length ? "tool_calls" : turn.stop === "length" ? "length" : "stop")

    if (wantStream) {
      // nothing goes out until the turn settles or the agent says something:
      // a prompt that fails before anything was said rejects below, so the
      // catch can mark the sign-in or retry on a fresh server — a reply is
      // never a 200 whose text is the error. Once the stream has started, an
      // error is only the reply's tail, so a half answer is never doubled.
      const settled = settleTurn()
      await Promise.race([settled, turn.firstSaid])
      if (turn.error && !turn.said && !signal?.aborted) throw turn.error
      return streamReply(req, async (sink) => {
        try {
          sink.open()
          // what the turn said while the reply was being decided goes first,
          // then the rest live as it arrives
          let pushedText = ""
          let pushedThought = ""
          const pump = () => {
            if (turn.thought.length > pushedThought.length) { sink.thought(turn.thought.slice(pushedThought.length)); pushedThought = turn.thought }
            if (turn.text.length > pushedText.length) { sink.text(turn.text.slice(pushedText.length)); pushedText = turn.text }
          }
          pump()
          turn.onEvent = pump
          await settled
          pump()
          if (turn.calls.length) sink.toolCalls(turn.calls)
          if (turn.error && !signal?.aborted) sink.note(`\n[Antigravity: ${String(turn.error.message ?? turn.error)}]`)
          cleanup()
          sink.done(finishOf())
        } finally {
          cleanup()
        }
      }, () => onAbort(), () => turn.quota)
    }
    try {
      await settleTurn()
    } finally {
      cleanup()
    }
    // a turn that failed before it said anything is a failed request
    if (turn.error && !turn.said && !signal?.aborted) throw turn.error
    return wholeReply(req, turn, finishOf(), signal)
  } catch (e) {
    cleanup()
    closeSession()
    // a server that died, spoke a line that wasn't ACP, or never started is
    // a broken transport: the request is tried once on a fresh one, but only
    // while nothing of the reply exists, so a reply is never doubled
    const transport = /isn't running|exited \(|could not be started|isn't ACP|doesn't read|one frame can hold/i.test(String(e?.message ?? e))
    const lostSession = resumed && /session (?:not found|does not exist)|(?:unknown|no such) session/i.test(String(e?.message ?? e))
    if ((transport || lostSession) && !retried && !signal?.aborted && (!turn || !turn.said)) {
      if (pools.get(scope)?.conn === conn && !conn?.live) pools.delete(scope)
      return handleChat(getAuth, input, init, true)
    }
    // a prompt the server refused as unauthenticated marks the account, so
    // magpie's routing can fail over: a lost sign-in arrives as the prompt's
    // answer error, not as a throw before it
    if (isAuthError(e)) throw expired("Antigravity asks to be signed in again")
    throw e
  }
}

const stopOf = (response) => {
  const r = String(response?.stopReason ?? "end_turn")
  if (r === "max_tokens") return "length"
  return "stop"
}

// ---- the plugin ------------------------------------------------------------

export const AntigravityAcpPlugin = async (input = {}) => {
  ctx.client = input.client ?? null
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "Antigravity (ACP)",
        npm: "@ai-sdk/openai-compatible",
        api: API_BASE,
        models: FALLBACK_MODELS,
      }
    },

    auth: {
      provider: PROVIDER,
      async refresh() {
        // the marker never expires and the server's tokens are its own; a
        // really lost sign-in says so when a request is made (-32000)
        return undefined
      },
      async loader(getAuth) {
        return {
          baseURL: API_BASE,
          apiKey: "antigravity",
          async fetch(input2, init2) {
            return handleChat(getAuth, input2, init2)
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Add a separate Google account",
          labels: { zh: "添加独立 Google 账号", "zh-TW": "新增獨立 Google 帳號" },
          authorize: addGoogleAccount,
        },
        { type: "oauth", label: "Use Antigravity's current Google sign-in", authorize: currentSignIn },
        { type: "api", label: "Gemini API key", placeholder: "AIza…" },
      ],
      async usage(getAuth) {
        const auth = await getAuth?.()
        return auth ? accountUsage(auth) : { plan: "Antigravity", windows: [] }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const have = provider?.models ?? {}
        if (!auth) return have
        try {
          const projected = await discoverModels(auth)
          if (!projected.length) throw new Error("Antigravity listed no models")
          // Saved Magpie picks may still name explicit effort variants
          // published by the older server.
          for (const model of [...projected]) {
            const alias = `${model.id}-xhigh`
            if (have[alias] && !projected.some((entry) => entry.id === alias)) {
              projected.push({ ...model, id: alias, name: `${model.name} (xhigh)`, efforts: [] })
            }
          }
          return Object.fromEntries(projected.map((m) => [m.id, magpieModel(provider, m)]))
        } catch (e) {
          if (isAuthError(e)) throw expired("Antigravity asks to be signed in again")
          throw e
        }
      },
    },
  }
}

// for tests
// shutdown is for tests: a suite lets its pooled servers go before it takes
// its temporary home away
const shutdown = () => {
  for (const key of idleSessions.keys()) disposeSession(forgetIdleSession(key))
  for (const [, p] of pools) { try { p.conn?.kill() } catch {} }
  pools.clear()
  usageReads.clear()
  accountQuotas.clear()
  profileUsers.clear()
}

export const _internal = {
  projectModels, resolveServerId, buildPrompt, parseChat, localAuth, configureDefaultAuth,
  Bridge, Turn, noteQuota, sessionModels, resolveLaunch, platformKey, usageWindows,
  AcpConnection, authDir, runtimeRoot, workDir, shutdown, sweepStaging,
}
