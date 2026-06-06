/**
 * Browser-based connect flow for obtaining an agreement grant token.
 *
 * e-conomic's "grant access" handshake works like this:
 *
 *   1. The integration sends the user to e-conomic's request-access page with
 *      its *public* token and a redirect URL:
 *        https://secure.e-conomic.com/secure/api1/requestaccess.aspx
 *          ?appPublicToken=<APP_PUBLIC_TOKEN>&redirectUrl=<REDIRECT_URL>
 *   2. The user logs into e-conomic and approves access for one of their
 *      agreements (companies).
 *   3. e-conomic redirects the browser back to <REDIRECT_URL> with the freshly
 *      minted agreement grant token appended as `?token=<grantToken>`.
 *
 * To capture step 3 without a hosted backend, this module spins up a temporary
 * loopback HTTP server, opens the request-access page in the user's browser,
 * and resolves once e-conomic redirects back to it. The captured token is the
 * `X-AgreementGrantToken` the API needs.
 *
 * The redirect URL must EXACTLY match the one registered on the app in the
 * e-conomic developer portal, so the host/port/path are stable by default
 * (http://localhost:8088/callback) and only change if you override them.
 */

import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";

export const DEFAULT_CALLBACK_HOST = "localhost";
export const DEFAULT_CALLBACK_PORT = 8088;
export const DEFAULT_CALLBACK_PATH = "/callback";

const GRANT_ACCESS_URL =
  "https://secure.e-conomic.com/secure/api1/requestaccess.aspx";

export interface ConnectOptions {
  /** The app's public token (from the developer portal). */
  appPublicToken: string;
  /** Hostname the loopback server binds to and advertises. */
  host?: string;
  /** Port the loopback server listens on. Must match the registered redirect. */
  port?: number;
  /** Path component of the redirect URL. Must match the registered redirect. */
  path?: string;
  /** Try to open the user's default browser automatically (default: true). */
  openBrowser?: boolean;
  /** Give up waiting for the redirect after this many ms (default: 300000). */
  timeoutMs?: number;
  /** Where status messages are written (default: process.stderr). */
  out?: NodeJS.WritableStream;
}

export interface ConnectResult {
  /** The agreement grant token e-conomic redirected back with. */
  agreementGrantToken: string;
  /** The redirect URL that was used (and must be registered on the app). */
  redirectUrl: string;
}

/** Build the redirect URL from host/port/path, as registered on the app. */
export function callbackUrl(
  host = DEFAULT_CALLBACK_HOST,
  port = DEFAULT_CALLBACK_PORT,
  path = DEFAULT_CALLBACK_PATH,
): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `http://${host}:${port}${p}`;
}

/** Build the e-conomic request-access URL the user is sent to. */
export function grantRequestUrl(appPublicToken: string, redirectUrl: string): string {
  const url = new URL(GRANT_ACCESS_URL);
  url.searchParams.set("appPublicToken", appPublicToken);
  url.searchParams.set("redirectUrl", redirectUrl);
  return url.toString();
}

/**
 * Run the interactive connect flow: start the loopback listener, send the user
 * to e-conomic, and resolve with the captured agreement grant token.
 */
export async function connect(options: ConnectOptions): Promise<ConnectResult> {
  const host = options.host ?? DEFAULT_CALLBACK_HOST;
  const port = options.port ?? DEFAULT_CALLBACK_PORT;
  const path = options.path ?? DEFAULT_CALLBACK_PATH;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const openBrowser = options.openBrowser ?? true;
  const out = options.out ?? process.stderr;

  const redirectUrl = callbackUrl(host, port, path);
  const expectedPath = path.startsWith("/") ? path : `/${path}`;
  const authorizeUrl = grantRequestUrl(options.appPublicToken, redirectUrl);

  return await new Promise<ConnectResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close(() => fn());
    };

    const server: Server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", redirectUrl);
      if (reqUrl.pathname !== expectedPath) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const token = reqUrl.searchParams.get("token");
      const error =
        reqUrl.searchParams.get("error") ||
        reqUrl.searchParams.get("errorMessage") ||
        reqUrl.searchParams.get("message");

      if (token) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(resultPage("Connected", "You can close this tab and return to your terminal."));
        finish(() => resolve({ agreementGrantToken: token, redirectUrl }));
      } else {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          resultPage(
            "Connection failed",
            error
              ? `e-conomic reported: ${escapeHtml(error)}`
              : "No grant token was returned. Please try again.",
          ),
        );
        finish(() =>
          reject(new Error(error || "No grant token returned in the redirect.")),
        );
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finish(() =>
          reject(
            new Error(
              `Port ${port} is already in use. Free it or pass --port (and update ` +
                `the redirect URL registered on your app to match).`,
            ),
          ),
        );
      } else {
        finish(() => reject(err));
      }
    });

    server.listen(port, host, () => {
      out.write(
        `\nGrant access to one of your e-conomic agreements in the browser.\n` +
          `If it doesn't open automatically, visit:\n\n  ${authorizeUrl}\n\n` +
          `Waiting for the redirect to ${redirectUrl} ...\n`,
      );
      if (openBrowser) tryOpenBrowser(authorizeUrl, out);
    });

    timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the grant.`)),
      );
    }, timeoutMs);
    timer.unref?.();
  });
}

/** Best-effort: open a URL in the platform's default browser. */
function tryOpenBrowser(url: string, out: NodeJS.WritableStream): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      out.write("(Could not open a browser automatically — open the URL above manually.)\n");
    });
    child.unref();
  } catch {
    out.write("(Could not open a browser automatically — open the URL above manually.)\n");
  }
}

function resultPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>e-conomic MCP — ${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; background: #0f1115; color: #e8eaed; }
  .card { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.3rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #aab; }
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
