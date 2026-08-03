import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { EventConfig } from "../config.ts"

export class PrLookupFetchError extends Schema.TaggedErrorClass<PrLookupFetchError>()("PrLookupFetchError", {
  cause: Schema.Defect(),
}) {}

export class PrLookupApiError extends Schema.TaggedErrorClass<PrLookupApiError>()("PrLookupApiError", {
  status: Schema.Number,
  body: Schema.String,
}) {}

type PrLookupError = PrLookupFetchError | PrLookupApiError

const Pull = Schema.Struct({ number: Schema.Number })
const PullsResponse = Schema.Array(Pull)
const decodePulls = Schema.decodeUnknownEffect(PullsResponse)

interface PrLookupShape {
  readonly findOpenPrForBranch: (branch: string) => Effect.Effect<Option.Option<number>, PrLookupError>
}

export class PrLookup extends Context.Service<PrLookup, PrLookupShape>()("ai-code-review-bot/services/PrLookup") {}

const make = Effect.gen(function* () {
  const { githubToken, owner, repo } = yield* EventConfig

  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl("https://api.github.com"),
        HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(githubToken)}`),
        HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
        HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
      ),
    ),
    HttpClient.retryTransient({
      schedule: Schedule.exponential("100 millis"),
      times: 3,
    }),
  )

  const findOpenPrForBranch = (branch: string): Effect.Effect<Option.Option<number>, PrLookupError> =>
    client.get(`/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`).pipe(
      Effect.flatMap((response) =>
        HttpClientResponse.matchStatus(response, {
          "2xx": () =>
            response.json.pipe(
              Effect.flatMap((json) =>
                decodePulls(json).pipe(
                  Effect.map((pulls) => (pulls[0] === undefined ? Option.none() : Option.some(pulls[0].number))),
                ),
              ),
              Effect.mapError((cause) => new PrLookupFetchError({ cause })),
            ),
          orElse: (response) =>
            response.text.pipe(
              Effect.orElseSucceed(() => "<unreadable response body>"),
              Effect.flatMap((body) =>
                Effect.fail<PrLookupApiError>(new PrLookupApiError({ status: response.status, body })),
              ),
            ),
        }),
      ),
      Effect.mapError((cause) =>
        cause._tag === "PrLookupApiError" || cause._tag === "PrLookupFetchError"
          ? cause
          : new PrLookupFetchError({ cause }),
      ),
    )

  return { findOpenPrForBranch }
})

export const PrLookupLive = Layer.effect(PrLookup, make)
