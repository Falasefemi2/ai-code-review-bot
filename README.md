# AI Code Review Bot

An automated pull request review bot built with [Bun](https://bun.com) and [Effect](https://effect.website). It runs as a GitHub Actions reusable workflow, fetches the diff of a pull request from the GitHub API, runs [Biome](https://biomejs.dev) on the changed files, and sends both to Groq's chat completions API. The model returns a structured list of findings which the bot posts (and keeps up to date) as a single comment on the pull request.

## How it works

1. A caller repository invokes the reusable workflow `Falasefemi2/ai-code-review-bot/.github/workflows/review.yml` (see `templates/review-caller.yml`).
2. The workflow checks out this bot repository, installs dependencies, and runs `src/index.ts`.
3. The bot resolves which pull request to review:
   - `pull_request` events use the PR number from the event payload.
   - `push` events look up an open pull request for the pushed branch via the GitHub API and skip the review if none exists.
4. `GitDiff` fetches the PR diff from `GET /repos/{owner}/{repo}/pulls/{number}`.
5. `Linter` runs `biome check --reporter=json` on the changed files.
6. `AiReviewer` sends the diff (truncated to 24,000 characters) plus the linter output to Groq and expects a JSON reply with a summary and findings.
7. `GithubReporter` posts the review as a single issue comment. On subsequent runs it finds the comment by a marker and updates it in place, so re-running never produces duplicate reviews.

## Repository layout

```
.github/workflows/review.yml   The reusable workflow (invoked by caller repos)
templates/review-caller.yml    Thin caller template to copy into other repos
src/index.ts                   Entry point and orchestration
src/config.ts                  Environment configuration and PR resolution
src/services/GitDiff.ts        Fetches the PR diff from the GitHub API
src/services/Linter.ts         Runs Biome on changed files
src/services/AiReviewer.ts     Calls the Groq API and parses findings
src/services/GithubReporter.ts Posts / updates the review comment
src/services/PrLookup.ts       Finds an open PR for a pushed branch
mock-event.json                Local mock GitHub event payload
```

## Requirements

- [Bun](https://bun.com) 1.4 or newer
- A [Groq API key](https://console.groq.com/keys)

## Local development

Install dependencies:

```bash
bun install
```

Copy the example environment file and fill in the values:

```bash
cp .env.example .env
```

The bot reads the following environment variables:

| Variable               | Required | Description                                                        |
| ---------------------- | -------- | ------------------------------------------------------------------ |
| `GROQ_API_KEY`         | Yes      | Groq API key used for the review model.                            |
| `GITHUB_TOKEN`         | Yes      | GitHub token with repo scope (for local testing).                  |
| `GITHUB_REPOSITORY`    | Yes      | Target repository in `owner/repo` form.                            |
| `GITHUB_EVENT_PATH`    | Yes      | Path to the GitHub event JSON payload.                             |
| `GITHUB_EVENT_NAME`    | For push | `pull_request` or `push`. Defaults from the workflow environment.  |
| `GITHUB_REF_NAME`      | For push | Branch name, used only to look up an open PR for push events.      |

Run against the included mock payload (which points at PR number 1 of the configured repository):

```bash
bun run dev
```

The dev script loads `.env.local` if present and `mock-event.json` via `GITHUB_EVENT_PATH`.

## Adding the bot to another repository

1. Copy `templates/review-caller.yml` into the target repository at `.github/workflows/review.yml`.
2. Add a `GROQ_API_KEY` repository secret in the target repository (Settings > Secrets and variables > Actions).
3. Commit the workflow file. `GITHUB_TOKEN` is auto-provided by GitHub Actions and needs no setup.

The caller workflow triggers on `pull_request` (opened, synchronize, reopened) and on `push` to non-default branches. For push events the bot checks whether an open pull request exists for the pushed branch and reviews it if so. Note that a push to a branch that also has an open PR fires both triggers; the bot collapses these into one comment because it updates the existing marker-based comment.

### Permissions

The caller and reusable workflows request the following permissions:

- `contents: read` - check out the bot source.
- `pull-requests: read` - list open pull requests and read diffs.
- `issues: write` - create and update the review comment on the issue.

The bot never modifies pull requests directly; it only comments.

### Secrets on personal accounts

`secrets: inherit` only works inside a GitHub organization. On a personal account, each caller repository must configure its own `GROQ_API_KEY` secret individually.

## Model and output

- Model: `openai/gpt-oss-120b` (configurable in `src/services/AiReviewer.ts`).
- Temperature: `0.2`.
- The bot requests JSON output. Findings have a `severity` of `bug`, `warning`, or `suggestion`, plus a file path, optional line number, and comment.
- Diffs longer than 24,000 characters are truncated with a notice in the prompt.
- Rate-limit responses (HTTP 429) are retried with exponential backoff (3 attempts).

## Tooling

```bash
bun run dev          # Run locally against mock-event.json
bun run lint:check   # Biome lint (no writes)
bun run format:check # Biome format (no writes)
bun run ci           # Biome CI check (lint + format + imports)
```
