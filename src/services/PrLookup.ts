import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { HttpClientRequest } from "effect/unstable/http"
import { EventConfig } from "../config.ts"
import { expectJson, GithubClient } from "./GithubClient.ts"

const Pull = Schema.Struct({ number: Schema.Finite })
const PullsResponse = Schema.Array(Pull)

export class PrLookup extends Context.Service<PrLookup>()("ai-code-review-bot/services/PrLookup", {
  make: Effect.gen(function* () {
    const github = yield* GithubClient
    const { owner, repo } = yield* EventConfig

    const findOpenPrForBranch = Effect.fn("PrLookup.findOpenPrForBranch")(function* (branch: string) {
      const pulls = yield* github
        .send(
          HttpClientRequest.get(`/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`),
        )
        .pipe(Effect.flatMap((response) => expectJson(response, PullsResponse)))

      return pulls[0] === undefined ? Option.none() : Option.some(pulls[0].number)
    })

    return { findOpenPrForBranch } as const
  }),
}) {
  static readonly Live = Layer.effect(this, this.make)
  static readonly layer = PrLookup.Live
}

export const PrLookupLive = PrLookup.Live
