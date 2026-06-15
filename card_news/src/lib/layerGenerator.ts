// COLE-style layout generation: the LLM emits the full LayerDocument
// (positions, hierarchy, Korean copy) for a theme. The result is validated
// against our schema; callers fall back to the heuristic builder on any
// failure. The generated text layers sit on top of the background image
// (the OpenAI composite or an AI background), which is injected here.

import type OpenAI from 'openai';
import { CANVAS_W, CANVAS_H, validateLayerDocument, type LayerDocument } from './layerSchema';

const SCHEMA_SPEC = `Return ONLY a JSON object with this exact shape (no markdown, no prose):
{
  "canvas": { "w": ${CANVAS_W}, "h": ${CANVAS_H} },
  "layers": [
    { "id": "bg", "type": "background", "source": "solid"|"gradient", "value": "<hex or css-gradient>", "overlayOpacity": 0.0-0.8, "z": 0 },
    { "id": "<unique>", "type": "shape", "shape": "rect"|"circle"|"line", "bbox": {"x":0,"y":0,"w":0,"h":0}, "fill": "<hex>", "radius": <px>, "z": <int> },
    { "id": "<unique>", "type": "text", "editable": true, "bbox": {"x":0,"y":0,"w":0,"h":0}, "content": "<Korean text>", "color": "<hex>", "fontWeight": 100-900, "fontSize": <px>, "align": "left"|"center"|"right", "lineHeight": <num>, "letterSpacing": <px>, "shadow": "<css text-shadow or omit>", "z": <int> }
  ]
}
RULES:
- Canvas is ${CANVAS_W}x${CANVAS_H} px (Instagram 4:5 portrait). All bbox values are absolute px within the canvas.
- Lower z renders behind higher z. Background z=0.
- Provide ONE headline text layer (fontSize 80-110, bold) and optionally one subheadline (fontSize 32-40) and one short badge.
- Render ONLY headline-style copy. NO phone numbers, addresses, hours, or URLs.
- A photo background will be placed UNDER your layers, so prefer bright text colors with a shadow for legibility, and keep the lower third clear for the headline.
- Keep text inside the canvas with comfortable margins (>=48px).`;

export async function generateLayerDocument(opts: {
  openai: OpenAI;
  theme: string;
  clientContext?: string;
  // The background image (OpenAI composite or AI background) to place under the
  // generated layers. When provided, the model's solid/gradient bg is swapped
  // for an image background.
  backgroundSrc?: string;
  model?: string;
  // Sampling temperature. 0 (default) is deterministic; higher values add
  // diversity, used by Test-Time Scaling to generate distinct candidates.
  temperature?: number;
}): Promise<LayerDocument | null> {
  const { openai, theme, clientContext, backgroundSrc, model = 'gpt-4.1-mini', temperature = 0 } = opts;

  const prompt = `You are a senior Korean Instagram card-news designer. Design an editable, layered card.

THEME / TOPIC: ${theme}
${clientContext ? `BRAND TONE (style only, do not render as text): ${clientContext}` : ''}

Write punchy, natural Korean marketing copy that fits the theme. Lay out the
headline, an optional subheadline, and an optional short badge.

${SCHEMA_SPEC}`;

  try {
    const res = await openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature,
    });

    const raw = res.choices[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw) as LayerDocument;

    // Force the real canvas size and inject the background image when provided
    // (the model only describes a solid/gradient bg).
    parsed.canvas = { w: CANVAS_W, h: CANVAS_H };
    if (backgroundSrc) {
      const bg = parsed.layers?.find((l) => l.type === 'background');
      if (bg && bg.type === 'background') {
        bg.source = 'image';
        bg.value = backgroundSrc;
        if (bg.overlayOpacity == null) bg.overlayOpacity = 0.5;
      } else {
        parsed.layers = parsed.layers ?? [];
        parsed.layers.unshift({ id: 'bg', type: 'background', source: 'image', value: backgroundSrc, overlayOpacity: 0.5, z: 0 });
      }
    }

    // The schema validator only checks structural fields, so backfill render
    // fields the model may omit — otherwise they'd render as `color:undefined`
    // / `font-size:undefinedpx` (invisible or mis-sized text).
    if (Array.isArray(parsed.layers)) {
      for (const l of parsed.layers) {
        if (l.type === 'text') {
          if (typeof l.color !== 'string') l.color = '#ffffff';
          if (l.fontWeight == null) l.fontWeight = 700;
          if (!Number.isFinite(l.fontSize as number)) l.fontSize = 64;
          if (!l.align) l.align = 'left';
          l.editable = true;
        } else if (l.type === 'shape' && !l.shape) {
          l.shape = 'rect';
        }
      }
    }

    const valid = validateLayerDocument(parsed);
    if (!valid.ok) {
      console.warn('[layerGenerator] invalid generated document:', valid.error);
      return null;
    }
    return valid.doc;
  } catch (e) {
    console.warn('[layerGenerator] generation failed:', (e as Error).message);
    return null;
  }
}
