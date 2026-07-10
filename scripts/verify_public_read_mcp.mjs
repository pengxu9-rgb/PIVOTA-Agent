#!/usr/bin/env node
// Automated dark-launch verification for the PUBLIC (auth:none) read MCP tier.
// Runs the automatable half of docs/openai_apps_dark_launch_verification.md against a live base URL.
//
//   node scripts/verify_public_read_mcp.mjs --base https://mcp.pivota.cc
//   node scripts/verify_public_read_mcp.mjs --base https://pivota-agent-production.up.railway.app --path /public/mcp
//   node scripts/verify_public_read_mcp.mjs --base https://pivota-agent-production.up.railway.app --path /mcp --host mcp.pivota.cc
//
// Exit 0 = all hard checks passed; 1 = a failure. Reuses the projection module's leak scanner so the
// verifier and the server share ONE denylist source of truth. No auth, stdlib + one local import only.

import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const { findLeakedFields, MAX_RESPONSE_BYTES } = await import(
  join(HERE, "..", "mcp-server", "src", "publicReadProjection.js")
);

// ---- args ----
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : "true"]);
    return acc;
  }, [])
);
const BASE = args.base;
const PATH = args.path || "/public/mcp";
const HOST_HEADER = args.host || null;
const QUERY = args.query || "niacinamide serum for dark spots";
if (!BASE) {
  console.error("usage: verify_public_read_mcp.mjs --base <url> [--path /public/mcp|/mcp] [--host mcp.pivota.cc] [--query '...']");
  process.exit(2);
}

const EXPECTED_TOOLS = ["get_alternatives", "get_intel", "get_product", "search_catalog"];
const RESELLER_RE = /ulta\.com|sephora\.com|amazon\.|walmart\.com|target\.com|nordstrom\.com|myshopify/i;
const SUPPORTED_PROTOCOLS = ["2025-03-26", "2025-06-18"];

// ---- transport ----
let rpcId = 0;
function rpc(method, params) {
  const url = new URL(BASE.replace(/\/$/, "") + PATH);
  const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) });
  const lib = url.protocol === "https:" ? https : http;
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "PivotaPublicMcpVerify/1.0" };
  if (HOST_HEADER) headers.Host = HOST_HEADER;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = lib.request(url, { method: "POST", headers }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        const ms = Date.now() - started;
        let json = null;
        try { json = JSON.parse(buf); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json, raw: buf, ms });
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

// ---- check harness ----
const results = [];
function record(name, pass, detail = "", { warn = false } = {}) {
  results.push({ name, pass, detail, warn });
  const tag = pass ? "PASS" : warn ? "WARN" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
}
function toolResult(resp) {
  // MCP tool result lives at json.result; structuredContent + content[].text.
  return resp.json && resp.json.result ? resp.json.result : null;
}

