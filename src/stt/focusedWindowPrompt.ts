import { Effect } from "effect"

import type { NiriError } from "../niri/errors.js"
import { Niri } from "../niri/niri.js"
import type { NiriWindow } from "../niri/schema.js"

const CONTEXT_VALUE_MAX_LENGTH = 200

const promptValue = (value: string | null): string | undefined => {
  if (value === null) {
    return undefined
  }

  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length === 0) {
    return undefined
  }

  return normalized.length > CONTEXT_VALUE_MAX_LENGTH
    ? `${normalized.slice(0, CONTEXT_VALUE_MAX_LENGTH)}…`
    : normalized
}

export const appendFocusedWindowPromptContext = (
  promptTemplate: string,
  focusedWindow: NiriWindow | null,
): string => {
  if (focusedWindow === null) {
    return promptTemplate
  }

  const appId = promptValue(focusedWindow.app_id)
  const title = promptValue(focusedWindow.title)
  const lines = [
    ...(appId === undefined ? [] : [`- app_id: ${appId}`]),
    ...(title === undefined ? [] : [`- title: ${title}`]),
  ]

  if (lines.length === 0) {
    return promptTemplate
  }

  return `${promptTemplate}\n\nFocused window context:\n${lines.join("\n")}\nUse this as context only when it helps disambiguate the audio.`
}

export const promptTemplateWithFocusedWindowContext = (
  promptTemplate: string,
): Effect.Effect<string, NiriError, Niri> =>
  Effect.gen(function* () {
    const niri = yield* Niri
    const focusedWindow = yield* niri.focusedWindow
    return appendFocusedWindowPromptContext(promptTemplate, focusedWindow)
  })
