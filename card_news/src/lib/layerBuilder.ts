// Heuristic fallback builder for a LayerDocument.
//
// Used when the AI layout generator (layerGenerator) is unavailable or returns
// an invalid document. Produces a sensible default card — a background plus a
// headline/subheadline/badge — so the editor always has something to open.

import { CANVAS_W, CANVAS_H, type Layer, type LayerDocument } from './layerSchema';

export interface CardStyle {
  bgColor: string;
  textColor: string;
  accentColor: string;
  overlayOpacity: number;
  fontWeight: string;
}

export interface CardCopy {
  headline: string;
  subheadline: string;
  badge: string;
}

export const DEFAULT_STYLE: CardStyle = {
  bgColor: '#111111',
  textColor: '#ffffff',
  accentColor: '#ff6b35',
  overlayOpacity: 0.55,
  fontWeight: '800',
};

export function buildCardLayerDocument(params: {
  style?: Partial<CardStyle>;
  copy: CardCopy;
  // image: a data/remote URL used as the background. When omitted a solid
  // background of style.bgColor is used instead.
  backgroundSrc?: string;
}): LayerDocument {
  const style: CardStyle = { ...DEFAULT_STYLE, ...params.style };
  const { copy, backgroundSrc } = params;
  const layers: Layer[] = [];

  if (backgroundSrc) {
    layers.push({ id: 'bg', type: 'background', source: 'image', value: backgroundSrc, overlayOpacity: style.overlayOpacity, z: 0 });
  } else {
    layers.push({ id: 'bg', type: 'background', source: 'solid', value: style.bgColor, overlayOpacity: style.overlayOpacity, z: 0 });
  }

  if (copy.badge) {
    layers.push({ id: 'badge-bg', type: 'shape', shape: 'circle', bbox: { x: CANVAS_W - 188, y: 48, w: 140, h: 140 }, fill: style.bgColor, z: 10 });
    layers.push({
      id: 'badge-text', type: 'text', editable: true,
      bbox: { x: CANVAS_W - 188, y: 48, w: 140, h: 140 },
      content: copy.badge, color: style.accentColor, fontWeight: 900, fontSize: 36,
      align: 'center', lineHeight: 1.2, z: 11,
    });
  }

  if (copy.subheadline) {
    layers.push({
      id: 'subheadline', type: 'text', editable: true,
      bbox: { x: 60, y: CANVAS_H - 360, w: CANVAS_W - 120, h: 60 },
      content: copy.subheadline, color: style.textColor, fontWeight: 400, fontSize: 36,
      align: 'left', z: 20,
    });
  }

  layers.push({
    id: 'headline', type: 'text', editable: true,
    bbox: { x: 60, y: CANVAS_H - 300, w: CANVAS_W - 120, h: 220 },
    content: copy.headline, color: style.textColor, fontWeight: style.fontWeight, fontSize: 96,
    align: 'left', lineHeight: 1.15, letterSpacing: -2,
    shadow: '0 2px 12px rgba(0,0,0,0.5)', z: 21,
  });

  layers.push({ id: 'accent-line', type: 'shape', shape: 'rect', bbox: { x: 60, y: CANVAS_H - 64, w: 80, h: 6 }, fill: style.accentColor, radius: 3, z: 22 });

  return { canvas: { w: CANVAS_W, h: CANVAS_H }, layers };
}
