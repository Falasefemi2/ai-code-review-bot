import { describe, expect, test } from "bun:test"
import type { ReviewOutput } from "./AiReviewer.ts"
import { formatBody } from "./GithubReporter.ts"

const review = (findings: ReviewOutput["findings"], summary = "Looks good"): ReviewOutput => ({
  summary,
  findings,
})

describe("formatBody", () => {
  test("starts with the marker so previous comments can be found on re-run", () => {
    const body = formatBody(review([]))

    expect(body.startsWith("<!-- ai-code-review-bot:comment -->")).toBe(true)
  })

  test("renders the summary without a Findings section when nothing was flagged", () => {
    const body = formatBody(review([], "All clear"))

    expect(body).toContain("All clear")
    expect(body).not.toContain("### Findings")
  })

  test("formats file:line locations with a severity emoji", () => {
    const body = formatBody(review([{ file: "src/a.ts", line: 12, severity: "bug", comment: "off-by-one" }]))

    expect(body).toContain("- 🐛 **src/a.ts:12** — off-by-one")
  })

  test("drops the line number for file-level findings", () => {
    const body = formatBody(review([{ file: "src/a.ts", line: null, severity: "suggestion", comment: "rename" }]))

    expect(body).toContain("- 💡 **src/a.ts** — rename")
  })

  test("maps every severity to its emoji", () => {
    const body = formatBody(
      review([
        { file: "a.ts", line: 1, severity: "bug", comment: "b" },
        { file: "b.ts", line: 2, severity: "warning", comment: "w" },
        { file: "c.ts", line: 3, severity: "suggestion", comment: "s" },
      ]),
    )

    expect(body).toContain("🐛")
    expect(body).toContain("⚠️")
    expect(body).toContain("💡")
  })
})
