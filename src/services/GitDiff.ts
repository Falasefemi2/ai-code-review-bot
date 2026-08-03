import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { flow } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AppConfig } from "../config.ts"

export class GitDiffFetchError extends Schema.TaggedErrorClass<GitDiffFetchError>()("GitDiffFetchError", {
  cause: Schema.Defect(),
}) {}

export class GitDiffApiError extends Schema.TaggedErrorClass<GitDiffApiError>()("GitDiffApiError", {
  status: Schema.Number,
  body: Schema.String,
}) {}

export interface GitDiffShape {
  readonly get: () => Effect.Effect<string, GitDiffFetchError | GitDiffApiError>
}

export class GitDiff extends Context.Service<GitDiff, GitDiffShape>()("ai-code-review-bot/services/GitDiff") {}

export const GitDiffLive = Layer.effect(
  GitDiff,
  Effect.gen(function* () {
    const { githubToken, owner, repo, prNumber } = yield* AppConfig
    const baseClient = yield* HttpClient.HttpClient

    const client = baseClient.pipe(
      HttpClient.mapRequest(
        flow(
          HttpClientRequest.prependUrl("https://api.github.com"),
          HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(githubToken)}`),
          HttpClientRequest.setHeader("Accept", "application/vnd.github.v3.diff"),
          HttpClientRequest.setHeader("X-GitHub-Api-Version", "2022-11-28"),
        ),
      ),
      HttpClient.retryTransient({
        schedule: Schedule.exponential("100 millis"),
        times: 3,
      }),
    )

    const get = Effect.fn("GitDiff.get")(function* () {
      return yield* client.get(`/repos/${owner}/${repo}/pulls/${prNumber}`).pipe(
        Effect.flatMap((response) =>
          HttpClientResponse.matchStatus(response, {
            "2xx": (res) => res.text,
            orElse: (res) =>
              res.text.pipe(
                Effect.orElseSucceed(() => "<unreadable response body>"),
                Effect.flatMap((body) =>
                  Effect.fail(
                    new GitDiffApiError({
                      status: res.status,
                      body,
                    }),
                  ),
                ),
              ),
          }),
        ),
        Effect.mapError((cause) => (cause._tag === "GitDiffApiError" ? cause : new GitDiffFetchError({ cause }))),
      )
    })

    return GitDiff.of({ get })
  }),
)

export const extractChangedFiles = (diff: string): ReadonlyArray<string> => {
  const paths: string[] = []

  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue

    const path = line.slice(4).trim()

    if (path === "/dev/null") continue

    paths.push(path.startsWith("b/") ? path.slice(2) : path)
  }

  return paths
}
