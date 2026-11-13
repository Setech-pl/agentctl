// GENERATED from data/model-matrix.yaml by `npm run gen:matrix` (scripts/gen-model-matrix.ts). Do not edit by hand.
export const GENERATED_MODEL_MATRIX = {
  "version": 1,
  "classes": {
    "report": {
      "codex": "gpt-6-luna/medium",
      "claude": "claude-haiku-5-5/low",
      "kimi": "k3-256k/low",
      "glm": "glm-5.3-flash/low"
    },
    "simple": {
      "codex": "gpt-6-luna/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3-256k/low",
      "glm": "glm-5.3-flash/medium"
    },
    "smoke": {
      "codex": "gpt-6-luna/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high",
      "glm": "glm-5.3-flash/medium"
    },
    "feature": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high",
      "glm": "glm-5.3/medium"
    },
    "bugfix": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/high",
      "kimi": "k3/high",
      "glm": "glm-5.3/high"
    },
    "review": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high",
      "glm": "glm-5.3/medium"
    },
    "merge": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high",
      "glm": "glm-5.3/medium"
    },
    "hard": {
      "codex": "gpt-6.1-sol/high",
      "claude": "claude-opus-5-5/high",
      "kimi": "k3/max",
      "glm": "glm-5.3/high"
    },
    "sim": {
      "codex": "gpt-6.1-sol/high",
      "claude": "claude-opus-5-5/high",
      "kimi": "k3/max",
      "glm": "glm-5.3/high"
    },
    "visual": {
      "explicit": true,
      "codex": "gpt-6.1-sol/high",
      "claude": "claude-sonnet-5-5/high",
      "kimi": "k3.1-pro/high",
      "glm": "glm-5.3/high"
    },
    "visual-compare": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high",
      "glm": "glm-5.3/medium"
    },
    "design": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-opus-5-5/medium",
      "kimi": "k3/high",
      "glm": "glm-5.3/medium"
    },
    "creative": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-opus-5-5/medium",
      "kimi": "none",
      "glm": "glm-5.3/medium"
    },
    "escalate": {
      "explicit": true,
      "codex": "gpt-6-astra/high",
      "claude": "claude-fable-5-1/medium",
      "kimi": "k3.1-pro/max",
      "glm": "glm-5.3/max"
    }
  }
} as const;
