# e-conomic MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the
[e-conomic REST API](https://restdocs.e-conomic.com/). It lets MCP-compatible
clients (Claude Desktop, Claude Code, Cursor, etc.) read and write e-conomic
accounting data — customers, suppliers, products, invoices, orders, journals,
accounts and more.

Unlike the few existing community/hosted e-conomic integrations (which expose
only a handful of endpoints), this server is **open-source, self-hostable, and
covers the whole API**: a generic request tool reaches every endpoint, typed
convenience tools cover the common workflows, and per-endpoint tools can be
generated from an OpenAPI spec.

## Quickstart

```bash
# install
npm install -g @available-dev/e-conomic-mcp

# store your e-conomic credentials locally (app secret + agreement grant token)
e-conomic-mcp auth login

# verify it talks to the API
e-conomic-mcp doctor        # → ✓ Authenticated. N resource collections available.
```

Then add it to your MCP client (e.g. Claude Code):

```bash
claude mcp add e-conomic -- e-conomic-mcp
```

…or in `claude_desktop_config.json`:

```json
{ "mcpServers": { "e-conomic": { "command": "e-conomic-mcp" } } }
```

Now ask Claude things like *"list my 5 most recent e-conomic customers"*.

## Features

- **Full API coverage** via a universal `economic_request` tool — any method,
  any path.
- **File uploads** via `economic_upload_file` and typed attachment tools —
  attach receipts/PDFs to vouchers, draft invoices, orders and quotes using
  e-conomic's `multipart/form-data` endpoints (which `economic_request` can't
  reach, as it only sends JSON).
- **Typed convenience tools** for the high-traffic resources (customers,
  suppliers, products, draft/booked invoices, orders, quotes, journals,
  accounts, groups, payment terms, VAT zones, currencies, units, employees).
- **Built-in pagination, filtering and sorting** for collection reads.
- **Discovery tools** to list resources and (with a spec) describe an endpoint's
  parameters and body schema before you call it.
- **Optional dynamic per-endpoint tools** generated from an OpenAPI/Swagger spec
  (Swagger 2.0 or OpenAPI 3.x).
- **stdio transport** — drops straight into local MCP clients.

## Requirements

- Node.js >= 18
- e-conomic credentials: an **app secret token** and an **agreement grant
  token** (see below).

## Install

### From npm

```bash
npm install -g @available-dev/e-conomic-mcp
```

This puts an `e-conomic-mcp` command on your PATH.

### From source

```bash
git clone https://github.com/available-dev/e-conomic-mcp.git
cd e-conomic-mcp
npm install            # also builds via the prepare script
npm link               # optional: expose the `e-conomic-mcp` command globally
```

## CLI

```text
e-conomic-mcp [serve]            Start the MCP server over stdio (default)
e-conomic-mcp auth login         Interactively store credentials locally
e-conomic-mcp auth set [flags]   Store credentials non-interactively
e-conomic-mcp auth status        Show where credentials are coming from
e-conomic-mcp auth logout        Remove locally stored credentials
e-conomic-mcp doctor             Check credentials and API connectivity
e-conomic-mcp --help | --version
```

## Authentication

e-conomic authenticates every REST call with two tokens, sent as headers:

| Header | Env var | What it is |
| --- | --- | --- |
| `X-AppSecretToken` | `ECONOMIC_APP_SECRET_TOKEN` | Identifies your integration/app. From the e-conomic developer portal. |
| `X-AgreementGrantToken` | `ECONOMIC_AGREEMENT_GRANT_TOKEN` | Identifies the company/agreement that granted your app access. |

You can provide them two ways (environment variables always take precedence):

1. **Store them locally** with the CLI (recommended for desktop use):

   ```bash
   e-conomic-mcp auth login                     # interactive prompt
   # or non-interactively:
   e-conomic-mcp auth set --app-secret <token> --agreement-grant <token>
   ```

   Credentials are written to `~/.config/e-conomic-mcp/credentials.json`
   (override with `$ECONOMIC_CONFIG_DIR` / `$XDG_CONFIG_HOME`) with `0600`
   permissions. Check with `e-conomic-mcp auth status`; remove with
   `e-conomic-mcp auth logout`.

2. **Environment variables** — set `ECONOMIC_APP_SECRET_TOKEN` and
   `ECONOMIC_AGREEMENT_GRANT_TOKEN` (e.g. in your MCP client config, or via
   `.env`).

> OAuth support is planned; the credential store format is forward-compatible
> with it.

## Usage

### With Claude Desktop / Claude Code

If you ran `e-conomic-mcp auth login`, the MCP config is just:

```json
{
  "mcpServers": {
    "e-conomic": { "command": "e-conomic-mcp" }
  }
}
```

Otherwise pass the tokens via `env`:

```json
{
  "mcpServers": {
    "e-conomic": {
      "command": "e-conomic-mcp",
      "env": {
        "ECONOMIC_APP_SECRET_TOKEN": "your-app-secret-token",
        "ECONOMIC_AGREEMENT_GRANT_TOKEN": "your-agreement-grant-token"
      }
    }
  }
}
```

