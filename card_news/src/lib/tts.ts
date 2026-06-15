// Test-Time Scaling (TTS) for card-news layout generation.
//
// Ported from carnews-insta PR #52 ("Test-Time Scaling — Best-of-N
// self-consistency + S1 budget forcing"). The idea: spend more *inference*
// (no GPU, no fine-tuning) on harder topics to lift output quality.
//
//   1. Budget forcing (S1): estimate topic difficulty (0..1) and map it to an
//      inference budget — how many candidate layouts to sample.
//   2. Best-of-N self-consistency: generate N candidate LayerDocuments (the
//      first deterministic at temperature 0, the rest temperature-sampled for
//      diversity), score each with a reward function, and keep the best.
//
// Everything degrades gracefully offline: difficulty and reward are pure
// heuristics (no network), so the orchestrator still picks a sensible winner
// when the LLM is unavailable or returns nothing.

import type OpenAI from 'openai';
import { generateLayerDocument } from './layerGenerator';
import { CANVAS_W, CANVAS_H, type LayerDocument, type TextLayer } from './layerSchema';

// ── Budget forcing (S1) ──────────────────────────────────────────────────────

export interface Budget {
  /** Number of candidate layouts to generate (>=1). */
  samples: number;
  /** Temperature applied to the diversity (non-first) candidates. */
  temperature: number;
}

export const MIN_SAMPLES = 1;
export const MAX_SAMPLES = 4;

// Words that signal an abstract / nuanced topic that benefits from more tries.
const HARD_SIGNALS = [
  '브랜드', '캠페인', '런칭', '리브랜딩', '스토리', '감성', '럭셔리', '프리미엄',
  '신뢰', '가치', '비전', '미래', '혁신', '지속가능', 'esg', '트렌드', '라이프스타일',
];

/**
 * Estimate topic difficulty on a 0..1 scale from the theme text alone.
 * Pure and deterministic — no network — so it works offline.
 */
export function estimateDifficulty(theme: string): number {
  const t = (theme ?? '').trim();
  if (!t) return 0;

  const lower = t.toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);

  // Longer, multi-clause briefs are harder to lay out well.
  const lengthScore = Math.min(t.length / 60, 1); // saturates ~60 chars
  const wordScore = Math.min(words.length / 12, 1); // saturates ~12 words
  const clauseScore = Math.min(((t.match(/[,，、·/]|그리고|하지만/g) ?? []).length) / 3, 1);

  const hardHits = HARD_SIGNALS.reduce((n, w) => (lower.includes(w) ? n + 1 : n), 0);
  const signalScore = Math.min(hardHits / 3, 1);

  // Weighted blend, clamped to [0, 1].
  const raw = 0.35 * lengthScore + 0.2 * wordScore + 0.2 * clauseScore + 0.25 * signalScore;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Map difficulty (0..1) to an inference budget. Easy topics get a single
 * deterministic pass; hard ones get more samples and more diversity.
 */
export function budgetForDifficulty(difficulty: number): Budget {
  const d = Math.max(0, Math.min(1, difficulty));
  const samples = Math.round(MIN_SAMPLES + d * (MAX_SAMPLES - MIN_SAMPLES));
  // Hotter sampling for harder topics to widen the candidate pool.
  const temperature = Number((0.5 + 0.5 * d).toFixed(2)); // 0.5 .. 1.0
  return { samples: Math.max(MIN_SAMPLES, samples), temperature };
}

// ── Reward (self-consistency scoring) ────────────────────────────────────────

// Copy that must not appear on a headline-style card (see layerGenerator spec).
const FORBIDDEN = /(https?:\/\/|www\.|\d{2,4}-\d{3,4}-\d{4}|\d{3,4}-\d{4}|@[\w.]+)/i;
const MARGIN = 48;

/**
 * Heuristic reward for a candidate LayerDocument (0..1, higher is better).
 * Encodes the design rules the generator prompt asks for, so we can rank
 * candidates without a second LLM call.
 */
