import * as Context from "effect/Context"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
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

interface AiReviewerShape {
  readonly review: (input: {
    readonly diff: string
    readonly lint: LintResult
  }) => Effect.Effect<
    ReviewOutput,
    AiReviewerFetchError | AiReviewerRateLimitError | AiReviewerApiError | AiReviewerOutputError
  >
}

export class AiReviewer extends Context.Service<AiReviewer, AiReviewerShape>()(
  "ai-code-review-bot/services/AiReviewer",
) {}

const MODEL = "openai/gpt-oss-120b"
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

// Groq's free tier has a token budget per request/minute; a very large diff
// risks a 413 or throttling before it risks the model actually going off
// the rails. Truncate defensively — this is a blunt instrument, flag if you
// want per-hunk chunking + multiple calls instead.
const MAX_DIFF_CHARS = 24_000

const buildPrompt = (diff: string, lint: LintResult) => {
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

const make = Effect.gen(function* () {
  const apiKey = yield* Config.schema(Schema.Redacted(Schema.String), "GROQ_API_KEY")

  const callGroq = (diff: string, lint: LintResult) =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(GROQ_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Redacted.value(apiKey)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: MODEL,
              temperature: 0.2,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: buildPrompt(diff, lint) },
              ],
            }),
            signal,
          }),
        catch: (cause) => new AiReviewerFetchError({ cause }),
      })

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("retry-after")
        const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined
        return yield* new AiReviewerRateLimitError({
          retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
        })
      }

      if (!response.ok) {
        const body = yield* Effect.tryPromise(() => response.text()).pipe(
          Effect.orElseSucceed(() => "<unreadable response body>"),
        )
        return yield* new AiReviewerApiError({ status: response.status, body })
      }

      const json = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: (cause) => new AiReviewerFetchError({ cause }),
      })

      const parsed = yield* decodeGroqResponse(json).pipe(
        Effect.mapError((cause) => new AiReviewerOutputError({ raw: JSON.stringify(json), cause })),
      )

      const content = parsed.choices[0]?.message.content
      if (content === undefined) {
        return yield* new AiReviewerOutputError({
          raw: JSON.stringify(json),
          cause: "no choices returned",
        })
      }

      const contentJson = yield* Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: (cause) => new AiReviewerOutputError({ raw: content, cause }),
      })

      return yield* decodeReviewOutput(contentJson).pipe(
        Effect.mapError((cause) => new AiReviewerOutputError({ raw: content, cause })),
      )
    })

  const review: AiReviewerShape["review"] = ({ diff, lint }) =>
    callGroq(diff, lint).pipe(
      Effect.retry({
        schedule: Schedule.exponential("1 second"),
        times: 3,
        while: (e) => e._tag === "AiReviewerRateLimitError",
      }),
    )

  return { review }
})

export const AiReviewerLive = Layer.effect(AiReviewer, make)
