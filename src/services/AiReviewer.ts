import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { Headers, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { LintResult } from "./Linter.ts"

export class AiReviewerFetchError extends Schema.TaggedErrorClass<AiReviewerFetchError>()("AiReviewerFetchError", {
  cause: Schema.Defect(),
}) {}

export class AiReviewerRateLimitError extends Schema.TaggedErrorClass<AiReviewerRateLimitError>()(
  "AiReviewerRateLimitError",
  {
    retryAfterSeconds: Schema.optional(Schema.Number),
  },
) {}

export class AiReviewerApiError extends Schema.TaggedErrorClass<AiReviewerApiError>()("AiReviewerApiError", {
  status: Schema.Number,
  body: Schema.String,
}) {}

export class AiReviewerConfigError extends Schema.TaggedErrorClass<AiReviewerConfigError>()("AiReviewerConfigError", {
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}

export class AiReviewerOutputError extends Schema.TaggedErrorClass<AiReviewerOutputError>()("AiReviewerOutputError", {
  raw: Schema.String,
  cause: Schema.Defect(),
}) {}

const Finding = Schema.Struct({
  file: Schema.String,
  line: Schema.NullOr(Schema.Number),
  severity: Schema.Literals(["bug", "warning", "suggestion"]),
  comment: Schema.String,
})

const ReviewOutput = Schema.Struct({
  summary: Schema.String,
  findings: Schema.Array(Finding),
})

export type Finding = typeof Finding.Type
export type ReviewOutput = typeof ReviewOutput.Type

const decodeReviewOutput = Schema.decodeUnknownEffect(ReviewOutput)

const GroqChatResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.String }),
    }),
  ),
})

const decodeGroqResponse = Schema.decodeUnknownEffect(GroqChatResponse)

export class AiReviewer extends Context.Service<
  AiReviewer,
  {
    readonly review: (input: {
      readonly diff: string
      readonly lint: LintResult
    }) => Effect.Effect<
      ReviewOutput,
      AiReviewerFetchError | AiReviewerRateLimitError | AiReviewerApiError | AiReviewerOutputError
    >
  }
>()("ai-code-review-bot/services/AiReviewer") {}

const MODEL = "openai/gpt-oss-120b"
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
const MAX_DIFF_CHARS = 24_000
const GROQ_TIMEOUT = "60 seconds"

export const buildPrompt = (diff: string, lint: LintResult): string => {
  const truncatedDiff =
    diff.length > MAX_DIFF_CHARS
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated — ${diff.length - MAX_DIFF_CHARS} more characters omitted]`
      : diff

  const lintSummary =
    lint.diagnostics.length === 0
      ? "No lint issues reported."
      : lint.diagnostics
          .map((d) => `- [${d.severity}] ${d.location.path}:${d.location.start.line} ${d.category}: ${d.message}`)
          .join("\n")

  return [
    "Review this pull request diff for bugs, correctness issues, and risky patterns.",
    "Use the linter output as supporting context, but do not simply restate lint findings as your own — focus on things static linting cannot catch (logic errors, edge cases, race conditions, security issues).",
    "",
    "## Linter output",
    lintSummary,
    "",
    "## Diff",
    "```diff",
    truncatedDiff,
    "```",
  ].join("\n")
}

const SYSTEM_PROMPT = [
  "You are a senior engineer performing a pull request code review.",
  'Respond with ONLY a JSON object matching this shape, no prose outside the JSON: { "summary": string, "findings": [{ "file": string, "line": number | null, "severity": "bug" | "warning" | "suggestion", "comment": string }] }.',
  "If you find nothing worth flagging, return an empty findings array and a short positive summary.",
  "Be specific and reference exact file paths from the diff. Do not invent file paths.",
].join(" ")

const MAX_RETRIES = 3

const reviewWithRetries = (
  client: HttpClient.HttpClient,
  input: { readonly diff: string; readonly lint: LintResult },
  attemptsLeft: number,
): ReturnType<typeof callGroq> =>
  callGroq(client, input.diff, input.lint).pipe(
    Effect.catchTag("AiReviewerRateLimitError", (error) => {
      if (attemptsLeft <= 0) return Effect.fail(error)
      const delaySeconds = error.retryAfterSeconds ?? 2 ** (MAX_RETRIES - attemptsLeft)
      return Effect.sleep(Duration.seconds(delaySeconds)).pipe(
        Effect.andThen(reviewWithRetries(client, input, attemptsLeft - 1)),
      )
    }),
  )

const callGroq = Effect.fn("AiReviewer.callGroq")(function* (
  client: HttpClient.HttpClient,
  diff: string,
  lint: LintResult,
) {
  const response = yield* client
    .execute(
      HttpClientRequest.post(GROQ_URL, {
        body: HttpBody.jsonUnsafe({
          model: MODEL,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildPrompt(diff, lint) },
          ],
        }),
      }),
    )
    .pipe(
      Effect.timeout(GROQ_TIMEOUT),
      Effect.mapError((cause) => new AiReviewerFetchError({ cause })),
    )

  if (response.status === 429) {
    const decodeSeconds = Schema.decodeUnknownOption(Schema.Number)
    const retryAfterSeconds = Headers.get(response.headers, "retry-after").pipe(
      Option.flatMap(decodeSeconds),
      Option.getOrUndefined,
    )
    return yield* new AiReviewerRateLimitError({ retryAfterSeconds })
  }

  if (Math.floor(response.status / 100) !== 2) {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => "<unreadable response body>"))
    return yield* new AiReviewerApiError({ status: response.status, body })
  }

  const json = yield* response.json.pipe(Effect.mapError((cause) => new AiReviewerFetchError({ cause })))
  const parsed = yield* decodeGroqResponse(json).pipe(
    Effect.mapError(
      (cause) =>
        new AiReviewerOutputError({
          raw: JSON.stringify(json),
          cause,
        }),
    ),
  )

  const content = parsed.choices[0]?.message.content
  if (content === undefined) {
    return yield* new AiReviewerOutputError({
      raw: JSON.stringify(parsed),
      cause: "no choices returned",
    })
  }

  const contentJson: unknown = JSON.parse(content)

  return yield* decodeReviewOutput(contentJson).pipe(
    Effect.mapError((cause) => new AiReviewerOutputError({ raw: content, cause })),
  )
})

export const AiReviewerLive = Layer.effect(
  AiReviewer,
  Effect.gen(function* () {
    const apiKey = yield* Config.schema(Schema.Redacted(Schema.String), "GROQ_API_KEY").pipe(
      Effect.mapError(
        (cause) =>
          new AiReviewerConfigError({
            reason:
              "GROQ_API_KEY is not set or is empty. Add it as a repository secret in the CALLER repo (e.g. easyrent-fe > Settings > Secrets and variables > Actions).",
            cause,
          }),
      ),
    )
    const baseClient = yield* HttpClient.HttpClient

    const client = baseClient.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(apiKey))))

    const review = Effect.fn("AiReviewer.review")(function* (input: {
      readonly diff: string
      readonly lint: LintResult
    }) {
      return yield* reviewWithRetries(client, input, MAX_RETRIES)
    })

    return AiReviewer.of({ review })
  }),
)
