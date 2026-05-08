import { evaluateInCdpPage } from "./cdp";
import { EXIT, ProError } from "./errors";

const DEFAULT_CDP_BASE = "http://127.0.0.1:9222";

export interface AccountSummary {
  planType: string | null;
  subscriptionPlan: string | null;
  hasActiveSubscription: boolean;
  expiresAt: string | null;
  renewsAt: string | null;
  cancelsAt: string | null;
  billingPeriod: string | null;
  willRenew: boolean | null;
  features: string[];
}

interface RawFetchResult {
  ok: boolean;
  status: number;
  body: string;
  code?: "CHATGPT_PAGE_MISSING" | "CHATGPT_PAGE_LOGGED_OUT";
}

export async function fetchAccountSummary(cdpBase?: string): Promise<AccountSummary> {
  const expression = `(${async function pageFetch(): Promise<RawFetchResult> {
    if (location.origin !== "https://chatgpt.com") {
      return { ok: false, status: 0, code: "CHATGPT_PAGE_MISSING", body: location.href };
    }
    const sessionResponse = await fetch("https://chatgpt.com/api/auth/session", { credentials: "include" });
    const session = (await sessionResponse.json().catch(() => null)) as { accessToken?: unknown } | null;
    if (!sessionResponse.ok || typeof session?.accessToken !== "string" || !session.accessToken) {
      return { ok: false, status: sessionResponse.status, code: "CHATGPT_PAGE_LOGGED_OUT", body: "" };
    }
    const response = await fetch("https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27", {
      method: "GET",
      credentials: "include",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        accept: "application/json",
      },
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  }})()`;

  const raw = await evaluateInCdpPage<RawFetchResult>(cdpBase ?? DEFAULT_CDP_BASE, expression, 30_000);
  if (raw.code === "CHATGPT_PAGE_MISSING") {
    throw new ProError("CHATGPT_PAGE_MISSING", "No logged-in ChatGPT page is available over CDP.", {
      exitCode: EXIT.auth,
      suggestions: [
        "Open the Chrome command from pro-cli auth command.",
        "Confirm the CDP Chrome window is on https://chatgpt.com/ and logged in.",
      ],
    });
  }
  if (raw.code === "CHATGPT_PAGE_LOGGED_OUT") {
    throw new ProError("CHATGPT_PAGE_LOGGED_OUT", "The ChatGPT CDP page is not logged in.", {
      exitCode: EXIT.auth,
      suggestions: ["Sign in to ChatGPT, then run pro-cli auth capture."],
    });
  }
  if (!raw.ok) {
    throw new ProError("UPSTREAM_REJECTED", `accounts/check returned HTTP ${raw.status}.`, {
      exitCode: EXIT.upstream,
      details: { preview: raw.body.slice(0, 240) },
    });
  }
  return summarizeAccountResponse(raw.body);
}

export function summarizeAccountResponse(body: string): AccountSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new ProError("ACCOUNT_PARSE_FAILED", "Could not parse accounts/check response.", {
      exitCode: EXIT.upstream,
      cause: error,
    });
  }
  const accounts = isRecord(parsed) ? parsed.accounts : null;
  if (!isRecord(accounts)) {
    return emptySummary();
  }
  const ordering = isRecord(parsed) && Array.isArray((parsed as { account_ordering?: unknown }).account_ordering)
    ? ((parsed as { account_ordering: unknown[] }).account_ordering as unknown[])
    : [];
  const orderedKey = ordering.find((id): id is string => typeof id === "string" && id in accounts);
  const fallbackKey = Object.keys(accounts).find((key) => key !== "default") ?? "default";
  const key = orderedKey ?? fallbackKey;
  const account = accounts[key];
  if (!isRecord(account)) return emptySummary();

  const accountInfo = isRecord(account.account) ? account.account : {};
  const entitlement = isRecord(account.entitlement) ? account.entitlement : {};
  const lastSub = isRecord(account.last_active_subscription) ? account.last_active_subscription : {};
  const features = Array.isArray(account.features)
    ? (account.features as unknown[]).filter((value): value is string => typeof value === "string")
    : [];

  return {
    planType: stringOrNull(accountInfo.plan_type),
    subscriptionPlan: stringOrNull(entitlement.subscription_plan),
    hasActiveSubscription: entitlement.has_active_subscription === true,
    expiresAt: stringOrNull(entitlement.expires_at),
    renewsAt: stringOrNull(entitlement.renews_at),
    cancelsAt: stringOrNull(entitlement.cancels_at),
    billingPeriod: stringOrNull(entitlement.billing_period),
    willRenew: typeof lastSub.will_renew === "boolean" ? lastSub.will_renew : null,
    features,
  };
}

function emptySummary(): AccountSummary {
  return {
    planType: null,
    subscriptionPlan: null,
    hasActiveSubscription: false,
    expiresAt: null,
    renewsAt: null,
    cancelsAt: null,
    billingPeriod: null,
    willRenew: null,
    features: [],
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
