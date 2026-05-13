export const isSttServiceFailure = (cause: { readonly _tag?: string }): boolean =>
  cause["_tag"] === "OpenRouterSttError" ||
  cause["_tag"] === "CodexRealtimeSttError" ||
  cause["_tag"] === "CodexAuthError" ||
  (cause["_tag"]?.startsWith("Niri") ?? false)
