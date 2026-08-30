import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

export class AppConfigError extends Schema.TaggedError<AppConfigError>()("AppConfigError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class EventConfigError extends Schema.TaggedError<EventConfigError>()("EventConfigError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class EventConfig extends Context.Service<
  EventConfig,
  {
    readonly githubToken: Redacted.Redacted<string>
    readonly owner: string
    readonly repo: string
    readonly eventName: string
    readonly branch: string | null
    readonly eventPath: string
  }
>()("ai-code-review-bot/config/EventConfig") {}

export class AppConfig extends Context.Service<
  AppConfig,
  {
    readonly githubToken: Redacted.Redacted<string>
    readonly owner: string
    readonly repo: string
    readonly prNumber: number
  }
>()("ai-code-review-bot/config/AppConfig") {}

const PullRequestEvent = Schema.Struct({
  pull_request: Schema.NullOr(Schema.Struct({ number: Schema.Number })),
})

const MISSING_PR_NUMBER =
  "GITHUB_EVENT_PATH payload has no pull_request.number — was this triggered by a pull_request event?"

export const readPullRequestNumber = Effect.fn("readPullRequestNumber")(function* (eventPath: string) {
  const raw: unknown = yield* Effect.tryPromise({
    try: () => Bun.file(eventPath).json(),
    catch: (cause) => new AppConfigError({ reason: `failed to read/parse event payload at ${eventPath}`, cause }),
  })

  const parsed = yield* Schema.decodeUnknownEffect(PullRequestEvent)(raw).pipe(
    Effect.mapError((cause) => new AppConfigError({ reason: MISSING_PR_NUMBER, cause })),
  )

  const prNumber = parsed.pull_request === null ? undefined : parsed.pull_request.number
  if (prNumber === undefined) {
    return yield* new AppConfigError({ reason: MISSING_PR_NUMBER })
  }

  return prNumber
})

const readBranch = Effect.fn("readBranch")(function* (eventName: string) {
  if (eventName !== "push") return null

  const refName = yield* Config.schema(Schema.String, "GITHUB_REF_NAME").pipe(
    Effect.mapError((cause) => new EventConfigError({ reason: "GITHUB_REF_NAME is required for push events", cause })),
  )
  return refName
})

const makeEventConfig = Effect.gen(function* () {
  const eventName = yield* Config.schema(Schema.String, "GITHUB_EVENT_NAME")
  const githubToken = yield* Config.schema(Schema.Redacted(Schema.String), "GITHUB_TOKEN")
  const repository = yield* Config.schema(Schema.String, "GITHUB_REPOSITORY")
  const eventPath = yield* Config.schema(Schema.String, "GITHUB_EVENT_PATH")

  const [owner, repo] = repository.split("/")
  if (!owner || !repo) {
    return yield* new EventConfigError({
      reason: `GITHUB_REPOSITORY was not in "owner/repo" form: "${repository}"`,
    })
  }

  const branch = yield* readBranch(eventName)

  return { githubToken, owner, repo, eventName, branch, eventPath }
})

export const EventConfigLive = Layer.effect(EventConfig, makeEventConfig)

export const makeAppConfig = Effect.fn("makeAppConfig")(function* (prNumber: number) {
  const { githubToken, owner, repo } = yield* EventConfig
  return { githubToken, owner, repo, prNumber }
})
