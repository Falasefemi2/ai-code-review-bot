import { describe, expect, test } from "bun:test"
import { buildPrompt } from "./AiReviewer.ts"
import type { LintResult } from "./Linter.ts"

const lintWith = (...messages: string[]): LintResult => ({
  errorCount: messages.length,
  warningCount: 0,
  diagnostics: messages.map((message, index) => ({
    severity: "error",
    message,
    category: "lint/test",
    location: { path: `src/f${index}.ts`, start: { line: index + 1, column: 1 } },
  })),
})

describe("buildPrompt", () => {
  test("embeds the diff verbatim when within the size limit", () => {
    const prompt = buildPrompt("+const x = 1", lintWith())

    expect(prompt).toContain("+const x = 1")
    expect(prompt).not.toContain("[diff truncated")
  })

  test("truncates oversized diffs and states how much was omitted", () => {
    const bigDiff = "+".repeat(30_000)
    const prompt = buildPrompt(bigDiff, lintWith())

    expect(prompt).toContain("[diff truncated — 6000 more characters omitted]")
    expect(prompt).not.toContain(bigDiff)
  })

  test("summarises lint diagnostics as review context", () => {
    const prompt = buildPrompt("+const x = 1", lintWith("noUnusedVariables"))

    expect(prompt).toContain("- [error] src/f0.ts:1 lint/test: noUnusedVariables")
  })

  test("states when there is no lint output", () => {
    const prompt = buildPrompt("+const x = 1", lintWith())

    expect(prompt).toContain("No lint issues reported.")
  })
})
