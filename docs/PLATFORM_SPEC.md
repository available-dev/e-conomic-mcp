# AI Accountant Platform — Architecture & Build Spec

> Status: **Draft for review** · Owner: rasmus@available.dk · Date: 2026-06-07
>
> A hosted web app where a user signs up with a magic link, connects their accounting
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

**The accounting system itself is just a connector.** e-conomic is the first
backend, but **Dinero** (and others) are planned — same pattern: a Dinero MCP
connector the user attaches instead of, or alongside, e-conomic. So the agent,
chat UI, and the whole receipt workflow are written against a *generic
accounting capability*, not hard-wired to e-conomic. Picking a different backend
is a connector swap, not a rewrite.

---

## 3. High-level architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Web app  (Next.js · hosted on Vercel)                         │
│  • Magic-link sign-in (email)                                  │
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

## 4. Repo layout — **platform is its own repo; connectors are separate**

> Updated decision. An earlier draft recommended a monorepo with the platform
> living inside `e-conomic-mcp`. That stops making sense once there's a **second
> accounting backend (Dinero)** — the platform sits *above* all connectors, and
> e-conomic is just one of them. So the platform gets its **own repo**, and each
> connector stays its own publishable package/repo.

```
<platform-repo>/                 ← NEW repo (the product: app + agent + marketing)
├── apps/
│   ├── web/                     ← Next.js app (UI + agent + API routes)
│   └── marketing/               ← the landing page
├── packages/
│   ├── connectors/              ← connector registry / MCP launching + the
│   │                              generic "accounting capability" interface
│   └── core/                    ← shared types, db schema, crypto helpers
└── docs/                        ← this spec moves here

available/e-conomic-mcp          ← stays as-is: one connector (@available/e-conomic-mcp)
available/dinero-mcp             ← future: a second accounting connector
available/<gmail-mcp, …>         ← future: more storages
```

**Why a separate platform repo:**

- **Many backends, one platform.** e-conomic, Dinero, and future storages are
  independent connectors with their own release cadence. The platform consumes
  them; it shouldn't live inside any one of them.
- **Clean licensing/visibility split.** Connectors can stay open-source; the
  platform (product, billing, prompts) can have its own policy.
- **The "accounting capability" is an interface.** The platform codes against a
  generic accounting connector contract (find vouchers missing docs, upload
  attachment, …) that e-conomic and Dinero connectors each satisfy.