async function main() {
  console.log(`\nVerifying public read MCP tier @ ${BASE}${PATH}${HOST_HEADER ? ` (Host: ${HOST_HEADER})` : ""}\n`);

  // 1. initialize
  {
    const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
    const res = r.json?.result;
    record("initialize returns 200 + serverInfo.name=pivota",
      r.status === 200 && res?.serverInfo?.name === "pivota", `status=${r.status} name=${res?.serverInfo?.name}`);
    record("initialize negotiates a supported protocolVersion",
      SUPPORTED_PROTOCOLS.includes(res?.protocolVersion || ""), `protocolVersion=${res?.protocolVersion}`);
  }

  // 2. tools/list
  let toolsOk = false;
  {
    const r = await rpc("tools/list");
    const tools = r.json?.result?.tools || [];
    const names = tools.map((t) => t.name).sort();
    toolsOk = JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS);
    record("tools/list = exactly the 4 read tools (no commerce tools)", toolsOk, names.join(", "));
    let annOk = tools.length > 0;
    let descOk = tools.length > 0;
    for (const t of tools) {
      if (!(t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === false)) annOk = false;
      if (!/read-only\.?$/i.test(t.description || "")) descOk = false;
    }
    record("all tools: readOnlyHint=true, openWorldHint=false", annOk);
    record("all tool descriptions signal read-only", descOk);
    const gp = tools.find((t) => t.name === "get_product");
    record("get_product resolves by bare product_id (merchant_id not required)",
      JSON.stringify(gp?.inputSchema?.required || []) === JSON.stringify(["product_id"]), JSON.stringify(gp?.inputSchema?.required));
  }

  // 3. search_catalog
  let sampleProductId = null;
  {
    const r = await rpc("tools/call", { name: "search_catalog", arguments: { query: QUERY, page_size: 5 } });
    const res = toolResult(r);
    const sc = res?.structuredContent;
    record("search_catalog: latency < 3000ms", r.ms < 3000, `${r.ms}ms`, { warn: r.ms >= 3000 });
    record("search_catalog: returns structuredContent with products", !!sc && Array.isArray(sc.products), `products=${sc?.products?.length ?? "n/a"}`);
    if (sc) {
      const leaks = findLeakedFields(sc);
      record("search_catalog: NO denylisted field / timestamp leaks", leaks.length === 0, leaks.slice(0, 5).join("; "));
      const bytes = Buffer.byteLength(JSON.stringify(sc));
      record("search_catalog: response within size budget", bytes <= MAX_RESPONSE_BYTES, `${bytes} / ${MAX_RESPONSE_BYTES} bytes`);
      const reseller = (sc.products || []).filter((p) => p.pivota_url && RESELLER_RE.test(p.pivota_url));
      record("search_catalog: no reseller URL in any pivota_url", reseller.length === 0, reseller.map((p) => p.pivota_url).join("; "));
      const withReseller = (sc.products || []).filter((p) => p.brand_url && RESELLER_RE.test(p.brand_url));
      record("search_catalog: first-party sourcing (no reseller product surfaced)", withReseller.length === 0, `${withReseller.length} reseller rows`);
      sampleProductId = sc.products?.[0]?.product_id || null;
    }
  }

  // 4. get_intel — the differentiator (cited claims => AGENT_INTEL_PUBLIC_CLAIMS_ENABLED effect)
  if (sampleProductId) {
    const r = await rpc("tools/call", { name: "get_intel", arguments: { product_id: sampleProductId } });
    const sc = toolResult(r)?.structuredContent;
    const reachable = !!sc && ("intel" in sc);
    record("get_intel: reachable + honest shape", reachable, sc?.intel ? "intel present" : sc?.note || "no intel");
    if (sc?.intel) {
      const claims = Array.isArray(sc.intel.claims) ? sc.intel.claims : [];
      const cited = claims.filter((c) => Array.isArray(c.citations) && c.citations.length > 0);
      record("get_intel: cited claims present (AGENT_INTEL_PUBLIC_CLAIMS_ENABLED live)",
        cited.length > 0, `${cited.length}/${claims.length} claims with citations`, { warn: cited.length === 0 });
      if (sc) record("get_intel: no field leaks", findLeakedFields(sc).length === 0);
    }
  } else {
    record("get_intel: skipped (no sample product from search)", true, "", { warn: true });
  }

  // 5. get_alternatives
  if (sampleProductId) {
    const r = await rpc("tools/call", { name: "get_alternatives", arguments: { product_id: sampleProductId } });
    const sc = toolResult(r)?.structuredContent;
    record("get_alternatives: reachable + honest shape", !!sc && ("alternatives" in sc), `alternatives=${sc?.alternatives?.length ?? "n/a"}`);
    if (sc) record("get_alternatives: no field leaks", findLeakedFields(sc).length === 0);
  }

  // 6. get_product by bare sig
  if (sampleProductId) {
    const r = await rpc("tools/call", { name: "get_product", arguments: { product_id: sampleProductId } });
    const sc = toolResult(r)?.structuredContent;
    record("get_product: resolves by bare sig, echoes product_id", sc?.product_id === sampleProductId, `product_id=${sc?.product_id}`);
    record("get_product: no merchant_id / field leaks", !!sc && !("merchant_id" in sc) && findLeakedFields(sc).length === 0);
  }

  // 7. negative — a commerce/write tool must not exist on this surface
  {
    const r = await rpc("tools/call", { name: "create_checkout_session", arguments: {} });
    const res = toolResult(r);
    let code = null;
    try { code = JSON.parse(res.content[0].text).error.code; } catch { /* */ }
    record("write/commerce tool absent (create_checkout_session → UNKNOWN_TOOL)", res?.isError === true && code === "UNKNOWN_TOOL", `isError=${res?.isError} code=${code}`);
  }

  // ---- summary ----
  const fails = results.filter((r) => !r.pass && !r.warn);
  const warns = results.filter((r) => !r.pass && r.warn);
  console.log(`\n${results.filter((r) => r.pass).length} passed, ${fails.length} failed, ${warns.length} warnings.`);
  if (warns.length) console.log("WARNINGS (non-blocking): " + warns.map((w) => w.name).join("; "));
  if (fails.length) {
    console.log("FAILED: " + fails.map((f) => f.name).join("; "));
    process.exit(1);
  }
  console.log("ALL HARD CHECKS PASSED.");
}

main().catch((e) => {
  console.error("verifier error:", e.message);
  process.exit(1);
});
