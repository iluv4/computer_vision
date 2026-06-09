// Editable layer document — COLE-style hierarchical layer tree.
// A render-agnostic representation of a card-news design. Each layer can be
// moved, hidden, restyled, or re-rendered independently. The schema is the
// contract between the AI generator (server) and the editor (Fabric.js, client).

export const CANVAS_W = 1024;
export const CANVAS_H = 1536;

export type BBox = { x: number; y: number; w: number; h: number };

export interface BaseLayer {
  id: string;
  z: number;
  visible?: boolean;
}

export interface BackgroundLayer extends BaseLayer {
  type: 'background';
  // 'ai' is an AI-generated (text-free) image; rendered identically to 'image'
  // but tracked separately so the UI can show provenance / offer regeneration.
  source: 'image' | 'gradient' | 'solid' | 'ai';
  // image/ai: data/remote URL, gradient: CSS gradient string, solid: hex
  value: string;
  overlayOpacity?: number;
}

export interface ImageLayer extends BaseLayer {
  type: 'image';
  bbox: BBox;
  src: string;
  fit?: 'cover' | 'contain';
  radius?: number;
}

export interface TextLayer extends BaseLayer {
  type: 'text';
  bbox: BBox;
  content: string;
  color: string;
  fontWeight: string | number;
  fontSize: number;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number;
  letterSpacing?: number;
  shadow?: string;
  editable: true;
}

export interface ShapeLayer extends BaseLayer {
  type: 'shape';
  bbox: BBox;
  shape: 'rect' | 'circle' | 'line';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  radius?: number;
}

export type Layer = BackgroundLayer | ImageLayer | TextLayer | ShapeLayer;

export interface LayerDocument {
  canvas: { w: number; h: number };
  layers: Layer[];
}

// ── Validation (dependency-free; zod is not in the project) ──────────────────
function isFiniteNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function isBBox(b: unknown): b is BBox {
  const v = b as BBox;
  return !!v && isFiniteNum(v.x) && isFiniteNum(v.y) && isFiniteNum(v.w) && isFiniteNum(v.h);
}

export function validateLayerDocument(doc: unknown): { ok: true; doc: LayerDocument } | { ok: false; error: string } {
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'document is not an object' };
  const d = doc as LayerDocument;
  if (!d.canvas || !isFiniteNum(d.canvas.w) || !isFiniteNum(d.canvas.h)) {
    return { ok: false, error: 'canvas.w/h must be numbers' };
  }
  if (!Array.isArray(d.layers)) return { ok: false, error: 'layers must be an array' };

  for (const [i, layer] of d.layers.entries()) {
    if (!layer || typeof layer !== 'object') return { ok: false, error: `layer[${i}] is not an object` };
    if (typeof layer.id !== 'string') return { ok: false, error: `layer[${i}].id missing` };
    if (!isFiniteNum(layer.z)) return { ok: false, error: `layer[${i}].z must be a number` };
    switch (layer.type) {
      case 'background':
        if (typeof (layer as BackgroundLayer).value !== 'string') return { ok: false, error: `layer[${i}] background.value missing` };
        break;
      case 'image':
        if (typeof (layer as ImageLayer).src !== 'string') return { ok: false, error: `layer[${i}] image.src missing` };
        if (!isBBox((layer as ImageLayer).bbox)) return { ok: false, error: `layer[${i}] image.bbox invalid` };
        break;
      case 'text':
        if (typeof (layer as TextLayer).content !== 'string') return { ok: false, error: `layer[${i}] text.content missing` };
        if (!isBBox((layer as TextLayer).bbox)) return { ok: false, error: `layer[${i}] text.bbox invalid` };
        break;
      case 'shape':
        if (!isBBox((layer as ShapeLayer).bbox)) return { ok: false, error: `layer[${i}] shape.bbox invalid` };
        break;
      default:
        return { ok: false, error: `layer[${i}] has unknown type "${(layer as Layer).type}"` };
    }
  }
  return { ok: true, doc: d };
}
