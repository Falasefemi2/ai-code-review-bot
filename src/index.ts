import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { FetchHttpClient } from "effect/unstable/http"
import { AppConfig, EventConfig, EventConfigLive, makeAppConfig, readPrNumberFromEvent } from "./config.ts"
import { AiReviewer, AiReviewerLive } from "./services/AiReviewer.ts"
import { extractChangedFiles, GitDiff, GitDiffLive } from "./services/GitDiff.ts"
import { GithubReporter, GithubReporterLive } from "./services/GithubReporter.ts"
import { Linter, LinterLive } from "./services/Linter.ts"
import { PrLookup, PrLookupLive } from "./services/PrLookup.ts"

const DEFAULT_BRANCHES = new Set(["main", "master"])

// ---------------------------------------------------------------------------
// Phase 1: resolve which PR we are reviewing (Option), or bail out cleanly.
// ---------------------------------------------------------------------------
const resolvePullRequestNumber = Effect.fn("resolvePullRequestNumber")(function* () {
  const { eventName, branch } = yield* EventConfig

  if (eventName === "pull_request") {
    const prNumber = yield* readPrNumberFromEvent()
    return Option.some(prNumber)
  }

  if (eventName === "push") {
    if (branch === null) {
      yield* Effect.log("Skipping review — push event had no GITHUB_REF_NAME.")
      return Option.none()
    }
    if (DEFAULT_BRANCHES.has(branch)) {
      yield* Effect.log(`Skipping review — push was to default branch "${branch}".`)
      return Option.none()
    }

    const prLookup = yield* PrLookup
    const maybeNumber = yield* prLookup
      .findOpenPrForBranch(branch)
      .pipe(
        Effect.catchTag("PrLookupApiError", (e) =>
          Effect.log(`GitHub API error while looking up PR for branch "${branch}": ${e.status} ${e.body}`).pipe(
            Effect.andThen(Effect.fail(e)),
          ),
        ),
      )
    if (Option.isNone(maybeNumber)) {
      yield* Effect.log("no open PR for this branch, skipping")
    }
    return maybeNumber
  }

  yield* Effect.log(`Skipping review — triggering event "${eventName}" is neither pull_request nor push.`)
  return Option.none()
})

// ---------------------------------------------------------------------------
// Phase 2: run the actual review against the resolved prNumber.
// ---------------------------------------------------------------------------
const runReview = Effect.fn("runReview")(function* () {
  const gitDiff = yield* GitDiff
  const linter = yield* Linter
  const aiReviewer = yield* AiReviewer
  const reporter = yield* GithubReporter

  const diff = yield* gitDiff.get()
  const changedFiles = extractChangedFiles(diff)

  yield* Effect.log(`Reviewing ${changedFiles.length} changed file(s)`)

  const lint = yield* linter.check(changedFiles)
  const review = yield* aiReviewer.review({ diff, lint })

  yield* reporter.report(review)

  yield* Effect.log(
    `Posted review: ${review.findings.length} finding(s) (${lint.errorCount} lint errors, ${lint.warningCount} lint warnings)`,
  )
})

// ---------------------------------------------------------------------------
// Orchestration: resolve the PR number, dynamically build the AppConfig layer,
// then execute phase 2 cleanly without mutable global state.
// ---------------------------------------------------------------------------
const program = Effect.fn("program")(function* () {
  const maybePrNumber = yield* resolvePullRequestNumber()

  if (Option.isNone(maybePrNumber)) {
    return
  }

  const prNumber = maybePrNumber.value
  const appConfig = yield* makeAppConfig(prNumber)
  const AppConfigLive = Layer.succeed(AppConfig, appConfig)

  const ReviewServices = Layer.mergeAll(GitDiffLive, LinterLive, AiReviewerLive, GithubReporterLive).pipe(
    Layer.provide(AppConfigLive),
    Layer.provide(FetchHttpClient.layer),
  )

  yield* runReview().pipe(Effect.provide(ReviewServices))
})

// Composition for Phase 1 dependencies: EventConfig, PrLookup, HttpClient.
const Phase1Services = Layer.mergeAll(EventConfigLive, PrLookupLive).pipe(Layer.provide(FetchHttpClient.layer))

const runnable = program().pipe(Effect.provide(Phase1Services))

Effect.runPromise(runnable).catch((error) => {
  console.error("Review bot failed:", error)
  process.exit(1)
})
