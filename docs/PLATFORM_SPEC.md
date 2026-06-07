# AI Accountant Platform — Architecture & Build Spec

> Status: **Draft for review** · Owner: rasmus@available.dk · Date: 2026-06-07
>
> A hosted web app where a user signs up with Google, connects their accounting
> and document "storages" (e-conomic, Gmail, …), and chats with an AI
> "accountant" agent that can act on their behalf — starting with **finding and
> attaching receipts**.

---

## 1. Vision & north star

A single chat surface — *"talk to your accountant"* — backed by an agent that has
secure, per-user access to the systems where a small business's financial truth
actually lives: their accounting system (e-conomic) and the places receipts
arrive (email, and later Dropbox/Drive/Stripe/banks).

**First killer workflow:** the agent finds vouchers/expenses that are missing
documentation, locates the matching receipt in the user's email, and attaches it
to the right entry in e-conomic — turning a tedious monthly chore into one chat
message.

The product is deliberately *composable*: each external system is a "storage"
the user attaches. Adding a new storage = adding a new connector. The agent and
chat UI don't change.

---

## 2. Core concept: "storages" are MCP servers

The cleanest mental model — and the one that reuses what we already have:

> Each **storage** is an **MCP server** (Model Context Protocol). The agent is a
> Claude model with the user's connected MCP servers wired in as tools, scoped to
> that user's credentials.

We already own one of these connectors: **`@available/e-conomic-mcp`** (this
repo). It exposes the whole e-conomic REST API to an agent as tools. Gmail,
Drive, Stripe, etc. either have existing MCP servers or are small connectors we
write the same way.

This is the strategic bet: **we don't build N bespoke integrations into a
monolith — we build a host that loads MCP connectors per user.** The e-conomic
server becomes the first of many, and stays independently publishable/reusable.

---

## 3. High-level architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Web app  (Next.js · hosted on Vercel)                         │
│  • Google sign-in                                              │
│  • Chat UI ("your accountant")                                 │
│  • Connections page: attach/disconnect storages               │
│  • Billing / usage dashboard                                   │
└───────────────┬───────────────────────────────┬───────────────┘
                │ (streamed chat)                │ (OAuth callbacks)
┌───────────────▼───────────────┐   ┌────────────▼───────────────┐
│  Agent service                │   │  Connection / OAuth service │
│  (Claude Agent SDK + Opus)    │   │  • per-storage auth flows   │
│  • runs the chat loop         │   │  • token refresh            │
│  • loads the user's MCP       │   │  • encrypted token vault    │
│    servers, scoped per-user   │   └────────────┬────────────────┘
│  • enforces usage/cost limits │                │
└───────┬───────────────────────┘                │
        │ MCP (stdio / HTTP)                      │
   ┌────┼─────────────┬───────────────┐           │
   ▼    ▼             ▼               ▼           ▼
e-conomic  Gmail   (Stripe)     (Drive/Dropbox)  ┌──────────────┐
  MCP      MCP      future         future        │  Postgres    │
                                                 │  • users     │
   each invoked with THIS user's credentials ◄───┤  • connections (encrypted tokens)
                                                 │  • threads/messages
                                                 │  • usage/billing
                                                 └──────────────┘
