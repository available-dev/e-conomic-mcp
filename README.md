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

## Features

- **Full API coverage** via a universal `economic_request` tool — any method,
  any path.
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

## Install & build

```bash
npm install
npm run build
```

## Authentication

e-conomic authenticates every REST call with two tokens, sent as headers:

| Header | Env var | What it is |
| --- | --- | --- |
| `X-AppSecretToken` | `ECONOMIC_APP_SECRET_TOKEN` | Identifies your integration/app. From the e-conomic developer portal. |
| `X-AgreementGrantToken` | `ECONOMIC_AGREEMENT_GRANT_TOKEN` | Identifies the company/agreement that granted your app access. |

Copy `.env.example` to `.env` and fill both in (or set them in your MCP client
config). For experimentation, e-conomic publishes demo tokens in their docs.

## Usage

### With Claude Desktop / Claude Code

Add to your MCP client config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "e-conomic": {
      "command": "node",
      "args": ["/absolute/path/to/e-conomic-mcp/dist/index.js"],
      "env": {
        "ECONOMIC_APP_SECRET_TOKEN": "your-app-secret-token",
        "ECONOMIC_AGREEMENT_GRANT_TOKEN": "your-agreement-grant-token"
      }
    }
  }
}
```

### Run directly

```bash
ECONOMIC_APP_SECRET_TOKEN=... ECONOMIC_AGREEMENT_GRANT_TOKEN=... node dist/index.js
```

The server speaks MCP over stdio.

## Configuration

| Env var | Default | Description |
| --- | --- | --- |
| `ECONOMIC_APP_SECRET_TOKEN` | _(required)_ | App secret token. |
| `ECONOMIC_AGREEMENT_GRANT_TOKEN` | _(required)_ | Agreement grant token. |
| `ECONOMIC_BASE_URL` | `https://restapi.e-conomic.com` | API base URL. |
| `ECONOMIC_OPENAPI_SPEC` | _(unset)_ | Path or URL to an OpenAPI/Swagger spec. Enables `economic_describe_endpoint` and dynamic tools. |
| `ECONOMIC_DYNAMIC_TOOLS` | `false` | Generate one tool per OpenAPI operation (requires a spec). |
| `ECONOMIC_DYNAMIC_TOOLS_LIMIT` | `200` | Max number of dynamic tools to generate. |
| `ECONOMIC_PAGE_SIZE` | `100` | Default page size for collection reads (max 1000). |
| `ECONOMIC_TIMEOUT_MS` | `30000` | Per-request timeout. |

## Tools

### Generic (always available)

- **`economic_request`** — call any endpoint: `{ method, path, query?, body? }`.
- **`economic_list_resources`** — list resource collections (from the spec, or
  the API's self-describing root).
- **`economic_get_collection`** — fetch a collection with `filter`, `sort`,
  `pageSize`, `maxItems`, `fetchAll`.
- **`economic_describe_endpoint`** — _(spec only)_ show an endpoint's parameters
  and request-body schema.

### Typed convenience tools

`economic_list_*` and `economic_get_*` for: customers, suppliers, products,
accounts, draft invoices, booked invoices, orders, quotes, journals,
departments, product/customer/supplier groups, payment terms, VAT zones, VAT
accounts, currencies, units, employees.

Writes: `economic_create_customer`, `economic_update_customer`,
`economic_create_draft_invoice`, `economic_book_draft_invoice`.

### Dynamic per-endpoint tools

When `ECONOMIC_DYNAMIC_TOOLS=true` and a spec is configured, every operation in
the spec is exposed as an `economic_op_<operationId>` tool with a generated
input schema.

## Filtering & sorting

e-conomic uses a compact filter syntax, e.g.:

- `name$like:Acme` — name contains "Acme"
- `customerNumber$gte:1000` — customer number ≥ 1000
- combine with `$and:` / `$or:`

Sort by a field name; prefix with `-` for descending (e.g. `-customerNumber`).

## Providing an OpenAPI spec

The server works without a spec. To unlock `economic_describe_endpoint` and
dynamic tools, point `ECONOMIC_OPENAPI_SPEC` at e-conomic's OpenAPI/Swagger
file (downloadable from e-conomic's developer/API portal) — either a local path
(e.g. `./spec/economic-openapi.json`) or a URL.

## Development

```bash
npm run typecheck   # type-check only
npm run watch       # incremental compile
```

## Disclaimer

This is an independent, community project and is not affiliated with or endorsed
by e-conomic / Visma. "e-conomic" is a trademark of its respective owner. Use in
accordance with e-conomic's API terms.

## License

[MIT](./LICENSE)
