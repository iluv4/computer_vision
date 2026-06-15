# Test-Time Scaling (TTS)

Inference-only quality boost for card-news layout generation — no GPU, no
fine-tuning, no extra training data. Ported from carnews-insta PR #52.

The idea: spend more *inference* on harder topics. Two techniques work together:

1. **Budget forcing (S1)** — estimate the topic's difficulty (`0..1`) and map it
   to a budget: how many candidate layouts to sample. Easy topics get a single
   deterministic pass; hard ones get more.
2. **Best-of-N self-consistency** — generate N candidate `LayerDocument`s (the
   first deterministic at `temperature 0`, the rest temperature-sampled for
   diversity), score each, and keep the best.

## Where it lives

- `src/lib/tts.ts` — the whole strategy:
  - `estimateDifficulty(theme)` → `0..1` (pure, offline heuristic)
  - `budgetForDifficulty(difficulty)` → `{ samples, temperature }`
  - `scoreLayerDocument(doc)` → `0..1` heuristic reward
  - `llmRewardScore(...)` → optional LLM judge (`0..1` or `null` on failure)
  - `generateBestOfLayerDocument(...)` → orchestrates the above
- `src/lib/layerGenerator.ts` — `generateLayerDocument` gained a `temperature`
  parameter so TTS can sample diverse candidates.
- `src/app/api/generate-layers/route.ts` — uses TTS when the flag is on.

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `AGENT_TTS_ENABLED` | off | `1`/`true`/`on` enables Test-Time Scaling for `/api/generate-layers`. |
| `AGENT_TTS_LLM_REWARD` | off | `1` blends an LLM reward judge (50/50) with the heuristic when ranking candidates. Costs one extra call per candidate. |

When TTS is enabled the response includes a `tts` block:

```json
{
  "layerDocument": { ... },
  "tts": {
    "difficulty": 0.69,
    "samples": 3,
    "chosenIndex": 2,
    "scores": [0.55, 0.62, 0.81],
    "usedLlmReward": false
  }
}
```

## Graceful degradation

Difficulty and the default reward are pure heuristics with no network calls, so
the orchestrator still ranks and picks a winner if the LLM returns nothing. With
TTS off, the route behaves exactly as before (a single `generateLayerDocument`
pass with the heuristic builder as fallback). The response schema stays backward
compatible — the `tts` field is only added, never required.

## Cost / latency

`samples` ranges from `1` (easy) to `MAX_SAMPLES = 4` (hard). Each sample is one
layout-generation call; enabling `AGENT_TTS_LLM_REWARD` adds one judge call per
sample. Leave TTS off for the lowest, most predictable latency.