```

> Two cross-cutting services sit alongside the connectors: a **document service**
> (vision-based reading/verification + PDF generation) and **object storage** for
> receipts and generated PDFs. Users can also **upload files directly in the
> chat**, which feed the same document service.

---

## 4. Recommended repo layout — **monorepo (pnpm workspaces)**

*(You asked me to recommend. Here it is, with reasoning.)*

Restructure this repo into a workspace monorepo:

```
e-conomic-mcp/                 (repo root → rename later if desired)
├── packages/
│   └── e-conomic-mcp/         ← the existing server, moved here verbatim
│                                 still published as @available/e-conomic-mcp
├── apps/
│   └── web/                   ← Next.js app (UI + agent + API routes)
├── packages/
│   ├── connectors/            ← shared connector registry / MCP launching
│   └── core/                  ← shared types, db schema, crypto helpers
├── pnpm-workspace.yaml
└── docs/
```

**Why monorepo, not a separate repo:**

- The web app and the e-conomic connector will **co-evolve heavily** in the early
  phase (e.g. we'll add the file-upload tool to the connector *because* the web
  workflow needs it). Atomic cross-cutting commits beat version-bump ping-pong
  across repos.
- The MCP server **stays a standalone, publishable package** inside the
  workspace — we keep the clean-library benefit without the cross-repo overhead.
- Once the connector API stabilizes, extracting it to its own repo is a
  mechanical `git filter-repo`, not a rewrite. Easy to defer, cheap to do later.

**Trade-off accepted:** a slightly more complex build/CI setup now (pnpm
workspaces, per-package builds). Worth it.

---

## 5. Tech stack

| Layer            | Choice                                   | Why |
|------------------|------------------------------------------|-----|
| Framework        | **Next.js (App Router)**                 | UI + API routes + streaming in one deployable |
| Host             | **Vercel** (start), revisit Cloudflare   | Easiest Next.js + Node agent path; see §12 |
| Auth             | **Auth.js (NextAuth)** w/ Google, or Clerk | Google sign-in out of the box |
| DB               | **Postgres** (Supabase / Neon)           | Relational; Supabase also gives auth/storage if wanted |
| ORM              | **Drizzle** or Prisma                    | Typed schema, migrations |
| Agent runtime    | **Claude Agent SDK** + **Claude Opus 4.x** / Sonnet for cheap paths | Native MCP support, tool loop handled for us |
| Token encryption | **libsodium / AES-GCM** w/ KMS-held key  | Financial creds at rest must be encrypted |
| Queue (later)    | Inngest / QStash                         | Background receipt-matching jobs |
| Read documents   | **Claude vision** (PDF + image input); OCR fallback (Textract) | Verify receipts before upload |
| Generate PDFs    | **pdf-lib / react-pdf**, or Playwright (HTML→PDF) | Reports + generated *bilag* |
| File storage     | **S3 / Supabase Storage / Cloudflare R2** | Receipts + generated PDFs, EU region |

> On models: route cheap/structured steps (classification, extraction, "which
> voucher matches this email") to **Sonnet/Haiku**, reserve **Opus** for the
> interactive accountant reasoning. This is also a cost lever (see §11).

---

## 6. Data model (first cut)

```
users            (id, email, google_sub, created_at)
connections      (id, user_id, storage_kind, status,
                  credentials_encrypted, scopes, created_at, expires_at)
threads          (id, user_id, title, created_at)
messages         (id, thread_id, role, content, tool_calls_json, created_at)
usage_events     (id, user_id, thread_id, model, input_tokens,
                  output_tokens, cost_cents, created_at)
subscriptions    (id, user_id, plan, status, stripe_customer_id,
                  included_credits, renews_at)
files            (id, user_id, kind[receipt|generated|report],
                  source[gmail|chat_upload|generated], storage_url, mime,
                  sha256, extracted_json, linked_voucher, message_id, created_at)
