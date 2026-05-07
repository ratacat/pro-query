export interface ModelCapability {
  id: string;
  label: string;
  source: "static-unverified" | "live";
  reasoningLevels: string[];
}

export function listStaticModels(): {
  models: ModelCapability[];
  warning: string;
} {
  return {
    models: [
      {
        id: "auto",
        label: "ChatGPT/Codex default",
        source: "static-unverified",
        reasoningLevels: ["auto", "low", "medium", "high"],
      },
      {
        id: "gpt-5.4",
        label: "GPT-5.4 ChatGPT/Codex",
        source: "static-unverified",
        reasoningLevels: ["low", "medium", "high"],
      },
      {
        id: "gpt-5.5",
        label: "GPT-5.5 ChatGPT/Codex",
        source: "static-unverified",
        reasoningLevels: ["low", "medium", "high"],
      },
    ],
    warning:
      "Live model discovery is pending ChatGPT backend endpoint research; submit stores requested options unchanged.",
  };
}
