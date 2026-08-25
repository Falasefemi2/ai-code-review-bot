import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { HttpBody, HttpClientRequest } from "effect/unstable/http"
import { AppConfig } from "../config.ts"
import type { ReviewOutput } from "./AiReviewer.ts"
import {
  expectJson,
  expectSuccessful,
  type GithubApiError,
  GithubClient,
  type GithubNetworkError,
  type GithubResponseError,
} from "./GithubClient.ts"

export class GithubReporter extends Context.Service<
  GithubReporter,
  {
    readonly report: (
      review: ReviewOutput,
    ) => Effect.Effect<void, GithubNetworkError | GithubApiError | GithubResponseError>
  }
>()("ai-code-review-bot/services/GithubReporter") {}

const MARKER = "<!-- ai-code-review-bot:comment -->"

const SEVERITY_EMOJI = {
  bug: "🐛",
  warning: "⚠️",
  suggestion: "💡",
} as const

export const formatBody = (review: ReviewOutput): string => {
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

const IssueComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
})
const IssueComments = Schema.Array(IssueComment)

export const GithubReporterLive = Layer.effect(
  GithubReporter,
  Effect.gen(function* () {
    const github = yield* GithubClient
    const { owner, repo, prNumber } = yield* AppConfig

    const findExistingComment = Effect.fn("GithubReporter.findExistingComment")(function* () {
      const comments = yield* github
        .send(HttpClientRequest.get(`/repos/${owner}/${repo}/issues/${prNumber}/comments`))
        .pipe(Effect.flatMap((response) => expectJson(response, IssueComments)))

      return comments.find((c) => c.body.startsWith(MARKER))
    })

    const report = Effect.fn("GithubReporter.report")(function* (review: ReviewOutput) {
      const existing = yield* findExistingComment()
      const request = existing
        ? HttpClientRequest.patch(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
            body: HttpBody.jsonUnsafe({ body: formatBody(review) }),
          })
        : HttpClientRequest.post(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
            body: HttpBody.jsonUnsafe({ body: formatBody(review) }),
          })

      yield* github.send(request).pipe(Effect.flatMap((response) => expectSuccessful(response, () => Effect.void)))
    })

    return GithubReporter.of({ report })
  }),
)
