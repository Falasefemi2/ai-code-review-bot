import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export class LinterSpawnError extends Schema.TaggedError<LinterSpawnError>()("LinterSpawnError", {
  cause: Schema.Defect(),
}) {}

export class LinterOutputError extends Schema.TaggedError<LinterOutputError>()("LinterOutputError", {
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

const decodeReport = Schema.decodeUnknownEffect(BiomeReport)

const check = Effect.fn("Linter.check")(function* (paths: ReadonlyArray<string>) {
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

  const stderr = yield* Effect.tryPromise({
    try: () => new Response(proc.stderr).text(),
    catch: () => "",
  }).pipe(Effect.orElseSucceed(() => ""))

  const exitCode = yield* Effect.tryPromise({
    try: () => proc.exited,
    catch: (cause) => new LinterSpawnError({ cause }),
  })

  // biome exits 0 (clean) or 1 (diagnostics reported); anything else is a real failure.
  if (exitCode >= 2) {
    return yield* new LinterOutputError({
      stdout,
      cause: `biome exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
    })
  }

  const parsed: unknown = yield* Effect.try({
    try: () => JSON.parse(stdout),
    catch: (cause) => new LinterOutputError({ stdout, cause }),
  })

  const report = yield* decodeReport(parsed).pipe(Effect.mapError((cause) => new LinterOutputError({ stdout, cause })))

  return {
    errorCount: report.summary.errors,
    warningCount: report.summary.warnings,
    diagnostics: report.diagnostics,
  }
})

export class Linter extends Context.Service<Linter>()("ai-code-review-bot/services/Linter", {
  make: Effect.succeed({ check } as const),
}) {
  static readonly Live = Layer.effect(this, this.make)
  static readonly layer = Linter.Live
}

export const LinterLive = Linter.Live