```

`storage_kind` ∈ {`economic`, `gmail`, `drive`, …}. `credentials_encrypted` holds
the storage-specific token blob (e-conomic agreement grant token, Google OAuth
refresh token, …), encrypted at rest.

---

## 7. Auth & per-user credentials (the crux of multi-tenancy)

The existing MCP server reads **one** set of tokens from env/local file. For a
multi-tenant SaaS, every user attaches **their own** accounts. Per storage:

### e-conomic
- e-conomic uses **AppSecretToken** (one per *our* registered app) +
  **AgreementGrantToken** (one per *customer agreement*).
- Flow: we register an e-conomic app once → user clicks "Connect e-conomic" →
  e-conomic's grant flow returns an agreement grant token → we store it
  encrypted against the user's `connection` row.
- Good news: `src/credentials.ts` already reserves an `oauth` field and is
  "intentionally open to additional auth methods" — the connector needs to accept
  injected credentials per-request rather than reading a global file. **Small
  refactor, already anticipated.**

### Gmail / Google
- Standard Google OAuth 2.0 with incremental scopes (`gmail.readonly` to start —
  read-only is enough to *find* receipts; we don't need send/modify for v1).
- Store refresh token encrypted; mint access tokens on demand.

### Security posture (non-negotiable for financial data)
- Tokens encrypted at rest (AES-GCM, key in a managed KMS / Vercel+Supabase
  secret, **never** in the DB).
- Per-user credential isolation enforced at the agent-host boundary: a chat for
  user A can *only* ever load user A's connections.
- Audit log of every tool call the agent makes (what it read/wrote where).
- GDPR: this is Danish/EU financial data → data residency (EU region), DPA,
  right-to-delete, and a clear data-handling policy. Flag for legal early.

---

## 8. The agent layer

- One **agent loop per chat turn**, built on the Claude Agent SDK.
- At session start, the host loads the user's active connections, launches/attaches
  the corresponding MCP servers, and injects per-user credentials.
- System prompt frames the agent as a **Danish-speaking bookkeeping assistant**
  that is careful, cites what it found, and **asks before writing** to e-conomic
  (no silent mutations of accounting records).
- Tool-call audit + cost metering wrap every step.
- **Guardrails:** write operations to e-conomic (booking, attaching) require an
  explicit confirmation step surfaced in the UI ("Attach receipt X to voucher Y?
  [Confirm]") before execution.

---

## 9. Flagship workflow: find & attach receipts

**User:** *"Find receipts for my April expenses that are missing documentation."*

1. Agent queries e-conomic for vouchers/entries in April lacking an attachment.
2. For each, it extracts a fingerprint (amount, date, supplier).
3. Agent searches Gmail for matching receipts (`from:`, amount, date window).
4. Agent proposes matches in chat with confidence + preview.
5. On user confirm → agent attaches the receipt file to the e-conomic voucher.

### Attaching the receipt — verified supported (one small connector addition)
The e-conomic REST API **does** support uploading voucher attachments:
`POST` / `PUT` / `DELETE` on the voucher `attachment` endpoint, sent as
**`multipart/form-data`**, accepting **PDF / JPG / JPEG / GIF / PNG**, for **both
draft and booked vouchers**. Same `restapi.e-conomic.com` host and the same
`X-AppSecretToken` / `X-AgreementGrantToken` auth our connector already uses.

> ⚠️ Gotcha that misled an earlier draft of this spec: the **OpenAPI spec
> bundled in this repo (`spec/economic-openapi.json`) only documents the `GET`**
> on that endpoint — the `POST`/`PUT`/`DELETE` are missing from our spec, not
> from the API. So the capability is real; our schema is just incomplete.

**What we need to build (small):**
1. Add an `economic_attach_voucher_file` tool to the connector that `POST`s a
   file as `multipart/form-data` to the voucher attachment endpoint.
2. Teach the connector's HTTP client to send multipart bodies — today
   `economicClient.ts` only serializes JSON (`Content-Type: application/json`),
   so this is the one genuinely new capability. Modest, well-scoped.
3. (Optional) backfill the missing `POST/PUT/DELETE` operations into the bundled
   OpenAPI spec so discovery/dynamic tools see them too.

**Not a blocker.** The full *find → propose → confirm → attach* loop is
achievable in v1; the only net-new code is multipart upload support.

---

## 10. Document & media processing (read · verify · generate)

Receipts *are* documents and images, so the platform treats files as a
first-class capability — not just blobs shuffled between Gmail and e-conomic.

### Reading & verifying (vision) — the trust mechanism
- Claude is natively multimodal: it reads **images (PNG/JPG)** and **PDFs**
  directly as input content blocks — no separate OCR service needed for the
  common case.
- **Before any upload, the agent opens the receipt and verifies it:** extracts
  supplier, date, amount, VAT, currency — and checks they match the e-conomic
  voucher it's about to attach to. Mismatches are surfaced to the user, never
  silently uploaded. The agent doesn't attach a file it hasn't "looked at."
- **OCR fallback** (AWS Textract / Google Document AI / Tesseract) only when
  vision confidence is low on a poor scan — used sparingly to keep cost down.

### Generating PDFs — two distinct needs
1. **Reports & exports** — expense summaries, a month's reconciliation, or a
   single combined PDF of all receipts for a period.
2. **Generating a receipt/voucher itself** — sometimes no proper receipt exists
   (cash expense, a bank line, a handwritten note, an email order confirmation).
   The agent produces a clean, compliant **bilag** PDF from the available data
   (or from a photo + the fields it extracted) so there's a real document to
   attach to the voucher.

Tooling: **HTML→PDF via Playwright/Puppeteer** for rich/branded layouts, or
**pdf-lib / react-pdf** for lightweight programmatic generation and merging.
Generation runs server-side in the document service.

### User uploads in chat
The user can **drag a receipt (photo or PDF) straight into the conversation** —
e.g. "here's the receipt for that Circle K stop, file it." Uploaded files go
through the same document service: stored in object storage, read/verified by
vision, then matched and attached to the right e-conomic voucher. This is often
the *fastest* path for a receipt that never arrived by email (paper, in-app
receipts, photos of a till slip).

### File storage
- **Object storage** (S3 / Supabase Storage / Cloudflare R2), EU region, private
  buckets, signed URLs.
- Store the original-from-source **and** any generated/normalized version; link
  both to the e-conomic voucher and the chat message that produced them.

### Where it lives
A **document service** (a module/route in the web app, or a small worker) the
agent calls via tools, alongside the storage connectors:
`read_document` (vision extract), `generate_pdf`, `store_file` / `get_file`.

## 11. Monetization & cost control  *(you flagged this — it's load-bearing)*

Agent token usage is the dominant variable cost. Design for it from day one.

### Pricing model — recommended: **subscription + metered overage**
- **Free trial / Starter:** small monthly credit allotment (e.g. N agent runs)
  to prove value.
- **Pro (flat monthly):** includes a generous credit bucket covering typical
  monthly receipt-matching for one company.
- **Overage / usage-based:** beyond included credits, bill metered "agent
  credits" (we mark up model cost; never expose raw tokens to users).
- Billing via **Stripe** (subscriptions + usage records).

> Rule of thumb: never let a single user's model spend exceed their plan price.
> The `usage_events` table makes margin observable per user/per workflow.

### Cost-control levers (engineering)
1. **Model routing** — Sonnet/Haiku for extraction/matching/classification; Opus
   only for interactive reasoning. Often 5–10× cost reduction on the hot path.
2. **Don't dump raw data into context** — have MCP tools return *filtered,
   compact* results (e.g. only vouchers missing attachments, not all vouchers).
   The connector should support server-side filtering (it already does
   pagination/filtering).
3. **Cache** — prompt caching for the static system prompt + tool schemas; cache
   e-conomic reference data (accounts, suppliers) per session.
4. **Batch + background** — run the heavy "scan all of April" matching as a
   background job with a cheaper model, surface results in chat; reserve live Opus
   turns for conversation.
5. **Hard budget guardrails** — per-user/per-thread spend ceiling enforced in the
   agent host; when hit, pause and ask the user to continue (and bill overage).
6. **Pre-filter before the model** — use deterministic code (amount/date
   matching) to shortlist candidates, and only ask the model to disambiguate the
   ambiguous few.

### Unit-economics target
Track **cost-per-completed-workflow** (e.g. "cost to reconcile one month of
receipts"). That's the number that must sit comfortably under the slice of
subscription revenue it consumes. Instrument it from the first workflow.

---

## 12. Hosting: Vercel vs Cloudflare

| | Vercel | Cloudflare (Workers/Pages) |
|---|---|---|
| Next.js fit | First-class | Good, more constraints |
| Long agent calls | Functions/streaming OK; watch max duration | Workers CPU/time limits trickier for long loops |
| Node/Agent SDK | Native Node | Workers runtime caveats |
| Cost at scale | Higher | Lower |
| Recommendation | **Start here** | Revisit if egress/compute cost dominates |

Long-running agent loops are the risk on either platform — mitigate by moving
heavy work to a **queue/background worker** (Inngest/QStash) rather than holding
an HTTP request open.

---

## 13. Phased roadmap

**Phase 0 — De-risk (days)**
- ✅ e-conomic file-upload API confirmed (POST multipart to the voucher
  attachment endpoint, PDF/JPG/PNG, draft & booked). Remaining: add the
  multipart upload tool to the connector.
- Confirm e-conomic multi-tenant grant-token flow end to end.
- Spike: Claude Agent SDK loading the e-conomic MCP with injected per-user creds.

**Phase 1 — Skateboard MVP**
- Next.js + Google sign-in + Postgres.
- Connect **one** storage (e-conomic) with per-user grant token.
- Chat that can *read* e-conomic ("list my April expenses missing receipts").
- Basic usage metering visible to us.

**Phase 2 — Flagship workflow**
- Add Gmail connection (read-only).
- Find + propose receipt matches; verify with vision → confirm-to-attach (§9 + §10).
- Document service: read/verify receipts, in-chat upload, generate *bilag* PDFs.
- Confirmation guardrails on writes.

**Phase 3 — Monetize**
- Stripe subscription + metered overage; usage dashboard; budget guardrails.

**Phase 4 — Expand storages**
- Drive/Dropbox, Stripe, bank feeds, more accounting actions.

---

## 14. Open decisions / questions for you

1. **e-conomic app registration** — upload is confirmed possible via the REST
   API (no separate Apps/Files API needed); we just need our registered app's
   `AppSecretToken` and the per-user grant-token flow.
2. **Auth provider** — Auth.js (more control, free) vs Clerk (faster, paid)?
3. **DB/host** — Supabase (auth+db+storage bundled) vs Neon + Auth.js?
4. **Language/market** — Danish-first UI & agent? (Assuming yes given e-conomic.)
5. **Pricing anchor** — what monthly price feels right for the target SMB so we
   can size the included credit bucket against it?
6. **Compliance appetite** — how much GDPR/DPA groundwork up front vs. after PMF?

---

## 15. TL;DR

- You've **already built the hardest connector** (e-conomic MCP). The platform is
  a per-user MCP **host** + chat UI + auth + billing around it.
- Recommended: **monorepo**, **Next.js on Vercel**, **Claude Agent SDK**,
  **Postgres**, Google sign-in, encrypted per-user tokens.
- **Attach receipts: confirmed doable.** e-conomic's REST API supports uploading
  voucher attachments (POST multipart, PDF/JPG/PNG, draft & booked). Our bundled
  OpenAPI spec just omits it. Only net-new work: add a multipart upload tool to
  the connector.
- **Documents are first-class:** Claude vision reads/verifies receipts (PDF +
  image) before anything is booked; the platform also generates PDFs (reports and
  *bilag* it creates itself); users can upload files straight into the chat.
- **Cost is a first-class design constraint:** subscription + metered overage,
  model routing, pre-filtering, background batching, and hard budget guardrails
  keep per-workflow cost under the revenue it consumes.