**Mechanics / migration note:** the spec + marketing page were drafted inside
`e-conomic-mcp` (PR #7) because that was the available repo in that session. They
should move to the new platform repo. Creating the repo is easy; **populating it
requires a session scoped to that repo** (the sandbox git remote is scoped per
session).

---

## 5. Tech stack

| Layer            | Choice                                   | Why |
|------------------|------------------------------------------|-----|
| Framework        | **Next.js (App Router)**                 | UI + API routes + streaming in one deployable |
| Host             | **Vercel** (start), revisit Cloudflare   | Easiest Next.js + Node agent path; see §12 |
| Auth             | **Auth.js (NextAuth)** Email provider (magic link) | Passwordless, provider-agnostic login |
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
users            (id, email, email_verified_at, created_at)
connections      (id, user_id, storage_kind, status,
                  credentials_encrypted, scopes, created_at, expires_at)
threads          (id, user_id, title, created_at)
messages         (id, thread_id, role, content, tool_calls_json, created_at)
usage_events     (id, user_id, thread_id, model, input_tokens,
                  output_tokens, real_cost_cents, credits_charged, created_at)
wallets          (id, user_id, balance_credits, auto_reload_threshold,
                  auto_reload_amount, stripe_customer_id, updated_at)
credit_topups    (id, user_id, credits, amount_paid_cents, currency,
                  stripe_payment_id, created_at)
files            (id, user_id, kind[receipt|generated|report],
                  source[gmail|chat_upload|generated], storage_url, mime,
                  sha256, extracted_json, linked_voucher, message_id, created_at)
```

`storage_kind` ∈ {`economic`, `gmail`, `microsoft`, `drive`, …}.
`credentials_encrypted` holds the storage-specific token blob (e-conomic
agreement grant token, Google/Microsoft OAuth refresh token, …), encrypted at
rest. Login uses magic link, so also: `verification_tokens` (Auth.js) and
`sessions` — separate from the data-source `connections` above.

---

## 7. Auth & per-user credentials (the crux of multi-tenancy)

**Two separate concepts — keep them apart:**

1. **Login (who you are)** → **magic link** (passwordless email). No password, no
   Google/Microsoft account required to sign up.
2. **Connections (what the agent can touch)** → each data source (e-conomic,
   Gmail, Microsoft, …) is connected *separately*, after login, via its own OAuth.

> Why decouple: login isn't tied to any provider, so a user can connect **Gmail
> or Microsoft (or neither)** as their inbox storage. Adding Microsoft later is
> "another inbox connector," not an auth migration. It also keeps the signup
> friction tiny — just an email.

### Login — magic link
- **Auth.js Email provider:** user enters email → we send a one-time sign-in link
  → clicking it creates/restores the session. Tokens/sessions in our Postgres
  (Auth.js adapter); needs a `verification_tokens` table.
- **Email delivery: Resend** (decided). Transactional sender for the sign-in
  mail — simple API, React Email templates, generous free tier. One of the few
  things Vercel doesn't provide natively (see §12). Needs domain verification
  (SPF/DKIM) on `konteo.ai` at Cloudflare.
- Optional later: add Google/Microsoft as *login* options too — but magic link is
  the primary, provider-agnostic path.

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

### Inbox — Gmail (now) and Microsoft (later)
- **Gmail / Google:** OAuth 2.0, scope `gmail.readonly` to start — read-only is
  enough to *find* receipts; no send/modify for v1.
- **Microsoft / Outlook (planned):** Microsoft Graph OAuth, scope `Mail.Read`.
  Same connector shape — the agent sees a generic "inbox" capability regardless
  of provider, so the receipt workflow is identical.
- Store refresh tokens encrypted; mint access tokens on demand.

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
- System prompt frames the agent as a careful **bookkeeping assistant** that
  cites what it found and **asks before writing** to e-conomic (no silent
  mutations of accounting records).
- **Language:** the **UI is English**, but the agent **mirrors the user's
  language** — if they write in Danish, it replies in Danish; English in, English
  out. (Detect per-message; default English.)
- Tool-call audit + cost metering wrap every step.
- **Guardrails:** write operations to e-conomic (booking, attaching) require an
  explicit confirmation step surfaced in the UI ("Attach receipt X to voucher Y?
  [Confirm]") before execution.

### Chat UX — tabs, persistence, kickoff briefing
- **Multiple chats in tabs.** The app runs several conversations at once (like
  browser tabs) so the user can have different things going in parallel — one tab
  reconciling April receipts, another drafting an invoice, another asking a
  question. Each tab is an **independent agent thread** with its own context.
- **Persistence.** Tabs and their history are saved (`threads` + `messages`) and
  restored on return, across devices/sessions — closing the app loses nothing.
  Tabs get auto-titles from their first task (e.g. "April receipts").
- **Kickoff briefing.** Every *new* chat opens with an auto-generated **status on
  the current regnskab**, produced before the user types anything — the agent
  queries the accounting connector and summarizes. e.g. *"April: 3 vouchers
  missing receipts · 2 draft invoices unsent · VAT period closes in 6 days."*
  It orients the user and offers one-tap next actions ("Find the 3 receipts →").
  - **Keep it cheap:** the briefing is a short, **cheap-model** (Sonnet/Haiku)
    summary over a few targeted connector reads, cached briefly — not a full Opus
    turn. (A cost lever, per §11; also it shouldn't burn the user's credits just
    to open a tab — fund kickoffs from a tiny allowance or the cheap model.)

---

## 9. Flagship workflow: find & attach receipts

**User:** *"Find receipts for my April expenses that are missing documentation."*

1. Agent queries e-conomic for vouchers/entries in April lacking an attachment.
2. For each, it extracts a fingerprint (amount, date, supplier).
3. Agent searches Gmail for matching receipts (`from:`, amount, date window).
4. Agent proposes matches in chat with confidence + preview.
5. On user confirm → agent attaches the receipt file to the e-conomic voucher.

### Attaching the receipt — **already implemented in the connector**
The e-conomic connector in this repo (on `main`) **already supports multipart
file upload to attachment endpoints**. No new connector work is needed for the
attach step. Available tools today:

- **`economic_upload_file`** — universal multipart upload. `POST` creates an
  attachment, `PATCH` appends pages (vouchers). Targets any attachment endpoint,
  e.g. `/journals/{j}/vouchers/{accountingYear}-{voucherNumber}/attachment/file`
  or `/invoices/drafts/{n}/attachment/file`. Accepts a **local file path or
  inline base64**; auth headers and the multipart boundary are set automatically.
- **`economic_upload_voucher_attachment`** / **`_get_`** / **`_delete_`** —
  typed convenience tools for the voucher-attachment lifecycle.
- **Dynamic per-endpoint upload tools** — generated from the OpenAPI spec wherever
  a `multipart/form-data` body is declared (`openapi.ts` sets a `fileUpload`
  flag; `economicClient.uploadFile()` does the work).

Supported formats: PDF / JPG / JPEG / GIF / PNG, for both draft and booked
vouchers.

> Correction to an earlier draft of this spec: a previous revision claimed the
> connector could only `GET` attachments and that upload was unbuilt. That was
> wrong — it was based on an out-of-date branch. Upload has been implemented on
> `main`. The full *find → verify → propose → confirm → attach* loop is
> achievable with the connector as-is.

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

### Pricing model — **prepaid credits, ~2–3× markup, markup hidden**
Decided: **usage-only, prepaid credit wallet.** No subscription tiers.

- The user **tops up a credit balance** (e.g. 200 kr) and the agent **burns
  credits as it works**. When the balance runs low, they top up again.
- Pricing math (internal, never shown): meter the **real model spend** per
  agent turn (via AI Gateway), multiply by a **3× markup**, deduct from the
  wallet. Users see *credits*, never tokens or the multiplier.
- **$5 in free credits on signup** so people can try the flagship workflow before
  paying. (At 3× markup that's ~$1.67 of real model spend — enough to reconcile a
  month or two of receipts.)
- **Stripe shrinks to one job: top-ups** (one-time payments / saved card for
  auto-reload). No subscriptions, no metered Stripe usage records, no invoicing
  logic. Much simpler than the earlier subscription design.

> Why this fits: margin is structural (2–3× on every call) rather than something
> we have to defend against a flat monthly price. A heavy user just burns credits
> faster — they can never cost us more than they paid. The earlier "never let
> spend exceed the plan price" risk disappears entirely.

**Wallet mechanics**
- `wallet.balance_credits` per user; each `usage_event` records real cost +
  marked-up credits deducted, so margin and burn are observable per workflow.
- **Auto-reload** (optional): top up X when balance < Y, so the agent never
  stalls mid-task.
- **Low-balance UX:** warn in chat before a long job if credits look
  insufficient; offer one-tap top-up.

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
5. **Credit guardrails** — the wallet balance *is* the ceiling: the agent host
   checks remaining credits before/within a run; when low, it pauses and prompts
   a top-up rather than running the balance negative.
6. **Pre-filter before the model** — use deterministic code (amount/date
   matching) to shortlist candidates, and only ask the model to disambiguate the
   ambiguous few.

### Unit-economics target
Track **cost-per-completed-workflow** (e.g. "cost to reconcile one month of
receipts"). With the 2–3× markup this is automatically profitable per call, but
instrument it anyway — it's how we set the markup, size signup credits, and spot
workflows whose real cost drifts (e.g. a model change) before margin erodes.

---

## 12. Hosting: single-service, Vercel-first

Goal (decided): **use as close to one service as possible.** Verdict: very
achievable. Vercel-native primitives cover almost everything; there's exactly
**one real gap (a database)** and **one if-you-charge gap (payments)**.

### What Vercel covers natively

| Need | Vercel-native | Status |
|---|---|---|
| Hosting / SSR / API | Functions + **Fluid Compute** | ✅ |
| **Long agent calls** | Fluid Compute: **300s default, up to 800s** (Pro); **Vercel Workflows** for *unlimited* pause/resume (minutes→months) | ✅ |
| Background jobs (scan a month) | **Cron Jobs** + **Workflows** + `waitUntil` | ✅ |
| Agent/chat runtime | **Vercel AI SDK 6** (open-source) | ✅ |
| LLM calls + spend control | **AI Gateway** → Anthropic (streaming, tool calls, traces, failover, centralized spend) | ✅ |
| Receipt/PDF storage | **Vercel Blob** | ✅ |
| Flags / fast config | **Edge Config** | ✅ |
| Login (magic link) | **Auth.js** Email provider — open-source lib *in* the app, sessions in our DB | ✅ no 3rd-party auth vendor |
| Sending the magic-link email | ❌ no Vercel-native email → **Resend** (decided) | ⚠️ small gap |
| **Database** | ❌ Vercel Postgres/KV **sunset**; only via **Marketplace** (Neon Postgres) | ⚠️ gap |
| Payments (top-ups) | ❌ no Vercel-native payments → **Stripe** | ⚠️ only when charging |

### The long-running-agent risk is basically gone
Earlier drafts flagged long agent loops as a hosting risk. **Fluid Compute**
(300s default / 800s max) covers most interactive turns, and **Vercel Workflows**
gives durable, unlimited-duration execution with pause/resume for the heavy
"scan all of April" batch — no external queue (Inngest/QStash) needed.

### "One service", honestly
- **Strict first-party-only** hits a wall at the **database** (don't abuse
  Blob/Edge Config for relational data).
- **One account / one bill / one dashboard** is fully achievable: **Vercel +
  Vercel Marketplace**, which provisions **Neon Postgres** with automatic
  provisioning and **unified billing** — no separate account or invoice. From
  the operator's seat it's still one service.
- **Outside Vercel you need just two small services:** a transactional email
  sender (**Resend**) for magic-link login, and **Stripe** for credit top-ups
  (Phase 3). Both are tiny, well-scoped integrations — not a second platform.
- Bonus: **AI Gateway** doubles as the cost-control layer (metered spend +
  observability + failover), so "use Vercel" and "control token cost" align.

### Cloudflare?
Cheaper egress/compute at scale, but Workers runtime constraints and a more
fragmented storage story make it a worse fit for "one service + Node agent."
Revisit only if compute/egress cost ever dominates.

### Domain & DNS — `konteo.ai` (registered at Cloudflare)
**Registrar ≠ host.** Cloudflare is the **registrar + DNS** for `konteo.ai`; the
app still runs on **Vercel**. We just point DNS at Vercel. No change to the
Vercel-first decision.

Subdomain plan:
| Host | Serves | Where |
|---|---|---|
| `konteo.ai` (+ `www`) | Marketing landing page | Vercel (static `apps/marketing`) |
| `app.konteo.ai` | The product (auth, chat, agent) | Vercel (`apps/web`) |
| `api.konteo.ai` *(optional)* | Public API / webhooks later | Vercel functions |

Wiring notes:
- Add each domain in the Vercel project, then create the DNS records Vercel
  shows at Cloudflare (apex → A/ALIAS, subdomains → CNAME).
- Set Cloudflare records to **DNS-only (grey cloud)** for the Vercel hosts, or if
  proxied (orange cloud), use SSL/TLS mode **Full (strict)** to avoid redirect
  loops / double-CDN issues. Simplest: DNS-only and let Vercel handle TLS/CDN.
- Google OAuth callback + Stripe webhooks point at `app.konteo.ai`.

---

## 13. Phased roadmap

**Phase 0 — De-risk (days)**
- ✅ e-conomic file upload **already implemented in the connector**
  (`economic_upload_file` + typed voucher-attachment tools, multipart,
  PDF/JPG/PNG, draft & booked). Nothing to build here.
- Confirm e-conomic multi-tenant grant-token flow end to end.
- Spike: Claude Agent SDK loading the e-conomic MCP with injected per-user creds.

**Phase 1 — Skateboard MVP**
- Next.js + **magic-link sign-in** (Auth.js Email + Resend) + Postgres.
- Connect **one** storage (e-conomic) with per-user grant token.
- **Multi-tab, persisted chat** (threads restore on return) with a **kickoff
  regnskab briefing** on each new tab.
- Chat that can *read* e-conomic ("list my April expenses missing receipts").
- Meter real model spend per turn (via AI Gateway) → record `usage_events`.

**Phase 2 — Flagship workflow**
- Add Gmail connection (read-only).
- Find + propose receipt matches; verify with vision → confirm-to-attach (§9 + §10).
- Document service: read/verify receipts, in-chat upload, generate *bilag* PDFs.
- Confirmation guardrails on writes.

**Phase 3 — Monetize (prepaid credits)**
- Credit wallet + **3× markup** on metered spend (hidden); **$5 signup grant**;
  Stripe **top-ups** only (one-time + optional auto-reload); low-balance UX;
  credit guardrails in the agent host. No subscriptions.

**Phase 4 — Expand storages**
- **Microsoft / Outlook inbox** (Graph), Dinero accounting connector,
  Drive/Dropbox, bank feeds, more accounting actions.

---

## 14. Open decisions / questions for you

1. **e-conomic app registration** — upload is already implemented in the
   connector; we just need our registered app's `AppSecretToken` and the per-user
   grant-token flow wired into the platform.
2. ✅ **Hosting** — decided: **Vercel-first / single-service** (Vercel native +
   Neon Postgres via Marketplace for unified billing; Auth.js for login).
3. ✅ **Pricing** — decided: **prepaid credits, 3× markup (hidden), top-up via
   Stripe, $5 free credits on signup.** No subscriptions.
4. **Agent runtime** — **Vercel AI SDK 6** (tightest Next.js + one-line
   human-in-the-loop for our confirm-before-write step) vs **Claude Agent SDK**
   (best MCP/caching/compaction). Both route through AI Gateway. Lean AI SDK 6
   for the web app unless MCP ergonomics push us the other way.
5. ✅ **Language** — decided: **English UI; agent mirrors the user's language**
   (replies in Danish to Danish input).
6. **Compliance appetite** — how much GDPR/DPA groundwork up front vs. after PMF?

---

## 15. TL;DR

- You've **already built the hardest connector** (e-conomic MCP). The platform is
  a per-user MCP **host** + chat UI + auth + billing around it.
- **Single-service, Vercel-first:** Functions/Fluid Compute, Workflows, Cron,
  Blob, Edge Config, AI SDK 6 + AI Gateway — plus **Neon Postgres via the Vercel
  Marketplace** (unified billing) and **Auth.js magic-link** login. Outside
  Vercel only: Neon (via Marketplace), Resend (magic-link email), Stripe (top-ups).
- **Attach receipts: already built.** The connector ships multipart upload tools
  (`economic_upload_file` + typed voucher-attachment tools, PDF/JPG/PNG, draft &
  booked). No connector work needed for the flagship action.
- **Documents are first-class:** Claude vision reads/verifies receipts (PDF +
  image) before anything is booked; the platform also generates PDFs (reports and
  *bilag* it creates itself); users can upload files straight into the chat.
- **Billing = prepaid credits:** users top up a wallet; we meter real spend ×
  **2–3× markup** (hidden) and deduct credits. Margin is structural, so a heavy
  user can never cost more than they paid. Model routing, pre-filtering,
  background batching and AI Gateway keep the underlying cost low.
