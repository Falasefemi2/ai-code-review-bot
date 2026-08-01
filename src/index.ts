import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { FetchHttpClient } from "effect/unstable/http"
import { AppConfigLive } from "./config.ts"
import { AiReviewer, AiReviewerLive } from "./services/AiReviewer.ts"
import { extractChangedFiles, GitDiff, GitDiffLive } from "./services/GitDiff.ts"
import { GithubReporter, GithubReporterLive } from "./services/GithubReporter.ts"
import { Linter, LinterLive } from "./services/Linter.ts"

const program = Effect.gen(function* () {
  const gitDiff = yield* GitDiff
  const linter = yield* Linter
  const aiReviewer = yield* AiReviewer
  const reporter = yield* GithubReporter

  const diff = yield* gitDiff.get
  const changedFiles = extractChangedFiles(diff)

  yield* Effect.log(`Reviewing ${changedFiles.length} changed file(s)`)

  const lint = yield* linter.check(changedFiles)
  const review = yield* aiReviewer.review({ diff, lint })

  yield* reporter.report(review)

  yield* Effect.log(
    `Posted review: ${review.findings.length} finding(s) (${lint.errorCount} lint errors, ${lint.warningCount} lint warnings)`,
  )
})

// Explicit composition: services that depend on AppConfig/HttpClient get them provided
const GitDiffWithDependencies = Layer.provide(GitDiffLive, Layer.merge(AppConfigLive, FetchHttpClient.layer))
const GithubReporterWithConfig = Layer.provide(GithubReporterLive, AppConfigLive)

const MainLive = Layer.mergeAll(GitDiffWithDependencies, LinterLive, AiReviewerLive, GithubReporterWithConfig)

const runnable = Effect.provide(program, MainLive)

Effect.runPromise(runnable).catch((error) => {
  console.error("Review bot failed:", error)
  process.exit(1)
})
