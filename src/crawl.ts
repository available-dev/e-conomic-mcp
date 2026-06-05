/**
 * Crawl and download e-conomic's per-endpoint JSON Schema files into a local
 * directory so they can be committed and loaded via ECONOMIC_SCHEMA_DIR.
 *
 * e-conomic exposes a draft-03 schema per operation, named by path + method,
 * e.g. `vat-zones.vatZoneNumber.get.schema.json`. This discovers the top-level
 * collections from the self-describing API root and downloads schema files from
 * a configurable schema host.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface CrawlOptions {
  outDir: string;
  /** Base URL of the schema files. Defaults to `${apiBaseUrl}/schema`. */
  schemaBaseUrl?: string;
  apiBaseUrl: string;
  appSecretToken?: string;
  agreementGrantToken?: string;
  /** Optional path to a newline-separated list of filenames to fetch. */
  fileListPath?: string;
  /** Logger (defaults to stderr). */
  log?: (msg: string) => void;
}

export interface CrawlResult {
  downloaded: number;
  missing: number;
  outDir: string;
}

/** Heuristic id parameter name for a collection (customers -> customerNumber). */
function guessIdParam(collection: string): string {
  const singular = collection.endsWith("s") ? collection.slice(0, -1) : collection;
  const camel = singular.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
  return `${camel}Number`;
}

/** Common per-collection method/param filename patterns to try. */
function candidateFiles(collection: string, idParam: string): string[] {
  return [
    `${collection}.get.schema.json`,
    `${collection}.post.schema.json`,
    `${collection}.${idParam}.get.schema.json`,
    `${collection}.${idParam}.put.schema.json`,
    `${collection}.${idParam}.delete.schema.json`,
  ];
}

async function discoverCollections(opts: CrawlOptions, log: (m: string) => void): Promise<string[]> {
  if (!opts.appSecretToken || !opts.agreementGrantToken) {
    throw new Error(
      "Discovery needs ECONOMIC_APP_SECRET_TOKEN and ECONOMIC_AGREEMENT_GRANT_TOKEN, " +
        "or provide a file list via --file-list.",
    );
  }
  const res = await fetch(`${opts.apiBaseUrl}/`, {
    headers: {
      "X-AppSecretToken": opts.appSecretToken,
      "X-AgreementGrantToken": opts.agreementGrantToken,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Failed to read API root: HTTP ${res.status}`);
  const root = (await res.json()) as Record<string, unknown>;
  const collections: string[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (typeof value === "string" && value.startsWith("http") && key !== "metaData") {
      collections.push(key);
    }
  }
  log(`Discovered ${collections.length} collections from API root.`);
  return collections;
}

export async function crawlSchemas(opts: CrawlOptions): Promise<CrawlResult> {
  const log = opts.log ?? ((m) => console.error(m));
  const schemaBase = (opts.schemaBaseUrl ?? `${opts.apiBaseUrl}/schema`).replace(/\/+$/, "");
  await mkdir(opts.outDir, { recursive: true });

  // The schema host is the API host; send auth headers in case they're required.
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.appSecretToken) headers["X-AppSecretToken"] = opts.appSecretToken;
  if (opts.agreementGrantToken) headers["X-AgreementGrantToken"] = opts.agreementGrantToken;

  let files: string[];
  if (opts.fileListPath) {
    const content = await readFile(opts.fileListPath, "utf8");
    files = content.split("\n").map((l) => l.trim()).filter(Boolean);
    log(`Using ${files.length} filenames from ${opts.fileListPath}`);
  } else {
    const collections = await discoverCollections(opts, log);
    files = collections.flatMap((c) => candidateFiles(c, guessIdParam(c)));
  }

  let downloaded = 0;
  let missing = 0;
  for (const fileName of files) {
    try {
      const res = await fetch(`${schemaBase}/${fileName}`, { headers });
      if (!res.ok) {
        missing += 1;
        continue;
      }
      await writeFile(join(opts.outDir, fileName), await res.text(), "utf8");
      downloaded += 1;
      log(`  ✓ ${fileName}`);
    } catch (err) {
      missing += 1;
      log(`  ! ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(`\nDone. Downloaded ${downloaded} schema file(s) to ${opts.outDir} (${missing} missing/skipped).`);
  return { downloaded, missing, outDir: opts.outDir };
}
