import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { AppConfig } from "../config.ts"
import type { ReviewOutput } from "./AiReviewer.ts"

export class GithubReporterFetchError extends Schema.TaggedErrorClass<GithubReporterFetchError>()(
  "GithubReporterFetchError",
  {
    cause: Schema.Defect(),
  },
) {}

export class GithubReporterApiError extends Schema.TaggedErrorClass<GithubReporterApiError>()(
  "GithubReporterApiError",
  {
    status: Schema.Number,
    body: Schema.String,
  },
) {}

type ReporterError = GithubReporterFetchError | GithubReporterApiError

interface GithubReporterShape {
  readonly report: (review: ReviewOutput) => Effect.Effect<void, ReporterError>
}

export class GithubReporter extends Context.Service<GithubReporter, GithubReporterShape>()(
  "ai-code-review-bot/services/GithubReporter",
) {}

// Hidden marker so subsequent runs on the same PR find and update this
// comment instead of posting a new one on every push.
const MARKER = "<!-- ai-code-review-bot:comment -->"

const SEVERITY_EMOJI: Record<ReviewOutput["findings"][number]["severity"], string> = {
  bug: "🐛",
  warning: "!",
  suggestion: "💡",
}

const formatBody = (review: ReviewOutput): string => {
  const lines = [MARKER, "## 🤖 AI Code Review", "", review.summary]

  if (review.findings.length > 0) {
    lines.push("", "### Findings", "")
    for (const finding of review.findings) {
      const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`
      lines.push(`- ${SEVERITY_EMOJI[finding.severity]} **${location}** — ${finding.comment}`)
    }
  }

  return lines.join("\n")
}

interface IssueComment {
  readonly id: number
  readonly body: string
}

const make = Effect.gen(function* () {
  const { githubToken, owner, repo, prNumber } = yield* AppConfig

  const headers = {
    Authorization: `Bearer ${Redacted.value(githubToken)}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  }

  const commentsUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`

  const request = (url: string, init: RequestInit): Effect.Effect<{ status: number; json: unknown }, ReporterError> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) => fetch(url, { ...init, headers, signal }),
        catch: (cause) => new GithubReporterFetchError({ cause }),
      })

      if (!response.ok) {
        const body = yield* Effect.tryPromise(() => response.text()).pipe(
          Effect.orElseSucceed(() => "<unreadable response body>"),
        )
        return yield* new GithubReporterApiError({ status: response.status, body })
      }

      // 204 No Content (e.g. some update paths) has no body to parse.
      if (response.status === 204) return { status: response.status, json: null }

      const json = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: (cause) => new GithubReporterFetchError({ cause }),
      })
      return { status: response.status, json }
    })

  const findExistingComment = Effect.gen(function* () {
    // First page only (30 comments) — a PR with a long-running bot comment
    // buried past page 1 is an edge case we accept for v1.
    const { json } = yield* request(commentsUrl, { method: "GET" })
    const comments = json as ReadonlyArray<IssueComment>
    return comments.find((c) => c.body.startsWith(MARKER))
  })

  const report = (review: ReviewOutput) =>
    Effect.gen(function* () {
      const body = formatBody(review)
      const existing = yield* findExistingComment

      if (existing) {
        yield* request(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        })
      } else {
        yield* request(commentsUrl, {
          method: "POST",
          body: JSON.stringify({ body }),
        })
      }
    })

  return { report }
})

export const GithubReporterLive = Layer.effect(GithubReporter, make)
