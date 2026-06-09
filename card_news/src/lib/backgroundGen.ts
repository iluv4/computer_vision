// AI background generation.
//
// Architecture decision (validated via prototype): the diffusion model
// generates a TEXT-FREE background image only. All Korean copy stays as
// editable text layers rendered on top (see FabricLayerEditor / layerSchema),
// so the owner can still edit wording, price, font size and color after
// generation. This avoids baked-in text and Korean typo artifacts.
//
// Provider-gated: uses Replicate when REPLICATE_API_TOKEN is set. Without a
// token the caller gets a typed "not configured" result so the rest of the
// pipeline (photo / gradient backgrounds) keeps working.

const DEFAULT_MODEL =
  process.env.REPLICATE_BG_MODEL ??
  // FLUX schnell: fast, strong prompt-adherence, good for clean backgrounds.
  'black-forest-labs/flux-schnell';

export type BackgroundGenResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not_configured' | 'failed'; error: string };

// Force a clean, overlay-ready, text-free composition regardless of theme.
export function buildBackgroundPrompt(theme: string): string {
  const t = (theme || '').trim() || 'minimal product';
  return [
    `Clean text-free background image for a Korean small-business Instagram card-news, vertical 4:5.`,
    `Theme: ${t}.`,
    `Premium minimal lifestyle photography, soft natural light, shallow depth of field,`,
    `generous empty negative space at the top and bottom for later text overlay,`,
    `absolutely no text, no letters, no words, no numbers, no typography, no logos anywhere in the image.`,
  ].join(' ');
}

export const NEGATIVE_PROMPT = 'text, letters, words, numbers, typography, watermark, logo, caption, signature';

interface ReplicatePrediction {
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstUrl(output: ReplicatePrediction['output']): string | null {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && typeof output[0] === 'string') return output[0];
  return null;
}

export async function generateBackground(theme: string): Promise<BackgroundGenResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return {
      ok: false,
      reason: 'not_configured',
      error: 'REPLICATE_API_TOKEN is not set; AI background generation is disabled.',
    };
  }

  const prompt = buildBackgroundPrompt(theme);
  try {
    // Prefer=wait makes Replicate hold the connection until the prediction
    // resolves (up to ~60s), so we can return the URL synchronously.
    const res = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'wait',
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        input: {
          prompt,
          negative_prompt: NEGATIVE_PROMPT,
          aspect_ratio: '4:5',
          output_format: 'jpg',
          num_outputs: 1,
        },
      }),
      // Cap the wait so a slow provider can't blow the caller's function budget.
      signal: AbortSignal.timeout(45_000),
    });

    let prediction = (await res.json()) as ReplicatePrediction;
    if (!res.ok) {
      return { ok: false, reason: 'failed', error: prediction.error || `Replicate returned ${res.status}` };
    }

    // Prefer=wait usually returns a terminal status, but if it comes back still
    // running, poll the prediction URL until it resolves (within ~30s).
    const deadline = Date.now() + 30_000;
    while ((prediction.status === 'starting' || prediction.status === 'processing') && prediction.urls?.get && Date.now() < deadline) {
      await sleep(1500);
      const poll = await fetch(prediction.urls.get, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      prediction = (await poll.json()) as ReplicatePrediction;
    }

    if (prediction.status !== 'succeeded') {
      return { ok: false, reason: 'failed', error: prediction.error || `Replicate status: ${prediction.status}` };
    }

    const url = firstUrl(prediction.output);
    if (!url) return { ok: false, reason: 'failed', error: 'Replicate prediction returned no image output' };
    return { ok: true, url };
  } catch (e) {
    return { ok: false, reason: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
