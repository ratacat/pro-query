import { describe, expect, test } from "bun:test";
import { summarizeAccountResponse } from "../src/limits";
import { extractLimitsProgress } from "../src/transport";

describe("summarizeAccountResponse", () => {
  test("extracts pro plan facts from accounts/check shape", () => {
    const body = JSON.stringify({
      accounts: {
        default: {
          account: { plan_type: "free", structure: "personal" },
          features: ["gpt5"],
          entitlement: { has_active_subscription: false, subscription_plan: null },
        },
        "uuid-1": {
          account: { plan_type: "pro" },
          features: ["gpt5_pro", "o3_pro"],
          entitlement: {
            has_active_subscription: true,
            subscription_plan: "chatgptpro",
            expires_at: "2026-05-27T03:16:31+00:00",
            renews_at: "2026-05-26T21:16:31+00:00",
            cancels_at: null,
            billing_period: "monthly",
          },
          last_active_subscription: { will_renew: true },
        },
      },
      account_ordering: ["uuid-1"],
    });
    const summary = summarizeAccountResponse(body);
    expect(summary.planType).toBe("pro");
    expect(summary.subscriptionPlan).toBe("chatgptpro");
    expect(summary.hasActiveSubscription).toBe(true);
    expect(summary.expiresAt).toBe("2026-05-27T03:16:31+00:00");
    expect(summary.renewsAt).toBe("2026-05-26T21:16:31+00:00");
    expect(summary.billingPeriod).toBe("monthly");
    expect(summary.willRenew).toBe(true);
    expect(summary.features).toContain("gpt5_pro");
    expect(summary.features).toContain("o3_pro");
  });

  test("falls back to default account when ordering is empty", () => {
    const body = JSON.stringify({
      accounts: {
        default: {
          account: { plan_type: "free" },
          features: [],
          entitlement: { has_active_subscription: false },
        },
      },
      account_ordering: [],
    });
    const summary = summarizeAccountResponse(body);
    expect(summary.planType).toBe("free");
    expect(summary.hasActiveSubscription).toBe(false);
  });

  test("returns empty summary on missing accounts shape", () => {
    const summary = summarizeAccountResponse(JSON.stringify({}));
    expect(summary.planType).toBe(null);
    expect(summary.features).toEqual([]);
  });

  test("throws on unparseable body", () => {
    expect(() => summarizeAccountResponse("not json")).toThrow();
  });
});

describe("extractLimitsProgress", () => {
  test("extracts limits from a top-level conversation_detail_metadata event", () => {
    const event = {
      type: "conversation_detail_metadata",
      limits_progress: [
        { feature_name: "deep_research", remaining: 250, reset_after: "2026-06-07T18:34:14.421525+00:00" },
        { feature_name: "odyssey", remaining: 398, reset_after: "2026-05-17T21:31:20.421544+00:00" },
      ],
      model_limits: [],
    };
    const observations = extractLimitsProgress(event);
    expect(observations).toHaveLength(2);
    expect(observations[0]).toEqual({
      feature_name: "deep_research",
      remaining: 250,
      reset_after: "2026-06-07T18:34:14.421525+00:00",
    });
  });

  test("handles wrapped delta-style payload at event.v", () => {
    const event = {
      v: {
        type: "conversation_detail_metadata",
        limits_progress: [{ feature_name: "deep_research", remaining: 100 }],
      },
    };
    const observations = extractLimitsProgress(event);
    expect(observations).toHaveLength(1);
    expect(observations[0].feature_name).toBe("deep_research");
    expect(observations[0].reset_after).toBe(null);
  });

  test("ignores unrelated events", () => {
    expect(extractLimitsProgress({ type: "input_message" })).toEqual([]);
    expect(extractLimitsProgress(null)).toEqual([]);
    expect(extractLimitsProgress({ type: "conversation_detail_metadata" })).toEqual([]);
  });

  test("dedupes by feature_name", () => {
    const event = {
      type: "conversation_detail_metadata",
      limits_progress: [
        { feature_name: "deep_research", remaining: 250 },
        { feature_name: "deep_research", remaining: 240 },
      ],
    };
    expect(extractLimitsProgress(event)).toHaveLength(1);
  });

  test("skips entries with missing fields", () => {
    const event = {
      type: "conversation_detail_metadata",
      limits_progress: [
        { feature_name: "ok", remaining: 5 },
        { feature_name: 123, remaining: 5 },
        { feature_name: "no_remaining" },
      ],
    };
    const observations = extractLimitsProgress(event);
    expect(observations).toHaveLength(1);
    expect(observations[0].feature_name).toBe("ok");
  });
});
