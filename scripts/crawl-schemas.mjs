#!/usr/bin/env node
/**
 * Crawl and download e-conomic's per-endpoint JSON Schema files into a local
 * directory (default: ./spec/schemas), so they can be committed and loaded by
 * the MCP server via ECONOMIC_SCHEMA_DIR.
 *
 * e-conomic exposes a draft-03 schema per operation, named by path + method,
 * e.g. `vat-zones.vatZoneNumber.get.schema.json`. This script discovers the
 * top-level collections from the self-describing API root and downloads schema
 * files from a configurable schema host.
 *
 * Usage:
 *   ECONOMIC_APP_SECRET_TOKEN=... ECONOMIC_AGREEMENT_GRANT_TOKEN=... \
 *   ECONOMIC_SCHEMA_BASE_URL=<base-url-of-schema-files> \
 *   node scripts/crawl-schemas.mjs [outDir]
 *
 * Optional:
 *   ECONOMIC_SCHEMA_FILELIST=./schema-files.txt   newline-separated filenames
 *                                                 to fetch (skips discovery)
 *   ECONOMIC_BASE_URL=https://restapi.e-conomic.com
 *
 * Note: the exact schema host/URL pattern is configurable because e-conomic
 * does not publish a single index. Point ECONOMIC_SCHEMA_BASE_URL at wherever
 * the *.schema.json files are served (e.g. the location you found
 * `vat-zones.vatZoneNumber.get.schema.json`). Files that 404 are skipped.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const appSecret = process.env.ECONOMIC_APP_SECRET_TOKEN;
const grantToken = process.env.ECONOMIC_AGREEMENT_GRANT_TOKEN;
const apiBase = (process.env.ECONOMIC_BASE_URL || "https://restapi.e-conomic.com").replace(/\/+$/, "");
const schemaBase = process.env.ECONOMIC_SCHEMA_BASE_URL?.replace(/\/+$/, "");
const fileList = process.env.ECONOMIC_SCHEMA_FILELIST;
const outDir = process.argv[2] || "./spec/schemas";

if (!schemaBase) {
  console.error("ECONOMIC_SCHEMA_BASE_URL is required (the base URL where the *.schema.json files live).");
  process.exit(1);
}

const authHeaders = {
  "X-AppSecretToken": appSecret ?? "",
  "X-AgreementGrantToken": grantToken ?? "",
  Accept: "application/json",
};

/** The common per-collection method/param patterns to try when discovering. */
function candidateFiles(collection, idParam) {
  const c = collection;
  return [
    `${c}.get.schema.json`, // list
    `${c}.post.schema.json`, // create
    `${c}.${idParam}.get.schema.json`, // read one
    `${c}.${idParam}.put.schema.json`, // update
    `${c}.${idParam}.delete.schema.json`, // delete
  ];
}

/** Heuristic id parameter name for a collection (e.g. customers -> customerNumber). */
function guessIdParam(collection) {
  const singular = collection.endsWith("s") ? collection.slice(0, -1) : collection;
  const camel = singular.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  return `${camel}Number`;
}

async function discoverCollections() {
  if (!appSecret || !grantToken) {
    console.error("Discovery needs ECONOMIC_APP_SECRET_TOKEN and ECONOMIC_AGREEMENT_GRANT_TOKEN, or provide ECONOMIC_SCHEMA_FILELIST.");
    process.exit(1);
  }
  const res = await fetch(`${apiBase}/`, { headers: authHeaders });
  if (!res.ok) {
    console.error(`Failed to read API root: HTTP ${res.status}`);
    process.exit(1);
  }
  const root = await res.json();
  // The root maps resource names to URLs; collect string-valued keys that look
  // like collection links.
  const collections = [];
  for (const [key, value] of Object.entries(root)) {
    if (typeof value === "string" && value.startsWith("http") && key !== "metaData") {
      collections.push(key);
    }
  }
  return collections;
}

async function download(fileName) {
  const url = `${schemaBase}/${fileName}`;
  const res = await fetch(url);
  if (!res.ok) return false;
  const text = await res.text();
  await writeFile(join(outDir, fileName), text, "utf8");
  return true;
}

async function main() {
  await mkdir(outDir, { recursive: true });

  let files;
  if (fileList) {
    const content = await readFile(fileList, "utf8");
    files = content.split("\n").map((l) => l.trim()).filter(Boolean);
    console.error(`Using ${files.length} filenames from ${fileList}`);
  } else {
    const collections = await discoverCollections();
    console.error(`Discovered ${collections.length} collections from API root.`);
    files = collections.flatMap((c) => candidateFiles(c, guessIdParam(c)));
  }

  let ok = 0;
  let miss = 0;
  for (const f of files) {
    try {
      if (await download(f)) {
        ok += 1;
        console.error(`  ✓ ${f}`);
      } else {
        miss += 1;
      }
    } catch (err) {
      miss += 1;
      console.error(`  ! ${f}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.error(`\nDone. Downloaded ${ok} schema file(s) to ${outDir} (${miss} missing/skipped).`);
  if (ok === 0) {
    console.error("Nothing downloaded — check ECONOMIC_SCHEMA_BASE_URL points at the schema host.");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