export function scoreLayerDocument(doc: LayerDocument | null): number {
  if (!doc || !Array.isArray(doc.layers) || doc.layers.length === 0) return 0;

  const texts = doc.layers.filter((l): l is TextLayer => l.type === 'text');
  if (texts.length === 0) return 0;

  let score = 0;

  // Exactly one strong headline (largest text, 80..110px ideal).
  const headline = texts.reduce((a, b) => (a.fontSize >= b.fontSize ? a : b));
  if (headline.fontSize >= 70 && headline.fontSize <= 120) score += 0.25;
  else if (headline.fontSize >= 48) score += 0.1;

  // A supporting subheadline adds hierarchy (but too many texts is noise).
  if (texts.length >= 2 && texts.length <= 4) score += 0.15;
  else if (texts.length === 1) score += 0.05;

  // Headline sitting in the lower portion reads better over a photo.
  if (headline.bbox && headline.bbox.y >= CANVAS_H * 0.45) score += 0.15;

  // Penalise text that breaks the safe margins (clipped / cramped layouts).
  const inBounds = (t: TextLayer) =>
    t.bbox &&
    t.bbox.x >= MARGIN &&
    t.bbox.y >= MARGIN &&
    t.bbox.x + t.bbox.w <= CANVAS_W - MARGIN &&
    t.bbox.y + t.bbox.h <= CANVAS_H - MARGIN;
  const boundsRatio = texts.filter(inBounds).length / texts.length;
  score += 0.2 * boundsRatio;

  // Reward natural headline length; penalise forbidden content outright.
  const len = headline.content.trim().length;
  if (len >= 4 && len <= 40) score += 0.1;
  if (texts.some((t) => FORBIDDEN.test(t.content))) score -= 0.4;

  // Light bonus for legibility aids (shadow on the headline).
  if (headline.shadow) score += 0.05;

  return Math.max(0, Math.min(1, score));
}

/**
 * Optional LLM reward judge. Returns 0..1 or null on any failure, so callers
 * can blend it with the heuristic or fall back cleanly.
 */
export async function llmRewardScore(opts: {
  openai: OpenAI;
  theme: string;
  doc: LayerDocument;
  model?: string;
}): Promise<number | null> {
  const { openai, theme, doc, model = 'gpt-4.1-mini' } = opts;
  const copy = doc.layers
    .filter((l): l is TextLayer => l.type === 'text')
    .map((t) => t.content)
    .join(' | ');

  const prompt = `You are judging Korean Instagram card-news copy/layout quality.
THEME: ${theme}
CANDIDATE TEXT LAYERS: ${copy}
Rate overall quality (punchiness, fit to theme, clarity, hierarchy) from 0 to 100.
Return ONLY JSON: {"score": <0-100>}`;

  try {
    const res = await openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 50,
      temperature: 0,
    });
    const raw = res.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { score?: number };
    if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) return null;
    return Math.max(0, Math.min(1, parsed.score / 100));
  } catch {
    return null;
  }
}

// ── Best-of-N orchestration ──────────────────────────────────────────────────

export interface TtsResult {
  doc: LayerDocument | null;
  meta: {
    difficulty: number;
    samples: number;
    chosenIndex: number;
    scores: number[];
    usedLlmReward: boolean;
  };
}

/**
 * Generate the best card layout via Test-Time Scaling.
 *
 * Difficulty → budget → N candidates (first deterministic, rest sampled) →
 * score each → return the highest scorer. When `useLlmReward` is set and the
 * judge succeeds, its score is blended with the heuristic; otherwise the
 * heuristic alone ranks candidates.
 */
export async function generateBestOfLayerDocument(opts: {
  openai: OpenAI;
  theme: string;
  clientContext?: string;
  backgroundSrc?: string;
  model?: string;
  maxSamples?: number;
  useLlmReward?: boolean;
}): Promise<TtsResult> {
  const { openai, theme, clientContext, backgroundSrc, model, useLlmReward = false } = opts;

  const difficulty = estimateDifficulty(theme);
  const budget = budgetForDifficulty(difficulty);
  const samples = Math.max(
    MIN_SAMPLES,
    Math.min(opts.maxSamples ?? MAX_SAMPLES, budget.samples),
  );

  const candidates: (LayerDocument | null)[] = [];
  for (let i = 0; i < samples; i++) {
    // First candidate deterministic; the rest temperature-sampled for diversity.
    const temperature = i === 0 ? 0 : budget.temperature;
    const doc = await generateLayerDocument({
      openai,
      theme,
      clientContext,
      backgroundSrc,
      model,
      temperature,
    });
    candidates.push(doc);
  }

  // Score every candidate. Blend the optional LLM reward with the heuristic.
  let usedLlmReward = false;
  const scores: number[] = [];
  for (const doc of candidates) {
    let s = scoreLayerDocument(doc);
    if (useLlmReward && doc) {
      const llm = await llmRewardScore({ openai, theme, doc, model });
      if (llm != null) {
        usedLlmReward = true;
        s = 0.5 * s + 0.5 * llm;
      }
    }
    scores.push(s);
  }

  // Pick the highest scorer (ties → earliest, which is the deterministic pass).
  let chosenIndex = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[chosenIndex]) chosenIndex = i;
  }

  return {
    doc: candidates[chosenIndex] ?? null,
    meta: { difficulty, samples, chosenIndex, scores, usedLlmReward },
  };
}
