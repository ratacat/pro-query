#!/usr/bin/env bun
import { evaluateInCdpPage } from "../src/cdp";

const CDP_BASE = process.env.CDP_BASE ?? "http://127.0.0.1:9222";

const CANDIDATES = [
  "/backend-api/accounts/check/v4-2023-04-27",
  "/backend-api/me/feature_limits",
  "/backend-api/me/limits",
  "/backend-api/me/quota",
  "/backend-api/feature_limits",
  "/backend-api/conversation_limits",
  "/backend-api/limits_progress",
  "/backend-api/billing/subscription",
  "/backend-api/subscription",
  "/backend-api/billing/usage",
  "/backend-api/usage_metrics",
];

const FULL_BODY_PATHS = new Set(["/backend-api/accounts/check/v4-2023-04-27"]);

interface ProbeResult {
  path: string;
  ok: boolean;
  status: number;
  preview: string;
  hasLimits: boolean;
}

const expression = `(${async function probe(paths: string[]): Promise<ProbeResult[]> {
  const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include" });
  const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
  if (!sessionResponse.ok || typeof session?.accessToken !== "string") {
    throw new Error(`Session fetch failed: ${sessionResponse.status}`);
  }
  const accessToken = session.accessToken;
  const results: ProbeResult[] = [];
  for (const path of paths) {
    try {
      const response = await fetch(`https://chatgpt.com${path}`, {
        method: "GET",
        credentials: "include",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
      });
      const text = await response.text();
      const preview = text.slice(0, 8000).replace(/\s+/g, " ");
      const hasLimits = /limit|remaining|reset_after|quota|usage|cap/i.test(preview);
      results.push({ path, ok: response.ok, status: response.status, preview, hasLimits });
    } catch (error) {
      results.push({
        path,
        ok: false,
        status: 0,
        preview: String(error),
        hasLimits: false,
      });
    }
  }
  return results;
}})(${JSON.stringify(CANDIDATES)})`;

const results = await evaluateInCdpPage<ProbeResult[]>(CDP_BASE, expression, 60_000);

for (const result of results) {
  const tag = result.ok ? (result.hasLimits ? "HIT " : "ok  ") : "MISS";
  console.log(`${tag} ${result.status} ${result.path}`);
  if (result.ok) {
    const dumpFull = FULL_BODY_PATHS.has(result.path);
    console.log(dumpFull ? `--- FULL BODY ---\n${result.preview}\n--- END ---` : `     ${result.preview.slice(0, 320)}`);
  }
}
