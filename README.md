# AI CV Builder

Sign in, paste your background or upload a PDF CV, name a target role, and get a structured CV draft. The AI may rephrase but not invent: anything it can't back up with your own words becomes a question, and your answer updates just that part of the CV. Edit any field by hand and download an A4 PDF with selectable text.

## Running it

```bash
cp .env.example .env            # set ANTHROPIC_API_KEY, and JWT_SECRET=$(openssl rand -hex 32)
docker compose up --build       # then open http://localhost:8080
```

Compose starts Postgres, the API (it applies migrations on boot) and nginx, which serves the web app and proxies `/api`. It needs two secrets from `.env`: `ANTHROPIC_API_KEY`, and `JWT_SECRET` (at least 32 characters). The API refuses to start without a real `JWT_SECRET`, because a known one lets anyone forge a session. Local `pnpm dev` falls back to a dev-only value. The model defaults to `claude-sonnet-5` and can be overridden with `AI_MODEL_MAIN`.

**Local development** (Node 22+, pnpm 10):

```bash
pnpm install
pnpm db:up                      # Postgres only, on :5432
pnpm --filter @cv/api exec prisma migrate deploy
pnpm db:seed                    # optional: test account, offered on the login page in dev
pnpm dev                        # API on :3000, web on http://localhost:5173
```

## Tests

```bash
pnpm db:up                      # e2e tests need Postgres
pnpm test                       # everything: API unit + e2e, then the web app
pnpm --filter @cv/api test:unit # API unit tests, no database needed
pnpm --filter @cv/web test      # web app tests, no database or API needed
pnpm typecheck
pnpm format:check               # Prettier (pnpm format to fix)
```

The e2e suite drops and recreates its own `cv_test` database (override with `TEST_DATABASE_URL`) and never touches the dev data. **No test calls Anthropic:** the model is replaced either at the `CvLlm` interface or at Mastra's `Agent`.

