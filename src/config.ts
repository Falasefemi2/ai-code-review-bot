import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export class AppConfigError extends Schema.TaggedErrorClass<AppConfigError>()("AppConfigError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

interface AppConfigShape {
  readonly githubToken: Redacted.Redacted<string>
  readonly owner: string
  readonly repo: string
  readonly prNumber: number
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("ai-code-review-bot/config/AppConfig") {}

const readPullRequestNumber = Effect.fn("readPullRequestNumber")(function* (eventPath: string) {
  const event = yield* Effect.tryPromise({
    try: async () => {
      const file = Bun.file(eventPath)
      return (await file.json()) as { pull_request?: { number?: number } }
    },
    catch: (cause) => new AppConfigError({ reason: `failed to read/parse event payload at ${eventPath}`, cause }),
  })

  const prNumber = event.pull_request?.number
  if (prNumber === undefined) {
    return yield* new AppConfigError({
      reason: "GITHUB_EVENT_PATH payload has no pull_request.number — was this triggered by a pull_request event?",
    })
  }

  return prNumber
})

const make = Effect.gen(function* () {
  const githubToken = yield* Config.schema(Schema.Redacted(Schema.String), "GITHUB_TOKEN")
  const repository = yield* Config.schema(Schema.String, "GITHUB_REPOSITORY")
  const eventPath = yield* Config.schema(Schema.String, "GITHUB_EVENT_PATH")

  const [owner, repo] = repository.split("/")
  if (!owner || !repo) {
    return yield* new AppConfigError({
      reason: `GITHUB_REPOSITORY was not in "owner/repo" form: "${repository}"`,
    })
  }

  const prNumber = yield* readPullRequestNumber(eventPath)

  return { githubToken, owner, repo, prNumber }
})

export const AppConfigLive = Layer.effect(AppConfig, make)
