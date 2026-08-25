import { describe, expect, test } from "bun:test"
import { extractChangedFiles } from "./GitDiff.ts"

describe("extractChangedFiles", () => {
  test("collects paths from +++ lines, stripping the b/ prefix", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "+export const x = 1",
    ].join("\n")

    expect(extractChangedFiles(diff)).toEqual(["src/a.ts"])
  })

  test("skips /dev/null entries", () => {
    const diff = ["+++ /dev/null", "+++ b/src/new.ts"].join("\n")

    expect(extractChangedFiles(diff)).toEqual(["src/new.ts"])
  })

  test("preserves file order", () => {
    const diff = ["+++ b/a.ts", "+++ b/src/b.ts", "+++ b/README.md"].join("\n")

    expect(extractChangedFiles(diff)).toEqual(["a.ts", "src/b.ts", "README.md"])
  })

  test("returns an empty list for an empty diff", () => {
    expect(extractChangedFiles("")).toEqual([])
  })
})