| Suite                                | What it covers                                                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ai/grounding.spec.ts`           | Quote matching, invented numbers, companies, contacts, dates and skills being stripped, and bullets without valid fact ids being dropped                                                                             |
| `src/ai/generation.workflow.spec.ts` | The Mastra workflow with a fake LLM: happy path, the composer seeing only verified facts, gaps becoming questions, error classification                                                                              |
| `src/ai/cv-llm.spec.ts`              | Structured-output repair (one retry with the validation error, then a clean failure), mapping provider errors to retryable or not, prompt-injection delimiting                                                       |
| `src/ai/apply-answer.spec.ts`        | An answer rewrites only its section, the rewrite goes through the same grounding checks, and manual edits elsewhere are kept                                                                                         |
| `test/auth.e2e.spec.ts`              | Signup and login, the httpOnly cookie, email case folding, rate limiting                                                                                                                                             |
| `test/cvs.e2e.spec.ts`               | **Ownership isolation** (every route returns 404 for another user's CV), **409 on a stale version**, Zod validation of edits, PDF download (A4), upload validation (magic bytes, size, no text layer, corrupt files) |
| `test/jobs.e2e.spec.ts`              | Job failure and retry: retryable vs final vs non-retryable errors, the user-facing messages, the Retry endpoint, no duplicate jobs, applying answers concurrently with manual edits                                  |

**Frontend** (`apps/web/src/test`) follows the testing trophy: TypeScript is the static base, and nearly everything else is an integration test. There are no unit tests: the app's logic is in its hooks and flows, so testing through the UI loses nothing. There are no end-to-end browser tests yet (see "With more time").

- **The real app.** Each test renders the whole app (real routes, auth guard, TanStack Query with the production config, toasts) in a memory router. Only the network is faked, with MSW: a small in-memory API (`server.ts`) handles sessions, versions and 409s, and records requests so tests can check payloads. Tests act like a user: they find elements by role and label and type with `user-event`.
- **What's covered** (22 tests):
  - sign-in, the redirect back to where you were going, an expired session, logout;
  - creating a CV from text or PDF, form validation, the server being unreachable;
  - generation progress picked up by polling, retry after a failure, a missing CV;
  - debounced autosave carrying the version, the 409 revert with its explanation;
  - optimistic rename with rollback, delete;
  - answering, skipping, and a failed answer.
- **They catch real breakage.** I broke seven behaviours one at a time (e.g. no polling, no 409 handling, no rollback), and each made a test fail. Writing the tests also found a bug: the "create from text" request sent an internal UI field (`source`) to the API.

### Eval against the real model

```bash
pnpm eval                       # opt-in; uses ANTHROPIC_API_KEY from .env, about 2 Sonnet calls per case, ~40 s
```

The unit and e2e tests prove that the checks work on output we control. The eval checks what the real model does with real input. It runs the full pipeline on six source texts, each aimed at one failure mode:

- prompt injection inside the CV;
- vague input;
- several jobs with metrics and dates;
- ordering by relevance rather than recency;
- copying contact details exactly;
- almost no information.

It has two kinds of checks:

- **Hard checks** fail the run: no number or employer that isn't in the source, no injected content, plus each case's own expectations. Examples: the 12 % stays with Shoply, the data job comes first for a Data Engineer role, vague input yields questions and no employer.
- **Measurements** are only reported: wording that inflates a claim, how much the deterministic checks had to remove, and the number of questions.

Each run writes a summary table (`report.md`) and each case's full output to `apps/api/eval/out/`, which is gitignored because results vary from run to run.

What it showed:

- The hard guarantees held on every run.
- Output varies between runs. One run turned vague input into a role with 4 cautious bullets, the next into no roles and 7 questions. Both are acceptable, but one run is a sample.
- Filler sometimes gets through, despite the prompt: "track record" in one run, "focused on improving product experiences through iterative testing" in another. This is the remaining gap: wording, not invented facts (see why there's no LLM critic below).
- The checks are occasionally over-strict: the skill "Usability Testing" was removed because the source says "usability tests".

## Architecture

```
apps/web         React + Vite + TanStack Query + Tailwind (mobile-first)
apps/api         NestJS REST API + pg-boss worker + Mastra workflow + react-pdf
packages/shared  Zod schemas: CvDocument, API DTOs (used by both sides)
```

```
browser ──/api──▶ nginx ──▶ NestJS ──▶ Postgres  (users, cvs, cv_questions, pgboss.*)
                              │  ▲
                   enqueue in │  │ status / progress_step / content
                   same tx    ▼  │
                         pg-boss worker ──▶ Mastra workflow ──▶ Anthropic
