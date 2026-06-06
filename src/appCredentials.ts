/**
 * Bundled credentials for the published "e-conomic MCP" app.
 *
 * These ship with the package so users can connect with only a browser grant
 * (an agreement grant token) — without registering their own e-conomic app.
 *
 * Security trade-off (see README): the app secret token is intentionally
 * bundled here. e-conomic's API still requires a per-agreement grant token on
 * every call, so the secret token ALONE cannot read or write any agreement's
 * data. If the secret is ever compromised, rotate it in the e-conomic developer
 * portal and update the value below (this invalidates existing installs).
 *
 * Both values are overridable at runtime: environment variables and the local
 * credential store take precedence over these defaults.
 */

/** Public token — used to build the grant/install URL. Safe to expose. */
export const BUNDLED_APP_PUBLIC_TOKEN =
  "7UGt3C45vO7xzpAshAGyP9hBEqfkAgS8RCztza3yz0Q";

/**
 * App secret token — sent as X-AppSecretToken on every API call.
 * Empty until set; when empty, users must supply their own via env/connect.
 */
export const BUNDLED_APP_SECRET_TOKEN = "";
