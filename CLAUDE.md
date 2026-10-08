# CLAUDE.md

AI CV Builder: a test assignment (see `assignment.md`). A signed-in user provides a PDF CV or free text plus a target role. They get a structured CV draft that they can refine by answering AI questions, edit by hand and download as an A4 PDF.

Evaluation priorities: the end-to-end flow works; the system design is sound; failures and untrusted input (including LLM output) are handled; trade-offs are sensible within a 10-hour budget. **When short on time, cut features, not reliability**, and record each cut in the README.

## Stack (fixed decisions)

- **Frontend:** React + Vite + TypeScript, React Router, TanStack Query, Tailwind. Mobile-first.
- **Backend:** NestJS (REST only), TypeScript.
- **Database:** PostgreSQL via **Prisma** (schema and migrations in `apps/api/prisma`).
- **AI:** **Mastra**, embedded as a library inside the Nest app, not run as a separate Mastra server. All LLM calls go to the Anthropic API (Claude). Model ids come from env:
  - Sonnet (`AI_MODEL_MAIN`) for extraction, composition and applying answers
  - The planned Haiku critic/question pass was cut (see README); questions come from extraction gaps and the deterministic checks
- **Background jobs:** **pg-boss**, running on the same Postgres. No Redis.
- **PDF:** **@react-pdf/renderer**, server-side. A4 page size, embedded fonts, selectable text. No headless browser.
- **Runtime:** `docker compose up` starts postgres, api (runs `prisma migrate deploy` on boot) and web (nginx serving the build and proxying `/api`). The only secret is `ANTHROPIC_API_KEY`, read from `.env`.
- **Package manager:** pnpm workspaces.

## Repo layout

```
apps/web/         React app
apps/api/         NestJS app (Prisma, Mastra, pg-boss, PDF rendering)
packages/shared/  Zod schemas (CvDocument, Question, API DTOs), shared by FE and BE
```

The `CvDocument` Zod schema in `packages/shared` is the **single source of truth** for the CV shape. The same schema validates LLM output, manual edits and frontend rendering. Never duplicate the shape elsewhere.

## Backend modules

- `auth`:
  - Email and password signup/login, with passwords hashed by argon2.
  - Sessions use a JWT in an **httpOnly cookie**.
  - A guard provides `userId`.
- `cvs`:
  - CRUD. **Every query is scoped by `userId`.**
  - Another user's resource returns **404**, not 403.
- `ingestion`:
  - PDF upload: size limit, `%PDF` magic-byte check, text extraction with a timeout. A PDF with no extractable text gets a clear error.
  - Free text: length limit.
  - Only the extracted **source text** is stored, not the file.
- `generation`:
  - pg-boss worker that runs the Mastra workflow.
  - Writes `status` and `progress_step` to the database.
- `questions`: lists open questions; answering one triggers a scoped AI update of a single CV section.
- `pdf`: `GET /cvs/:id/pdf`.
- `ai`: Mastra agents, the workflow, prompts and the Anthropic model config.

## Data model

