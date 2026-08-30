import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { EventConfig } from "../config.ts"

export class GithubApiError extends Schema.TaggedError<GithubApiError>()("GithubApiError", {
  status: Schema.Finite,
  body: Schema.String,
}) {}

export class GithubNetworkError extends Schema.TaggedError<GithubNetworkError>()("GithubNetworkError", {
  cause: Schema.Defect(),
}) {}

export class GithubResponseError extends Schema.TaggedError<GithubResponseError>()("GithubResponseError", {
  cause: Schema.Defect(),
}) {}

export class GithubClient extends Context.Service<GithubClient>()("ai-code-review-bot/services/GithubClient", {
  make: Effect.gen(function* () {
    const { githubToken } = yield* EventConfig
    const baseClient = yield* HttpClient.HttpClient

    const client = baseClient.pipe(
      HttpClient.mapRequest(
        flow(
          HttpClientRequest.prependUrl("https://api.github.com"),
          HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(githubToken)}`),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
        ),
      ),
      HttpClient.retryTransient({
        schedule: Schedule.exponential("100 millis"),
        times: 3,
      }),
    )

    return {
      send: (request: HttpClientRequest.HttpClientRequest) =>
        client.execute(request).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) => new GithubNetworkError({ cause })),
        ),
    } as const
  }),
}) {
  static readonly Live = Layer.effect(this, this.make)
  static readonly layer = GithubClient.Live
}

export const GithubClientLive = GithubClient.Live

const REQUEST_TIMEOUT = "20 seconds"
const UNREADABLE_BODY = "<unreadable response body>"

export const readText = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<string, GithubNetworkError> =>
  response.text.pipe(Effect.mapError((cause) => new GithubNetworkError({ cause })))

export const expectSuccessful = <A, E extends GithubNetworkError | GithubResponseError>(
  response: HttpClientResponse.HttpClientResponse,
  onSuccess: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E>,
): Effect.Effect<A, E | GithubApiError | GithubNetworkError> =>
  HttpClientResponse.matchStatus(response, {
    "2xx": onSuccess,
    orElse: (res) => {
      const body = res.text.pipe(
        Effect.orElseSucceed(() => UNREADABLE_BODY),
        Effect.mapError((cause) => new GithubNetworkError({ cause })),
      )
      return Effect.flatMap(body, (text) => Effect.fail(new GithubApiError({ status: res.status, body: text })))
    },
  })

export const expectJson = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
): Effect.Effect<S["Type"], GithubNetworkError | GithubApiError | GithubResponseError> =>
  expectSuccessful(response, (res) =>
    res.json.pipe(
      Effect.mapError((cause) => new GithubResponseError({ cause })),
      Effect.flatMap((json) =>
        Effect.mapError(Schema.decodeUnknownEffect(schema)(json), (cause) => new GithubResponseError({ cause })),
      ),
    ),
  )
