import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { HttpClientRequest } from "effect/unstable/http"
import { AppConfig } from "../config.ts"
import { expectSuccessful, GithubClient, readText } from "./GithubClient.ts"

export class GitDiff extends Context.Service<GitDiff>()("ai-code-review-bot/services/GitDiff", {
  make: Effect.gen(function* () {
    const github = yield* GithubClient
    const { owner, repo, prNumber } = yield* AppConfig

    const get = Effect.fn("GitDiff.get")(function* () {
      const request = HttpClientRequest.get(`/repos/${owner}/${repo}/pulls/${prNumber}`).pipe(
        HttpClientRequest.setHeader("Accept", "application/vnd.github.v3.diff"),
      )
      return yield* github.send(request).pipe(Effect.flatMap((response) => expectSuccessful(response, readText)))
    })

    return { get } as const
  }),
}) {
  static readonly Live = Layer.effect(this, this.make)
  static readonly layer = GitDiff.Live
}

export const GitDiffLive = GitDiff.Live

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
