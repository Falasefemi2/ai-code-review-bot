import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { HttpClientRequest } from "effect/unstable/http"
import { EventConfig } from "../config.ts"
import {
  expectJson,
  type GithubApiError,
  GithubClient,
  type GithubNetworkError,
  type GithubResponseError,
} from "./GithubClient.ts"

const Pull = Schema.Struct({ number: Schema.Number })
const PullsResponse = Schema.Array(Pull)

export class PrLookup extends Context.Service<
  PrLookup,
  {
    readonly findOpenPrForBranch: (
      branch: string,
    ) => Effect.Effect<Option.Option<number>, GithubNetworkError | GithubApiError | GithubResponseError>
  }
>()("ai-code-review-bot/services/PrLookup") {}

export const PrLookupLive = Layer.effect(
  PrLookup,
  Effect.gen(function* () {
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

    return PrLookup.of({ findOpenPrForBranch })
  }),
)
