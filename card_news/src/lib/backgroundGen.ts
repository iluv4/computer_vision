// AI background generation.
//
// Architecture decision (validated via prototype): the model generates a
// TEXT-FREE background image only. All Korean copy stays as editable text
// layers rendered on top (see FabricLayerEditor / layerSchema), so the owner
// can still edit wording, price, font size and color after generation. This
// avoids baked-in text and Korean typo artifacts.
//
// Provider: OpenAI (GPT image generation, gpt-image-1). Gated on
// OPENAI_API_KEY — without it the caller gets a typed "not configured" result
// so the rest of the pipeline (photo / gradient backgrounds) keeps working.

import OpenAI from 'openai';

// gpt-image-1: strong prompt-adherence, returns base64 image data directly.
const DEFAULT_MODEL = process.env.OPENAI_BG_MODEL ?? 'gpt-image-1';

export type BackgroundGenResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not_configured' | 'failed'; error: string };

// Force a clean, overlay-ready, text-free composition regardless of theme.
export function buildBackgroundPrompt(theme: string): string {
  const t = (theme || '').trim() || 'minimal product';
  return [
    `Clean text-free background image for a Korean small-business Instagram card-news, vertical format.`,
    `Theme: ${t}.`,
    `Premium minimal lifestyle photography, soft natural light, shallow depth of field,`,
    `generous empty negative space at the top and bottom for later text overlay,`,
    `absolutely no text, no letters, no words, no numbers, no typography, no logos, no watermark anywhere in the image.`,
  ].join(' ');
}

export async function generateBackground(theme: string): Promise<BackgroundGenResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      reason: 'not_configured',
      error: 'OPENAI_API_KEY is not set; AI background generation is disabled.',
    };
  }

  const prompt = buildBackgroundPrompt(theme);
  try {
    const openai = new OpenAI({ apiKey });
    const result = await openai.images.generate({
      model: DEFAULT_MODEL,
      prompt,
      // Vertical canvas (matches the editor's 1024x1536 card format).
      size: '1024x1536',
      n: 1,
    });

    // gpt-image-1 returns base64 image data (no hosted URL); inline it as a
    // data URI so the client can use it directly without a second fetch.
    const b64 = result.data?.[0]?.b64_json;
    if (!b64) {
      return { ok: false, reason: 'failed', error: 'OpenAI returned no image data' };
    }
    return { ok: true, url: `data:image/png;base64,${b64}` };
  } catch (e) {
    return { ok: false, reason: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}
