import { Context, Data, Effect, Layer, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

export class CodexAuthError extends Data.TaggedError("CodexAuthError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const CodexTokensSchema = Schema.Struct({
  id_token: Schema.optional(Schema.String),
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.String),
  account_id: Schema.optional(Schema.NullOr(Schema.String)),
})

const CodexAuthJsonSchema = Schema.Struct({
  OPENAI_API_KEY: Schema.optional(Schema.NullOr(Schema.String)),
  tokens: CodexTokensSchema,
  last_refresh: Schema.optional(Schema.String),
})

export type CodexAuthJson = typeof CodexAuthJsonSchema.Type

export const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token"
export const CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV = "CODEX_REFRESH_TOKEN_URL_OVERRIDE"
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CODEX_REFRESH_SCOPE = "openid profile email"

export const resolveCodexHome = (
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string => {
  const override = env["CODEX_HOME"]?.trim()
  if (override !== undefined && override.length > 0) {
    return override
  }
  return path.join(homedir(), ".codex")
}

export const resolveCodexAuthPath = (
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string => path.join(resolveCodexHome(env, homedir), "auth.json")

const errnoCode = (cause: unknown): string | undefined => {
  if (typeof cause === "object" && cause !== null) {
    const code = (cause as { readonly code?: unknown }).code
    if (typeof code === "string") {
      return code
    }
  }
  return undefined
}

export const loadCodexAuthFile = (
  authPath: string,
): Effect.Effect<CodexAuthJson, CodexAuthError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: () => fs.readFile(authPath, "utf8"),
      catch: (cause) =>
        errnoCode(cause) === "ENOENT"
          ? new CodexAuthError({
              message: `Codex auth.json not found at ${authPath}. Run 'codex login' or set CODEX_HOME to a directory that contains auth.json.`,
            })
          : new CodexAuthError({
              message: `Failed to read Codex auth.json at ${authPath}.`,
              cause,
            }),
    })

    const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
      Effect.mapError(
        (cause) =>
          new CodexAuthError({
            message: `Codex auth.json at ${authPath} is not valid JSON.`,
            cause,
          }),
      ),
    )

    const decoded = yield* Schema.decodeUnknownEffect(CodexAuthJsonSchema)(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new CodexAuthError({
            message: `Codex auth.json at ${authPath} is malformed or missing tokens.access_token. Run 'codex login' to recreate it.`,
            cause,
          }),
      ),
    )

    return decoded
  })

const base64UrlDecode = (input: string): Buffer => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padLength = (4 - (normalized.length % 4)) % 4
  const padded = normalized + "=".repeat(padLength)
  return Buffer.from(padded, "base64")
}

export const decodeJwtExpSeconds = (token: string): number | undefined => {
  const segments = token.split(".")
  if (segments.length < 2) {
    return undefined
  }
  const payloadSegment = segments[1]
  if (payloadSegment === undefined || payloadSegment.length === 0) {
    return undefined
  }
  try {
    const json = base64UrlDecode(payloadSegment).toString("utf8")
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== "object" || parsed === null) {
      return undefined
    }
    const exp = (parsed as { readonly exp?: unknown }).exp
    return typeof exp === "number" ? exp : undefined
  } catch {
    return undefined
  }
}

export const isAccessTokenExpired = (
  token: string,
  nowMs: number,
  leewaySeconds = 60,
): boolean => {
  const exp = decodeJwtExpSeconds(token)
  if (exp === undefined) {
    return false
  }
  return nowMs / 1000 + leewaySeconds >= exp
}

export type CodexRefreshedTokens = {
  readonly accessToken: string
  readonly refreshToken?: string | undefined
  readonly idToken?: string | undefined
}

export type CodexTokenRefresher = {
  readonly refresh: (refreshToken: string) => Effect.Effect<CodexRefreshedTokens, CodexAuthError>
}

const RefreshResponseSchema = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
})

const isPermanentRefreshStatus = (status: number): boolean =>
  status === 400 || status === 401 || status === 403

