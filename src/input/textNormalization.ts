export const normalizeTextDeltaForInjection = (text: string): string =>
  text.replace(/\r\n/g, "\n").replace(/[ \t]*[\r\n\u2028\u2029]+[ \t]*/g, " ")

export const normalizeTextForInjection = (text: string): string =>
  normalizeTextDeltaForInjection(text).trim()

export const normalizeTextForTypingBackend = (text: string): string =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/^[ \t]*[\r\n\u2028\u2029]+[ \t]*/g, "")
    .replace(/[ \t]*[\r\n\u2028\u2029]+[ \t]*$/g, "")
    .replace(/[ \t]*[\r\n\u2028\u2029]+[ \t]*/g, " ")
