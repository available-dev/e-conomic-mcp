/**
 * Bundled configuration for the published "e-conomic MCP" app.
 *
 * These ship with the package so users can connect with only a browser grant
 * (an agreement grant token) — without registering their own e-conomic app and
 * without ever handling the app secret token.
 *
 * The app secret token is NOT here. It lives only in the hosted proxy (see
 * ../proxy), which injects it server-side. The client below just needs to know
 * where that proxy is.
 *
 * Everything is overridable at runtime: environment variables and the local
 * credential store take precedence over these defaults.
 */

/** Public token — used to build the grant/install URL. Safe to expose. */
export const BUNDLED_APP_PUBLIC_TOKEN =
  "7UGt3C45vO7xzpAshAGyP9hBEqfkAgS8RCztza3yz0Q";

/**
 * Base URL of the hosted proxy that injects the app secret token server-side
 * (the deployed Cloudflare Worker from ../proxy).
 *
 * When set, the client talks to the proxy and needs no app secret token.
 * When empty, the client talks directly to e-conomic and a user-supplied app
 * secret token is required.
 */
export const BUNDLED_PROXY_URL = "https://e-conomic-mcp-proxy.byteable-aps.workers.dev";