- `users`: id, email (unique, lowercased), password_hash, created_at
- `cvs`:
  - identity and input: id, user_id, title, target_role, source_type (`pdf` | `text`), source_text
  - results: content (jsonb `CvDocument`), facts (jsonb `Fact[]`, the verified fact ledger; kept out of `content` so manual edits can't touch it)
  - job state: status (`queued` | `processing` | `ready` | `failed`), progress_step, error
  - version (optimistic locking) and timestamps
- `cv_questions`: id, cv_id, field_path, question, answer, status (`open` | `answered` | `dismissed`), applying (answer job in flight), error
- `field_path` format (see `parseFieldPath` in `@cv/shared`): `contact` | `summary` | `skills` | `experience` | `education` | `experience:<entryId>` | `education:<entryId>`. Entry ids come from the fact `entry` keys (`exp_1`, `edu_1`).

## Async generation (reload-safe)

1. `POST /cvs` creates the CV row (`queued`) **and** enqueues the pg-boss job in one transaction (`fromPrisma(tx)` adapter), then returns the id right away.
2. The frontend polls `GET /cvs/:id` (1–2 s) while the status is `queued` or `processing`. It shows the step (`progress_step`): extracting → verifying → writing → checking.
3. All state lives in the database, so a reload or another device simply resumes polling. The job does not depend on the browser.
4. Failure handling:
   - LLM calls have timeouts and retry with backoff.
   - pg-boss retries jobs a limited number of times.
   - When retries are exhausted, the status becomes `failed` with a human-readable error, and the UI offers a Retry button.
   - A crashed worker's job expires (15 min) and pg-boss retries it. A sweeper (on boot and every minute) re-enqueues CVs left `queued`/`processing` too long; queues use the `exclusive` policy with `singletonKey` = CV/question id, so this never duplicates work.
   - Mastra serialises errors thrown inside workflow steps, which loses the `LlmError` class and its `retryable` flag. `runGeneration` therefore rethrows the original error that a step recorded.

## Anti-hallucination design (core requirement, do not weaken)

The AI may rephrase and restructure but **must not invent facts**. The Mastra workflow steps are:

1. **Extract facts** (agent, structured Zod output):
   - Produces atomic facts, and **each fact carries a verbatim `sourceQuote`**.
   - Missing or vague items become `gaps`.
2. **Ground-check (deterministic code):**
   - Each `sourceQuote` must appear in the normalized source text (whitespace- and case-insensitive).
   - Facts that fail are dropped or turned into questions.
3. **Compose CV** (agent):
   - Receives **only the verified facts** and the target role, never the raw source.
   - Writes concise bullets and a role-targeted summary, and orders experience by relevance.
   - Every bullet references `factIds`.
4. **Verify output (deterministic; the optional LLM critic was cut, see README):**
   - Bullets must cite existing fact ids.
   - Numbers, dates, company names and emails must appear in the cited facts.
   - Unsupported content is removed and turned into a question.
5. **Persist:** saves `content`, and turns the gaps into `cv_questions` with a `field_path`.

**Answering a question:**

- The answer is added to the fact ledger as a user-provided fact.
- A scoped agent rewrites **only** the section at `field_path`.
- The result goes through the same Zod validation and deterministic verification, then is saved with a version bump.

## Untrusted input and LLM output

- Validate all agent output with Zod. On failure, make one repair retry, then fail cleanly. Never persist unvalidated output.
- Wrap source text in prompts as delimited **data**, and tell the model to ignore any instructions inside it (prompt-injection defence).
- Cap input and output sizes.
- Validate all request bodies, using shared Zod schemas or Nest pipes.
- Escape everything that gets rendered.

## Editing and concurrency

- `PUT /cvs/:id/content` takes the full `CvDocument` plus `version`.
- It runs Zod validation and an optimistic-lock check. A stale version returns **409**.
- The frontend editor autosaves with a debounce.

## Frontend conventions

- **All API interaction goes through TanStack Query.** Query and mutation hooks live in `apps/web/src/queries.ts` (auth hooks in `auth.tsx`). Components never call `api.*` directly.
- **Mutations are optimistic.** Update the cache in `onMutate` (snapshot first), roll back in `onError`, and show a `sonner` toast that explains what was undone.
- **No preloaders or spinners anywhere.** While data is first loading, render nothing; for background work, show static text.
- The editor keeps a local draft and saves it debounced (`useCvDraft`). Saves run one at a time, each carrying the version from the previous save. The header shows "Saving your edits…" or "All changes saved". On a 409, the edit is reverted to the latest server version and a toast explains why.

## Testing priorities

1. Grounding and verification logic (unit tests): quote matching, stripping unsupported numbers and companies, rejecting bullets without fact ids.
2. Workflow with a **mocked LLM**: happy path, invalid output leading to repair and then failure, gaps becoming questions.
3. API e2e (Vitest + supertest against a test Postgres): auth, **ownership isolation**, the 409 version conflict, upload validation.
4. Job failure and retry behaviour.

Frontend tests follow the testing trophy: mostly integration tests that render the real app (`renderApp` in `apps/web/src/test/render.tsx`) against an in-memory MSW API (`server.ts`). Query by role and label, act with `user-event`, assert on what the user sees and what was sent. Don't mock hooks or components.

## Conventions

- Keep commits small and readable, roughly one per module or feature.
- Code is formatted with Prettier (`.prettierrc.json`). Run `pnpm format` before committing; `pnpm format:check` verifies.
- Tests must never call the real Anthropic API. Mock it at the Mastra agent/model boundary.
- Possible cuts if time runs short, in order:
  1. the LLM critic pass (keep the deterministic checks) — **cut**
  2. bullet reordering in the editor
  3. frontend tests (not cut: integration tests exist)

  Do not cut: auth scoping, the job durability guarantees (generation survives a reload, a server restart or a failure, as described under "Async generation"), or validation of LLM output.
