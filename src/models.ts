import { isTokenFresh, loadSessionToken } from "./session-token";

export interface ModelCapability {
  id: string;
  label: string;
  source: "static-unverified" | "live";
  reasoningLevels: string[];
  default?: boolean;
  maxTokens?: number;
  reasoningType?: string;
  configurableThinkingEffort?: boolean;
  enabledTools?: string[];
  aliasFor?: string;
}

export interface ModelList {
  models: ModelCapability[];
  source: "static" | "live";
  warning?: string;
  defaultModel?: string;
  modelPickerVersion?: number;
}

interface LiveModelPayload {
  default_model_slug?: unknown;
  model_picker_version?: unknown;
  models?: unknown;
}

interface LiveModel {
  slug?: unknown;
  title?: unknown;
  max_tokens?: unknown;
  reasoning_type?: unknown;
  configurable_thinking_effort?: unknown;
  thinking_efforts?: unknown;
  enabled_tools?: unknown;
}

export async function listModels(options: { sessionTokenPath: string }): Promise<ModelList> {
  const session = await loadSessionToken(options.sessionTokenPath).catch(() => null);
  if (!session) {
    return listStaticModels("No captured ChatGPT session token is available.");
  }
  if (!isTokenFresh(session)) {
    return listStaticModels("The captured ChatGPT session token is expired.");
  }
  if (!session.accountId) {
    return listStaticModels("The captured ChatGPT session token has no account id.");
  }

  try {
    const response = await fetch("https://chatgpt.com/backend-api/models", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        "chatgpt-account-id": session.accountId,
        accept: "application/json",
        origin: "https://chatgpt.com",
        referer: "https://chatgpt.com/",
        "user-agent": "pro-cli/0.1",
      },
    });

    if (!response.ok) {
      return listStaticModels(`Live model discovery returned HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as LiveModelPayload;
    const liveModels = parseLiveModels(payload);
    if (liveModels.length === 0) {
      return listStaticModels("Live model discovery returned no usable model entries.");
    }

    const defaultModel =
      typeof payload.default_model_slug === "string" ? payload.default_model_slug : undefined;
    return {
      source: "live",
      ...(defaultModel ? { defaultModel } : {}),
      ...(typeof payload.model_picker_version === "number"
        ? { modelPickerVersion: payload.model_picker_version }
        : {}),
      models: [
        {
          id: "auto",
          label: "ChatGPT default",
          source: "live",
          reasoningLevels: ["auto", "low", "medium", "high"],
          default: false,
          ...(defaultModel ? { aliasFor: defaultModel } : {}),
        },
        ...liveModels.map((model) => ({
          ...model,
          default: model.id === defaultModel,
        })),
      ],
    };
  } catch {
    return listStaticModels("Live model discovery failed; using static fallback.");
  }
}

export function listStaticModels(warning?: string): ModelList {
  return {
    source: "static",
    models: [
      {
        id: "auto",
        label: "ChatGPT default",
        source: "static-unverified",
        reasoningLevels: ["auto", "low", "medium", "high"],
      },
    ],
    warning: warning ?? "Live model discovery requires a captured ChatGPT session token.",
  };
}

function parseLiveModels(payload: LiveModelPayload): ModelCapability[] {
  const models = Array.isArray(payload.models) ? (payload.models as LiveModel[]) : [];
  return models
    .map((model) => {
      if (typeof model.slug !== "string" || typeof model.title !== "string") return null;
      const reasoningLevels = parseReasoningLevels(model.thinking_efforts);
      const enabledTools = parseEnabledTools(model.enabled_tools);
      const capability: ModelCapability = {
        id: model.slug,
        label: model.title,
        source: "live",
        reasoningLevels,
        ...(typeof model.max_tokens === "number" ? { maxTokens: model.max_tokens } : {}),
        ...(typeof model.reasoning_type === "string" ? { reasoningType: model.reasoning_type } : {}),
        ...(typeof model.configurable_thinking_effort === "boolean"
          ? { configurableThinkingEffort: model.configurable_thinking_effort }
          : {}),
        ...(enabledTools.length > 0 ? { enabledTools } : {}),
      };
      return capability;
    })
    .filter((model): model is ModelCapability => model !== null);
}

function parseReasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return ["auto", "low", "medium", "high"];
  const levels = value.filter((item): item is string => typeof item === "string");
  return levels.length > 0 ? levels : ["auto", "low", "medium", "high"];
}

function parseEnabledTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const tool = item as { id?: unknown; name?: unknown; type?: unknown };
    for (const candidate of [tool.id, tool.name, tool.type]) {
      if (typeof candidate === "string") return [candidate];
    }
    return [];
  });
}
