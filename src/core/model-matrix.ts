// GENERATED from data/model-matrix.yaml by `npm run gen:matrix` (scripts/gen-model-matrix.ts). Do not edit by hand.
export const GENERATED_MODEL_MATRIX = {
  "version": 1,
  "classes": {
    "report": {
      "codex": "gpt-6-luna/medium",
      "claude": "claude-haiku-5-5/low",
      "kimi": "k3-256k/low"
    },
    "simple": {
      "codex": "gpt-6-luna/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3-256k/low"
    },
    "smoke": {
      "codex": "gpt-6-luna/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high"
    },
    "feature": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high"
    },
    "bugfix": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/high",
      "kimi": "k3/high"
    },
    "review": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high"
    },
    "merge": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high"
    },
    "hard": {
      "codex": "gpt-6.1-sol/high",
      "claude": "claude-opus-5-5/high",
      "kimi": "k3/max"
    },
    "sim": {
      "codex": "gpt-6.1-sol/high",
      "claude": "claude-opus-5-5/high",
      "kimi": "k3/max"
    },
    "visual": {
      "explicit": true,
      "codex": "gpt-6.1-sol/high",
      "claude": "claude-sonnet-5-5/high",
      "kimi": "k3.1-pro/high"
    },
    "visual-compare": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-sonnet-5-5/medium",
      "kimi": "k3/high"
    },
    "design": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-opus-5-5/medium",
      "kimi": "k3/high"
    },
    "creative": {
      "codex": "gpt-6.1-sol/medium",
      "claude": "claude-opus-5-5/medium",
      "kimi": "none"
    },
    "escalate": {
      "explicit": true,
      "codex": "gpt-6-astra/high",
      "claude": "claude-fable-5-1/medium",
      "kimi": "k3.1-pro/max"
    }
  }
} as const;