```

The main decisions:

- **One schema.** `CvDocument` in `packages/shared` validates LLM output, manual edits (`PUT /cvs/:id/content`) and what the frontend renders. The LLM gets looser schemas (`llm-schemas.ts`), because structured output handles length limits badly. Its output is then clamped and re-validated against the strict schema before anything is stored.
- **Generation is a durable background job, not a request.** `POST /cvs` inserts the CV (`queued`) and enqueues the pg-boss job **in the same transaction**, so there is never a CV without a job or a job without a CV. The worker writes `status` and `progress_step` (extracting → verifying → writing → checking) to the row, and the UI polls `GET /cvs/:id` every 2 s. All state is in Postgres, so a reload, another device or a server restart just resumes polling.
- **pg-boss instead of Redis/BullMQ.** It's one less service, and enqueueing can share a transaction with the business write. Queues use the `exclusive` policy with `singletonKey` = CV or question id, so a re-enqueue can never duplicate work.
- **Failures are classified.** `LlmError.retryable` decides what happens next:
  - Retryable errors (timeouts, 5xx, overload, invalid output after repair) go back to pg-boss: 2 retries with exponential backoff. The user sees "… Retrying…".
  - Non-retryable errors (bad credentials, nothing usable in the input) fail immediately.
  - After the last attempt, the CV is `failed` with a readable message and the UI offers Retry. Internal error details are logged, never shown.
- **Crash recovery.** I killed the API with SIGKILL during extraction. The restarted instance picked up the in-flight job and the CV was `ready` about 16 s later. There are two backstops: job expiry (then pg-boss retries it), and a sweeper (on boot and every minute) that re-enqueues CVs stuck in `queued`/`processing`.
- **The job expiry is derived, not guessed.** Mastra's `timeout.totalMs` caps each LLM call including its provider retries; I verified this against a fake Anthropic server. A job's worst case is therefore 2 calls × 2 attempts (one repair) × `LLM_TIMEOUT_MS`, which is 12 min at the default 180 s. The expiry is that plus a 3-minute margin (15 min), so pg-boss never retries a job while its first run is still going. The expiry is recomputed and written to the queue on every boot, so changing the timeout takes effect.
- **An expired attempt stops and stays quiet.** If a run does outlive its expiry, pg-boss aborts `job.signal`. The worker passes that signal into every model call, so the run stops right away. While retries remain, it writes nothing, because the retry may already be running. On the last attempt, it records "took too long" (or saves a result that finished just in time), so a CV never sits in `processing`.
- **One provider retry layer.** Mastra's default stream-retry processor retried on top of `maxRetries`: a persistently overloaded API got 12 requests per call instead of 4. It's replaced by a no-retry instance, so `maxRetries: 3` means 4 requests.
- **Mastra runs embedded in Nest** as a library: agents plus a 4-step workflow. Mastra serialises errors thrown inside steps, which loses `LlmError` and its `retryable` flag, so each step records the original error and `runGeneration` rethrows it.
- **Auth:**
  - argon2 password hashes; a JWT lives in an httpOnly, `SameSite=Lax` cookie.
  - The JWT names a row in `sessions`, and the guard checks that row on every request. Logout deletes it, so a copied cookie stops working while other devices stay signed in. A token for a deleted user is a 401, not a 500.
  - Production refuses to start without a real `JWT_SECRET` (missing, shorter than 32 characters, or a placeholder from this repo).
  - The app and API share one origin via nginx, so no CORS. SameSite blocks cross-site POSTs (CSRF).
  - A global guard protects every route that isn't marked `@Public()`.
  - Every CV query is scoped by `userId`, and another user's CV returns **404**, not 403.
  - Login and signup are rate-limited, and so is generation (10 per hour).
  - Login takes about the same time for unknown emails (a dummy hash is verified).
- **Concurrency.** Edits carry `version`, and a stale write gets **409**. The editor autosaves with a debounce, one save at a time; on a 409 it reverts to the server version and explains why in a toast. When an answer is applied while the user is editing, the worker locks the row and splices **only the answered section** into the latest content, so neither side's change is lost.
- **Logging.** pino via `nestjs-pino`: JSON lines in Docker, readable lines in local dev, silent in tests (`DEBUG=1` to see them). Every line written during a job carries its `queue`, `cvId` or `questionId`, and `jobAttempt`, without passing ids around. Each model call logs one `llm_call` line: agent, attempt (first try or repair), outcome, duration and tokens. Each job logs a `job_finished` line with its outcome and duration. The session cookie is redacted from request logs, and the 2-second CV polling and health checks aren't logged. Example: `docker compose logs api | grep llm_call`.
- **PDF.** `@react-pdf/renderer` on the server (no headless browser): A4, embedded Inter font, selectable text. For uploads, only the extracted text is stored, never the file.

## How the AI is kept from inventing facts

The design assumes the model will sometimes invent things. The guarantees come from code that runs after it, not from the prompts.

1. **Extract** (Sonnet): the source becomes atomic facts, and **each fact carries a verbatim `sourceQuote`**. Missing or vague things become `gaps`, which turn into questions.
2. **Ground-check (code):**
   - Each quote must appear in the source as whole words, ignoring case, whitespace and punctuation.
   - A fact's paraphrased `text` may not contain numbers its quote lacks.
   - Failing facts are dropped. If nothing survives, the job fails with a clear message instead of producing an empty CV.
3. **Compose** (Sonnet): receives **only the verified facts** and the target role, never the raw source. Every bullet must cite `factIds`.
4. **Verify output (code)**, `verifyCv` in `grounding.ts`:
   - Bullets without valid fact ids are deleted.
   - Bullets with numbers not present in _their cited_ facts are deleted.
   - Bullets that name something (a capitalised word mid-sentence, or one with capitals inside, such as `AWS` or `TypeScript`) that the entry's facts never mention are deleted. "Built the billing service for Google" goes unless Google is in that job's facts.
   - Names, emails, links and locations must appear in the facts; phone numbers are matched by digits.
   - Titles, companies, institutions, degrees and skills must consist of words found in the facts. A common ending is allowed ("Engineer" for "Engineering", "Design" for "Designer"), but not a different word: "Java" does not pass on "JavaScript".
   - Dates may be reformatted, but their years must exist in the facts.
   - **Checks are scoped per entry.** Titles, companies, institutions, dates, education details and bullet citations are checked only against that job's or degree's facts (by the fact's `entry` key), plus facts not tied to any entry. A real employer, year, achievement or number can't migrate from one role to another.
   - Summary sentences with unsupported numbers ("10+ years") or names ("former Google engineer") are dropped. The target role may be named.
   - Anything removed that matters (company, title, dates, name) becomes a question.
5. **Answers:**
   - An answer is added to the fact ledger as a `user_answer` fact.
   - A scoped agent rewrites only the part at `field_path` (`experience:exp_2`, `skills`, …).
   - The result goes through the same Zod validation and `verifyCv`, then is saved with a version bump.
   - The fact ledger is stored separately from `content`, so manual edits can't change what counts as verified.

**Prompt injection.** Candidate text goes into prompts as delimited data (`<source>…</source>`). Closing tags are stripped from inside it, and the instructions tell the model to treat it as data. Steps 2 and 4 hold no matter what the model is talked into.

**Known gaps in the checks** (deliberately simple; noted rather than hidden):

- Word-level checks can't catch a recombination of real words that changes the meaning, or qualitative inflation such as "expert in". That's a deliberate trade-off (see "No LLM critic" below).
- Names are recognised by capitalisation, so an invented name written in lowercase ("using kafka") or as the first word of a sentence isn't caught.

## What I simplified or cut

Following "cut features, not reliability":

- **No LLM critic, by choice.** Code already blocks invented facts: any number, date, name or email not in the source is removed. A critic would only fix wording, like filler or "maintained" turning into "led". The eval found filler in 2 of 18 CVs and no invented facts, and the user can edit any sentence, so it isn't worth an extra model call per CV. Questions come from the extraction step and the code checks, so the app uses one model. I'd revisit this only if the eval showed a real problem, for example bullets that link two true facts in a false way.
- **No prompt-injection classifier.** The model can't take actions, and code removes anything not backed by the source, so injected text can't add facts. The only person who could inject text is the user, about their own CV. A classifier would mostly flag real CVs that mention the topic.
- **Scanned PDFs are rejected** with a clear message rather than OCR'd. Text extraction loses layout (columns can interleave), which the extractor usually tolerates.
- **One API process runs both HTTP and the worker.** That's fine here; in production they would be separate deployments of the same image (`WORKER_ENABLED=false` already exists for this).
- **Rate limits are in memory, per process, and keyed by IP.**
- Out of scope per the brief: templates, job-description tailoring, OAuth, password reset, email verification.

## With more time

- Grow the eval: more cases, several runs per case to measure variance, and an LLM-judged filler score instead of a word list.
- Stream progress over SSE instead of polling, and show per-bullet "source" tooltips (the fact ids are already stored).
- An eval set of real CVs, with known injected hallucinations, to measure how often the checks catch them.
- Split worker and API, put rate limiting in Postgres, and add a few Playwright end-to-end tests (the top of the trophy) against the real stack.
- Add observability via LangFuse (decided not to because it adds secrets to the .env file and complicates the review). Opted for simple logging with pino instead

## How I used AI tools

- I built it with Claude Code. Before writing any code, I wrote the plan and the constraints into `CLAUDE.md`: stack, data model, the anti-hallucination pipeline, and what must not be cut. That file steered every session. All architectural decisions made by me (using db as a queue,
  using mastra, tanstack-query, prettifier, etc.)
- The work went module by module, roughly one commit each.
- Writing the tests surfaced real limitations of the grounding checks. They are listed above rather than worked around.
- All the code was reviewed and checked manually. When in doubt, I consulted claude, especially on the need of the classifier. The decision is mainly based on the scope of the project (didn't want to blow up the scope)