export const defaultCodexTokenRefresher = (
  env: NodeJS.ProcessEnv = process.env,
): CodexTokenRefresher => {
  const endpoint =
    env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV]?.trim() || CODEX_REFRESH_TOKEN_URL
  return {
    refresh: (refreshToken) =>
      Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                client_id: CODEX_CLIENT_ID,
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                scope: CODEX_REFRESH_SCOPE,
              }),
            }),
          catch: (cause) =>
            new CodexAuthError({
              message: `Codex token refresh network error while contacting ${endpoint}`,
              cause,
            }),
        })

        if (!response.ok) {
          const body = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: () => new CodexAuthError({ message: "failed reading body" }),
          }).pipe(Effect.orElseSucceed(() => ""))
          const permanent = isPermanentRefreshStatus(response.status)
          const remedy = permanent
            ? "Run 'codex login' to re-authenticate."
            : "Retry later; the Codex auth service may be temporarily unavailable."
          return yield* Effect.fail(
            new CodexAuthError({
              message: `Codex token refresh failed with HTTP ${response.status}. ${remedy}${body.length > 0 ? ` details=${body.slice(0, 200)}` : ""}`,
            }),
          )
        }

        const json = yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (cause) =>
            new CodexAuthError({
              message: "Codex token refresh response was not valid JSON",
              cause,
            }),
        })

        const parsed = yield* Schema.decodeUnknownEffect(RefreshResponseSchema)(json).pipe(
          Effect.mapError(
            (cause) =>
              new CodexAuthError({
                message: "Codex token refresh response missing access_token",
                cause,
              }),
          ),
        )

        const result: CodexRefreshedTokens = {
          accessToken: parsed.access_token,
          ...(parsed.refresh_token !== undefined ? { refreshToken: parsed.refresh_token } : {}),
          ...(parsed.id_token !== undefined ? { idToken: parsed.id_token } : {}),
        }
        return result
      }),
  }
}

export const writeCodexAuthFile = (
  authPath: string,
  auth: CodexAuthJson,
): Effect.Effect<void, CodexAuthError> =>
  Effect.tryPromise({
    try: () =>
      fs.writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, {
        mode: 0o600,
        encoding: "utf8",
      }),
    catch: (cause) =>
      new CodexAuthError({
        message: `Failed to persist refreshed Codex auth at ${authPath}`,
        cause,
      }),
  })

export type EnsureFreshCodexAuthOptions = {
  readonly authPath?: string | undefined
  readonly refresher?: CodexTokenRefresher | undefined
  readonly now?: (() => number) | undefined
}

export const ensureFreshCodexAuth = (
  options: EnsureFreshCodexAuthOptions = {},
): Effect.Effect<CodexAuthJson, CodexAuthError> =>
  Effect.gen(function* () {
    const authPath = options.authPath ?? resolveCodexAuthPath()
    const auth = yield* loadCodexAuthFile(authPath)
    const now = options.now?.() ?? Date.now()

    if (!isAccessTokenExpired(auth.tokens.access_token, now)) {
      return auth
    }

    const refreshToken = auth.tokens.refresh_token
    if (refreshToken === undefined || refreshToken.length === 0) {
      return yield* Effect.fail(
        new CodexAuthError({
          message: `Codex access token at ${authPath} is expired and no refresh_token is stored. Run 'codex login'.`,
        }),
      )
    }

    const refresher = options.refresher ?? defaultCodexTokenRefresher()
    const refreshed = yield* refresher.refresh(refreshToken)

    const nextAuth: CodexAuthJson = {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: refreshed.accessToken,
        ...(refreshed.refreshToken !== undefined ? { refresh_token: refreshed.refreshToken } : {}),
        ...(refreshed.idToken !== undefined ? { id_token: refreshed.idToken } : {}),
      },
      last_refresh: new Date(now).toISOString(),
    }

    yield* writeCodexAuthFile(authPath, nextAuth)
    return nextAuth
  })

export class CodexAuthService extends Context.Service<
  CodexAuthService,
  {
    readonly getAccessToken: Effect.Effect<string, CodexAuthError>
  }
>()("pie/stt/CodexAuthService") {
  static readonly layer: Layer.Layer<CodexAuthService> = Layer.sync(CodexAuthService, () => ({
    getAccessToken: ensureFreshCodexAuth().pipe(Effect.map((auth) => auth.tokens.access_token)),
  }))
}
