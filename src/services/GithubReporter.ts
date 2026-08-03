import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
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

export interface GithubReporterShape {
  readonly report: (review: ReviewOutput) => Effect.Effect<void, ReporterError>
}

export class GithubReporter extends Context.Service<GithubReporter, GithubReporterShape>()(
  "ai-code-review-bot/services/GithubReporter",
) {}

const MARKER = "<!-- ai-code-review-bot:comment -->"

const SEVERITY_EMOJI: Record<ReviewOutput["findings"][number]["severity"], string> = {
  bug: "🐛",
  warning: "⚠️",
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

const IssueComment = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
})
const IssueComments = Schema.Array(IssueComment)
const decodeComments = Schema.decodeUnknownEffect(IssueComments)

export const GithubReporterLive = Layer.effect(
  GithubReporter,
  Effect.gen(function* () {
    const { githubToken, owner, repo, prNumber } = yield* AppConfig
    const baseClient = yield* HttpClient.HttpClient

    const client = baseClient.pipe(
      HttpClient.mapRequest(
        flow(
          HttpClientRequest.prependUrl("https://api.github.com"),
          HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(githubToken)}`),
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          HttpClientRequest.setHeader("Content-Type", "application/json"),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
        ),
      ),
      HttpClient.retryTransient({
        schedule: Schedule.exponential("100 millis"),
        times: 3,
      }),
    )

    const findExistingComment = Effect.fn("GithubReporter.findExistingComment")(function* () {
      const response = yield* client.get(`/repos/${owner}/${repo}/issues/${prNumber}/comments`).pipe(
        Effect.flatMap((res) =>
          HttpClientResponse.matchStatus(res, {
            "2xx": (res2) =>
              res2.json.pipe(
                Effect.flatMap(decodeComments),
                Effect.mapError((cause) => new GithubReporterFetchError({ cause })),
              ),
            orElse: (res2) =>
              res2.text.pipe(
                Effect.orElseSucceed(() => "<unreadable response body>"),
                Effect.flatMap((body) =>
                  Effect.fail<GithubReporterApiError>(new GithubReporterApiError({ status: res2.status, body })),
                ),
              ),
          }),
        ),
        Effect.mapError((cause) =>
          cause._tag === "GithubReporterApiError" ? cause : new GithubReporterFetchError({ cause }),
        ),
      )

      return response.find((c) => c.body.startsWith(MARKER))
    })

    const report = Effect.fn("GithubReporter.report")(function* (review: ReviewOutput) {
      const bodyText = formatBody(review)
      const existing = yield* findExistingComment()

      if (existing) {
        yield* client
          .patch(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
            body: HttpBody.jsonUnsafe({ body: bodyText }),
          })
          .pipe(
            Effect.flatMap((res) =>
              HttpClientResponse.matchStatus(res, {
                "2xx": () => Effect.void,
                orElse: (res2) =>
                  res2.text.pipe(
                    Effect.orElseSucceed(() => "<unreadable response body>"),
                    Effect.flatMap((body) =>
                      Effect.fail<GithubReporterApiError>(new GithubReporterApiError({ status: res2.status, body })),
                    ),
                  ),
              }),
            ),
            Effect.mapError((cause) =>
              cause._tag === "GithubReporterApiError" ? cause : new GithubReporterFetchError({ cause }),
            ),
          )
      } else {
        yield* client
          .post(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
            body: HttpBody.jsonUnsafe({ body: bodyText }),
          })
          .pipe(
            Effect.flatMap((res) =>
              HttpClientResponse.matchStatus(res, {
                "2xx": () => Effect.void,
                orElse: (res2) =>
                  res2.text.pipe(
                    Effect.orElseSucceed(() => "<unreadable response body>"),
                    Effect.flatMap((body) =>
                      Effect.fail<GithubReporterApiError>(new GithubReporterApiError({ status: res2.status, body })),
                    ),
                  ),
              }),
            ),
            Effect.mapError((cause) =>
              cause._tag === "GithubReporterApiError" ? cause : new GithubReporterFetchError({ cause }),
            ),
          )
      }
    })

    return GithubReporter.of({ report })
  }),
)
