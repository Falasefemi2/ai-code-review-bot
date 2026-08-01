import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export class LinterSpawnError extends Schema.TaggedErrorClass<LinterSpawnError>()("LinterSpawnError", {
  cause: Schema.Defect(),
}) {}

export class LinterOutputError extends Schema.TaggedErrorClass<LinterOutputError>()("LinterOutputError", {
  stdout: Schema.String,
  cause: Schema.Defect(),
}) {}

const BiomeDiagnostic = Schema.Struct({
  severity: Schema.String,
  message: Schema.String,
  category: Schema.String,
  location: Schema.Struct({
    path: Schema.String,
    start: Schema.Struct({
      line: Schema.Number,
      column: Schema.Number,
    }),
  }),
})

const BiomeReport = Schema.Struct({
  summary: Schema.Struct({
    errors: Schema.Number,
    warnings: Schema.Number,
  }),
  diagnostics: Schema.Array(BiomeDiagnostic),
})

export type LintDiagnostic = typeof BiomeDiagnostic.Type

export interface LintResult {
  readonly errorCount: number
  readonly warningCount: number
  readonly diagnostics: ReadonlyArray<LintDiagnostic>
}

interface LinterShape {
  readonly check: (paths: ReadonlyArray<string>) => Effect.Effect<LintResult, LinterSpawnError | LinterOutputError>
}

export class Linter extends Context.Service<Linter, LinterShape>()("ai-code-review-bot/services/Linter") {}

const decodeReport = Schema.decodeUnknownEffect(BiomeReport)

const check = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (paths.length === 0) {
      return { errorCount: 0, warningCount: 0, diagnostics: [] }
    }

    const proc = yield* Effect.try({
      try: () =>
        Bun.spawn(["biome", "check", "--reporter=json", ...paths], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (cause) => new LinterSpawnError({ cause }),
    })

    const stdout = yield* Effect.tryPromise({
      try: () => new Response(proc.stdout).text(),
      catch: (cause) => new LinterSpawnError({ cause }),
    })

    // Non-zero exit is expected whenever Biome finds issues — that's not a
    // process failure, so we don't inspect the exit code at all. We just
    // need the process to have finished before trusting stdout is complete.
    yield* Effect.tryPromise({
      try: () => proc.exited,
      catch: (cause) => new LinterSpawnError({ cause }),
    })

    const parsed = yield* Effect.try({
      try: () => JSON.parse(stdout) as unknown,
      catch: (cause) => new LinterOutputError({ stdout, cause }),
    })

    const report = yield* decodeReport(parsed).pipe(
      Effect.mapError((cause) => new LinterOutputError({ stdout, cause })),
    )

    return {
      errorCount: report.summary.errors,
      warningCount: report.summary.warnings,
      diagnostics: report.diagnostics,
    }
  })

export const LinterLive = Layer.succeed(Linter, { check })