(If you didn't install globally, use `"command": "node"` with
`"args": ["/absolute/path/to/e-conomic-mcp/dist/index.js"]`.)

### Run directly

```bash
ECONOMIC_APP_SECRET_TOKEN=... ECONOMIC_AGREEMENT_GRANT_TOKEN=... e-conomic-mcp
```

The server speaks MCP over stdio. Use `e-conomic-mcp doctor` to verify your
credentials and connectivity first.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `ECONOMIC_APP_SECRET_TOKEN` | _(required)_ | App secret token. |
| `ECONOMIC_AGREEMENT_GRANT_TOKEN` | _(required)_ | Agreement grant token. |
| `ECONOMIC_BASE_URL` | `https://restapi.e-conomic.com` | API base URL. |
| `ECONOMIC_OPENAPI_SPEC` | _(bundled)_ | Override the bundled OpenAPI spec with a path/URL (e.g. a newer one). |
| `ECONOMIC_DYNAMIC_TOOLS` | `false` | Generate one tool per operation from the spec. |
| `ECONOMIC_DYNAMIC_TOOLS_LIMIT` | `200` | Max number of dynamic tools to generate. |
| `ECONOMIC_PAGE_SIZE` | `100` | Default page size for collection reads (max 1000). |
| `ECONOMIC_TIMEOUT_MS` | `30000` | Per-request timeout. |

## Tools

### Generic (always available)

- **`economic_request`** — call any endpoint: `{ method, path, query?, body? }`.
  Sends a JSON body, so it cannot be used for binary file uploads — use
  `economic_upload_file` for those.
- **`economic_upload_file`** — upload a binary file to any `multipart/form-data`
  endpoint: `{ path, filePath | content, fileName?, contentType?, method? }`.
  The universal escape hatch for the attachment endpoints. Supply the file as a
  local `filePath` or base64 `content`. Supported formats: `.pdf`, `.jpg`,
  `.jpeg`, `.gif`, `.png` (draft invoices/orders/quotes accept PDF only); max
  9 MB. Use `method: "PATCH"` to append pages to an existing voucher attachment.
- **`economic_list_resources`** — list resource collections (from the spec, or
  the API's self-describing root).
- **`economic_get_collection`** — fetch a collection with `filter`, `sort`,
  `pageSize`, `maxItems`, `fetchAll`.
- **`economic_describe_endpoint`** — show an endpoint's parameters, request-body
  and response schema (from the bundled OpenAPI spec).

### Typed convenience tools

`economic_list_*` and `economic_get_*` for: customers, suppliers, products,
accounts, draft invoices, booked invoices, orders, quotes, journals,
departments, product/customer/supplier groups, payment terms, VAT zones, VAT
accounts, currencies, units, employees.

Writes: `economic_create_customer`, `economic_update_customer`,
`economic_create_draft_invoice`, `economic_book_draft_invoice`.

Attachments: `economic_upload_voucher_attachment` (with `append` to add pages),
`economic_get_voucher_attachment`, `economic_delete_voucher_attachment`, and
`economic_upload_draft_invoice_attachment` / `_draft_order_attachment` /
`_draft_quote_attachment`.

### Dynamic per-endpoint tools

When `ECONOMIC_DYNAMIC_TOOLS=true`, every operation in the spec is exposed as an
`economic_op_<operationId>` tool with a generated input schema (176 operations;
bounded by `ECONOMIC_DYNAMIC_TOOLS_LIMIT`). Operations with a
`multipart/form-data` body (the attachment uploads) take `filePath`/`content`
inputs and are sent as multipart automatically.

## Filtering & sorting

e-conomic uses a compact filter syntax, e.g.:

- `name$like:Acme` — name contains "Acme"
- `customerNumber$gte:1000` — customer number ≥ 1000
- combine with `$and:` / `$or:`

Sort by a field name; prefix with `-` for descending (e.g. `-customerNumber`).

## Bundled API spec

The package ships with [`spec/economic-openapi.json`](./spec/economic-openapi.json)
— an OpenAPI 3 description of all **160 e-conomic endpoints** (paths, methods,
and request/response schemas), generated from e-conomic's published per-endpoint
JSON schemas. It loads automatically and powers `economic_describe_endpoint` and
dynamic per-endpoint tools with zero configuration.

To override it (e.g. point at a newer spec), set `ECONOMIC_OPENAPI_SPEC` to your
own spec path/URL.

## Development

```bash
npm run typecheck   # type-check only
npm run watch       # incremental compile
npm run doctor      # verify credentials/connectivity (needs env vars)
```

## Publishing to npm

The package builds to `dist/` and exposes the `e-conomic-mcp` bin. `prepare`
builds on install and `prepublishOnly` does a clean rebuild before publish.

```bash
npm run build
npm pack --dry-run     # inspect the tarball contents
npm publish            # publishConfig.access is already set to public
```

Bump the version with `npm version <patch|minor|major>` first. Publish once the
server is verified against a live e-conomic account.

## Disclaimer

This is an independent, community project and is not affiliated with or endorsed
by e-conomic / Visma. "e-conomic" is a trademark of its respective owner. Use in
accordance with e-conomic's API terms.

## License

[MIT](./LICENSE)
