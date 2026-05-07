import * as assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { Effect, Exit } from "effect"

import {
  CodexAuthError,
  decodeJwtExpSeconds,
  ensureFreshCodexAuth,
  isAccessTokenExpired,
  loadCodexAuthFile,
  resolveCodexAuthPath,
  resolveCodexHome,
  type CodexAuthJson,
  type CodexTokenRefresher,
} from "../src/stt/codexAuth.js"

const base64UrlEncode = (value: string): string =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")

const makeJwt = (exp: number): string => `header.${base64UrlEncode(JSON.stringify({ exp }))}.sig`

const validAuth = (accessToken: string, refreshToken = "r-token"): CodexAuthJson => ({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id",
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: null,
  },
  last_refresh: "2020-01-01T00:00:00Z",
})

test("resolveCodexHome uses CODEX_HOME when set", () => {
  const home = resolveCodexHome({ CODEX_HOME: "/tmp/foo" }, () => "/home/x")
  assert.strictEqual(home, "/tmp/foo")
})

test("resolveCodexHome falls back to ~/.codex when CODEX_HOME is missing", () => {
  const home = resolveCodexHome({}, () => "/home/x")
  assert.strictEqual(home, path.join("/home/x", ".codex"))
})

test("resolveCodexHome treats blank CODEX_HOME as unset", () => {
  const home = resolveCodexHome({ CODEX_HOME: "   " }, () => "/home/x")
  assert.strictEqual(home, path.join("/home/x", ".codex"))
})

test("resolveCodexAuthPath joins auth.json", () => {
  const p = resolveCodexAuthPath({ CODEX_HOME: "/srv/codex" }, () => "/home/x")
  assert.strictEqual(p, path.join("/srv/codex", "auth.json"))
})

test("loadCodexAuthFile fails when file is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pie-codex-auth-"))
  const missing = path.join(dir, "auth.json")
  const exit = await Effect.runPromiseExit(loadCodexAuthFile(missing))
  assert.strictEqual(Exit.isFailure(exit), true)
  if (Exit.isFailure(exit)) {
    const failure = exit.cause
    const err = failure.toString()
    assert.match(err, /not found/)
  }
})

test("loadCodexAuthFile fails when JSON is malformed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pie-codex-auth-"))
  const p = path.join(dir, "auth.json")
  await writeFile(p, "not-json", "utf8")
  const exit = await Effect.runPromiseExit(loadCodexAuthFile(p))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadCodexAuthFile fails when access_token is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pie-codex-auth-"))
  const p = path.join(dir, "auth.json")
  await writeFile(p, JSON.stringify({ tokens: { refresh_token: "r" } }), "utf8")
  const exit = await Effect.runPromiseExit(loadCodexAuthFile(p))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadCodexAuthFile accepts valid auth.json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pie-codex-auth-"))
  const p = path.join(dir, "auth.json")
  await writeFile(p, JSON.stringify(validAuth("a-token")), "utf8")
  const auth = await Effect.runPromise(loadCodexAuthFile(p))
  assert.strictEqual(auth.tokens.access_token, "a-token")
  assert.strictEqual(auth.tokens.refresh_token, "r-token")
})

test("CodexAuthError message does not leak token content", () => {
  const err = new CodexAuthError({
    message: "Codex auth.json at /tmp/a is malformed or missing tokens.access_token.",
  })
  assert.strictEqual(err.message.includes("Bearer"), false)
  assert.strictEqual(err.message.includes("eyJ"), false)
})

test("decodeJwtExpSeconds reads exp claim", () => {
  const exp = Math.floor(Date.now() / 1000) + 60
  const token = makeJwt(exp)
  assert.strictEqual(decodeJwtExpSeconds(token), exp)
})

test("decodeJwtExpSeconds returns undefined on malformed JWT", () => {
  assert.strictEqual(decodeJwtExpSeconds("not-a-jwt"), undefined)
})

