import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"

export class AppConfigError extends Schema.TaggedErrorClass<AppConfigError>()("AppConfigError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class EventConfigError extends Schema.TaggedErrorClass<EventConfigError>()("EventConfigError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// EventConfig is the event-shape-level config that does NOT require a PR
// number to be known. It is safe to build for both pull_request and push
// events, so services like PrLookup that need owner/repo/token but not a
// PR number can depend on it without a circular dependency on the (post-
// resolution) prNumber-bearing AppConfig.
interface EventConfigShape {
  readonly githubToken: Redacted.Redacted<string>
  readonly owner: string
  readonly repo: string
  readonly eventName: string
  // The branch a push event landed on. `null` for non-push events (where
  // GITHUB_EVENT_PATH carries pull_request.number directly).
  readonly branch: string | null
}

export class EventConfig extends Context.Service<EventConfig, EventConfigShape>()(
  "ai-code-review-bot/config/EventConfig",
) {}

// AppConfig is the downstream config — same as the original, but now the
// prNumber is injected by the composition layer rather than read directly
// from GITHUB_EVENT_PATH. This keeps pull_request-event behavior identical
// (index.ts reads prNumber from the event JSON and feeds it in) while
// allowing push events to resolve prNumber via the PrLookup service first.
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

// Read the branch from GITHUB_REF_NAME on push events. On pull_request
// events we don't need it (the event payload has the PR number), so we
// return null there.
const readBranch = Effect.fn("readBranch")(function* (eventName: string) {
  if (eventName !== "push") return null

  const refName = yield* Config.schema(Schema.String, "GITHUB_REF_NAME").pipe(
    Effect.mapError((cause) => new EventConfigError({ reason: "GITHUB_REF_NAME is required for push events", cause })),
  )
  return refName
})

const readEventPayloadConfig = Effect.fn("readEventPayloadConfig")(function* () {
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

const makeEventConfig = Effect.gen(function* () {
  const { githubToken, owner, repo, eventName, branch } = yield* readEventPayloadConfig()
  return { githubToken, owner, repo, eventName, branch }
})

export const EventConfigLive = Layer.effect(EventConfig, makeEventConfig)

// PullRequestNumberFromEvent reads the PR number straight out of the event
// payload — the original behavior for pull_request events. index.ts uses
// this for the pull_request branch and the push-with-no-PR-resolver path.
export const readPrNumberFromEvent = Effect.gen(function* () {
  const { eventPath } = yield* readEventPayloadConfig()
  return yield* readPullRequestNumber(eventPath)
})

// Holds the resolved pull-request number for the current run. index.ts
// (phase 1) writes it after resolving via the event payload (pull_request)
// or the GitHub API (push). AppConfig reads it so the downstream services
// (phase 2) build against the correct PR. Keeping this as a Ref avoids
// parameterizing AppConfig with a runtime number and lets every layer be
// composed statically up front.
interface PrNumberRefShape {
  readonly ref: Ref.Ref<Option.Option<number>>
}

export class PrNumberRef extends Context.Service<PrNumberRef, PrNumberRefShape>()(
  "ai-code-review-bot/config/PrNumberRef",
) {}

export const PrNumberRefLive: Layer.Layer<PrNumberRef> = Layer.effect(
  PrNumberRef,
  Effect.gen(function* () {
    return { ref: yield* Ref.make<Option.Option<number>>(Option.none()) }
  }),
)

// AppConfig's prNumber is not baked in at construction: it is read from the
// PrNumberRef at build time. This keeps the AppConfig layer free of any
// requirement on AppConfig/PrLookup, so it can be composed statically at the
// top of index.ts and the prNumber is resolved once, before phase 2 runs.
export const AppConfigLive = Layer.effect(
  AppConfig,
  Effect.gen(function* () {
    const { githubToken, owner, repo } = yield* EventConfig
    const { ref } = yield* PrNumberRef
    const prNumber = yield* Ref.get(ref)
    if (Option.isNone(prNumber)) {
      return yield* new AppConfigError({
        reason: "prNumber was not resolved before AppConfig was built — push/pull_request resolution failed",
      })
    }
    return { githubToken, owner, repo, prNumber: prNumber.value }
  }),
)