test("isAccessTokenExpired returns true when now past exp", () => {
  const exp = 1_700_000_000
  const token = makeJwt(exp)
  assert.strictEqual(isAccessTokenExpired(token, (exp + 120) * 1000), true)
})

test("isAccessTokenExpired returns false when token still valid beyond leeway", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = makeJwt(exp)
  assert.strictEqual(isAccessTokenExpired(token, Date.now()), false)
})

test("isAccessTokenExpired returns false when exp claim is missing", () => {
  assert.strictEqual(isAccessTokenExpired("no.exp.here", Date.now()), false)
})

test("ensureFreshCodexAuth returns auth unchanged when not expired", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pie-codex-auth-"))
  const p = path.join(dir, "auth.json")
  const fresh = makeJwt(Math.floor(Date.now() / 1000) + 3600)
  await writeFile(p, JSON.stringify(validAuth(fresh)), "utf8")

  const refresher: CodexTokenRefresher = {
    refresh: () => Effect.die("should not be called"),
  }

  const auth = await Effect.runPromise(ensureFreshCodexAuth({ authPath: p, refresher }))
  assert.strictEqual(auth.tokens.access_token, fresh)
})

test("ensureFreshCodexAuth refreshes expired token and persists updated file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pie-codex-auth-"))
  const p = path.join(dir, "auth.json")
  const expired = makeJwt(1_700_000_000)
  await writeFile(p, JSON.stringify(validAuth(expired, "old-refresh")), "utf8")

  const refresher: CodexTokenRefresher = {
    refresh: (refreshToken) => {
      assert.strictEqual(refreshToken, "old-refresh")
      return Effect.succeed({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        idToken: "new-id",
      })
    },
  }

  const fixedNow = Date.parse("2030-06-01T00:00:00Z")
  const auth = await Effect.runPromise(
    ensureFreshCodexAuth({ authPath: p, refresher, now: () => fixedNow }),
  )

  assert.strictEqual(auth.tokens.access_token, "new-access")
  assert.strictEqual(auth.tokens.refresh_token, "new-refresh")
  assert.strictEqual(auth.tokens.id_token, "new-id")
  assert.strictEqual(auth.last_refresh, new Date(fixedNow).toISOString())

  const persisted: CodexAuthJson = JSON.parse(await readFile(p, "utf8"))
  assert.strictEqual(persisted.tokens.access_token, "new-access")
  assert.strictEqual(persisted.tokens.refresh_token, "new-refresh")
  assert.strictEqual(persisted.last_refresh, new Date(fixedNow).toISOString())
})

test("ensureFreshCodexAuth fails loudly when refresh_token is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pie-codex-auth-"))
  const p = path.join(dir, "auth.json")
  const expired = makeJwt(1_700_000_000)
  const authNoRefresh: CodexAuthJson = {
    OPENAI_API_KEY: null,
    tokens: {
      access_token: expired,
    },
  }
  await writeFile(p, JSON.stringify(authNoRefresh), "utf8")

  const refresher: CodexTokenRefresher = {
    refresh: () => Effect.die("should not be called"),
  }

  const exit = await Effect.runPromiseExit(
    ensureFreshCodexAuth({ authPath: p, refresher, now: () => Date.now() }),
  )
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("ensureFreshCodexAuth propagates permanent refresh failures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pie-codex-auth-"))
  const p = path.join(dir, "auth.json")
  const expired = makeJwt(1_700_000_000)
  await writeFile(p, JSON.stringify(validAuth(expired)), "utf8")

  const refresher: CodexTokenRefresher = {
    refresh: () =>
      Effect.fail(
        new CodexAuthError({
          message:
            "Codex token refresh failed with HTTP 401. Run 'codex login' to re-authenticate.",
        }),
      ),
  }

  const exit = await Effect.runPromiseExit(
    ensureFreshCodexAuth({ authPath: p, refresher, now: () => Date.now() }),
  )
  assert.strictEqual(Exit.isFailure(exit), true)
})
