'use client';

// Client-side editable card editor built on Fabric.js.
//
// Replaces the PR #11 html-to-image + server-Puppeteer rasterization path:
// a LayerDocument is mapped onto a full-resolution (1024x1536) Fabric canvas
// that is displayed scaled-down via CSS. Fabric gives us selection, drag,
// inline text editing (double-click), and a high-resolution export
// (canvas.toDataURL) for free — no server round-trip, no headless Chrome.
//
// Remote images (AI backgrounds, etc.) are routed through /api/proxy so the
// export canvas is not cross-origin-tainted (toDataURL would otherwise throw).

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Canvas,
  FabricImage,
  Textbox,
  Rect,
  Circle,
  Line,
  Gradient,
  Shadow,
  type FabricObject,
} from 'fabric';
import {
  CANVAS_W,
  CANVAS_H,
  type LayerDocument,
  type BackgroundLayer,
  type TextLayer,
  type ShapeLayer,
  type ImageLayer,
} from '@/lib/layerSchema';

// Route remote images through our same-origin proxy so the export canvas is
// not tainted. data: URIs and same-origin paths are left untouched.
function proxied(url: string): string {
  if (!url || url.startsWith('data:') || url.startsWith('/')) return url;
  if (/^https?:\/\//i.test(url)) return `/api/proxy?url=${encodeURIComponent(url)}`;
  return url;
}

const FONT_FAMILY = "'Noto Sans KR', sans-serif";

// Ensure the Korean web font is present and loaded before we lay out / export
// text — otherwise Fabric measures/raster with a fallback font.
async function ensureKoreanFont(): Promise<void> {
  if (typeof window === 'undefined') return;
  const id = 'noto-sans-kr-font';
  if (!window.document.getElementById(id)) {
    const link = window.document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap';
    window.document.head.appendChild(link);
  }
  try {
    await Promise.all([
      window.document.fonts.load("400 36px 'Noto Sans KR'"),
      window.document.fonts.load("700 64px 'Noto Sans KR'"),
      window.document.fonts.load("900 96px 'Noto Sans KR'"),
    ]);
    await window.document.fonts.ready;
  } catch {
    /* font load best-effort */
  }
}

function shadowFor(layer: TextLayer): Shadow | undefined {
  if (!layer.shadow) return undefined;
  // Our shadow strings look like "0 2px 12px rgba(0,0,0,0.5)". Fabric's string
  // parser expects a different order, so build it explicitly for legibility.
  return new Shadow({ color: 'rgba(0,0,0,0.5)', blur: 12, offsetX: 0, offsetY: 2 });
}

function gradientFromCss(value: string): Gradient<'linear'> | null {
  // Best-effort: pull hex/rgb colors out of an arbitrary CSS gradient string
  // and lay them out as a vertical linear gradient.
  const colors = value.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g);
  if (!colors || colors.length < 2) return null;
  const stops = colors.map((color, i) => ({ offset: i / (colors.length - 1), color }));
  return new Gradient({
    type: 'linear',
    coords: { x1: 0, y1: 0, x2: 0, y2: CANVAS_H },
    colorStops: stops,
  });
}

interface Props {
  document: LayerDocument;
  previewWidth?: number;
  // Theme drives AI background regeneration; hidden when absent.
  theme?: string;
}

interface TextEntry {
  id: string;
  label: string;
}

export default function FabricLayerEditor({ document: doc, previewWidth = 360, theme }: Props) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  // id → fabric object, for visibility toggles and background swaps.
  const objMapRef = useRef<Map<string, FabricObject>>(new Map());

  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState('');
  const [textLayers, setTextLayers] = useState<TextEntry[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  // Selected text styling, mirrored into the toolbar.
  const [selFontSize, setSelFontSize] = useState<number | null>(null);
  const [selColor, setSelColor] = useState<string>('#ffffff');

  const scale = previewWidth / CANVAS_W;
  const previewHeight = CANVAS_H * scale;

  // ── Build the Fabric scene from the LayerDocument ──────────────────────────
  useEffect(() => {
    let disposed = false;
    const el = canvasElRef.current;
    if (!el) return;

    const canvas = new Canvas(el, {
      width: CANVAS_W,
      height: CANVAS_H,
      backgroundColor: '#111111',
      enableRetinaScaling: false,
      preserveObjectStacking: true,
    });
    // Display scaled-down while keeping the full-resolution backing store.
    canvas.setDimensions({ width: `${previewWidth}px`, height: `${previewHeight}px` }, { cssOnly: true });
    fabricRef.current = canvas;

    const objMap = objMapRef.current;
    objMap.clear();

    const tagged = (obj: FabricObject, id: string): FabricObject => {
      (obj as FabricObject & { layerId?: string }).layerId = id;
      objMap.set(id, obj);
      return obj;
    };

    const addOverlay = (opacity: number) => {
      const overlay = new Rect({
        left: 0,
        top: 0,
        width: CANVAS_W,
        height: CANVAS_H,
        selectable: false,
        evented: false,
        fill: new Gradient({
          type: 'linear',
          coords: { x1: 0, y1: 0, x2: 0, y2: CANVAS_H },
          colorStops: [
            { offset: 0, color: 'rgba(0,0,0,0.05)' },
            { offset: 0.5, color: `rgba(0,0,0,${opacity * 0.4})` },
            { offset: 1, color: `rgba(0,0,0,${Math.min(1, opacity + 0.2)})` },
          ],
        }),
      });
      canvas.add(overlay);
    };

    const build = async () => {
      await ensureKoreanFont();
      const sorted = [...doc.layers].sort((a, b) => a.z - b.z);
      const texts: TextEntry[] = [];

      for (const layer of sorted) {
        if (disposed) return;
        switch (layer.type) {
          case 'background': {
            const l = layer as BackgroundLayer;
            if (l.source === 'image' || l.source === 'ai') {
              try {
                const img = await FabricImage.fromURL(proxied(l.value), { crossOrigin: 'anonymous' });
                if (disposed) return;
                const s = Math.max(CANVAS_W / (img.width || CANVAS_W), CANVAS_H / (img.height || CANVAS_H));
                img.set({
                  left: (CANVAS_W - (img.width || 0) * s) / 2,
                  top: (CANVAS_H - (img.height || 0) * s) / 2,
                  scaleX: s,
                  scaleY: s,
                  selectable: false,
                  evented: false,
                });
                canvas.add(img);
                tagged(img, l.id);
              } catch {
                canvas.backgroundColor = '#111111';
              }
            } else if (l.source === 'gradient') {
              const grad = gradientFromCss(l.value);
              if (grad) {
                const rect = new Rect({ left: 0, top: 0, width: CANVAS_W, height: CANVAS_H, fill: grad, selectable: false, evented: false });
                canvas.add(rect);
                tagged(rect, l.id);
              } else {
                canvas.backgroundColor = '#111111';
              }
            } else {
              canvas.backgroundColor = l.value;
            }
            if (l.overlayOpacity && l.overlayOpacity > 0) addOverlay(l.overlayOpacity);
            break;
          }
          case 'image': {
            const l = layer as ImageLayer;
            try {
              const img = await FabricImage.fromURL(proxied(l.src), { crossOrigin: 'anonymous' });
              if (disposed) return;
              img.set({
                left: l.bbox.x,
                top: l.bbox.y,
                scaleX: l.bbox.w / (img.width || l.bbox.w),
                scaleY: l.bbox.h / (img.height || l.bbox.h),
              });
              if (l.radius) img.set({ rx: l.radius, ry: l.radius } as Partial<FabricObject>);
              canvas.add(img);
              tagged(img, l.id);
            } catch {
              /* skip broken image layer */
            }
            break;
          }
          case 'text': {
            const l = layer as TextLayer;
            const charSpacing = l.letterSpacing != null ? (l.letterSpacing / (l.fontSize || 64)) * 1000 : -50;
            const tb = new Textbox(l.content, {
              left: l.bbox.x,
              top: l.bbox.y,
              width: l.bbox.w,
              fontSize: l.fontSize,
              fill: l.color,
              fontWeight: l.fontWeight,
              fontFamily: FONT_FAMILY,
              textAlign: l.align ?? 'left',
              lineHeight: l.lineHeight ?? 1.15,
              charSpacing,
              shadow: shadowFor(l),
              editable: true,
              splitByGrapheme: false,
            });
            canvas.add(tb);
            tagged(tb, l.id);
            texts.push({ id: l.id, label: l.content.slice(0, 10) || l.id });
            break;
          }
          case 'shape': {
            const l = layer as ShapeLayer;
            let shape: FabricObject;
            if (l.shape === 'circle') {
              shape = new Circle({ left: l.bbox.x, top: l.bbox.y, radius: Math.min(l.bbox.w, l.bbox.h) / 2, fill: l.fill, stroke: l.stroke, strokeWidth: l.strokeWidth });
            } else if (l.shape === 'line') {
              shape = new Line([l.bbox.x, l.bbox.y + l.bbox.h / 2, l.bbox.x + l.bbox.w, l.bbox.y + l.bbox.h / 2], { stroke: l.fill ?? l.stroke ?? '#fff', strokeWidth: l.strokeWidth ?? l.bbox.h ?? 4 });
            } else {
              shape = new Rect({ left: l.bbox.x, top: l.bbox.y, width: l.bbox.w, height: l.bbox.h, fill: l.fill, stroke: l.stroke, strokeWidth: l.strokeWidth, rx: l.radius, ry: l.radius });
            }
            canvas.add(shape);
            tagged(shape, l.id);
            break;
          }
        }
      }

      if (disposed) return;
      canvas.renderAll();
      setTextLayers(texts);
      setReady(true);
    };

    build();

    // Mirror Fabric selection into the toolbar state.
    const syncSelection = () => {
      const active = canvas.getActiveObject();
      if (active && active.type === 'textbox') {
        setSelFontSize(Math.round((active as Textbox).fontSize ?? 0));
        const fill = (active as Textbox).fill;
        setSelColor(typeof fill === 'string' && /^#[0-9a-fA-F]{6}$/.test(fill) ? fill : '#ffffff');
      } else {
        setSelFontSize(null);
      }
    };
    canvas.on('selection:created', syncSelection);
    canvas.on('selection:updated', syncSelection);
    canvas.on('selection:cleared', syncSelection);

    return () => {
      disposed = true;
      canvas.dispose();
      fabricRef.current = null;
    };
    // Rebuild only when the source document identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  // ── Toolbar actions ────────────────────────────────────────────────────────
  const activeTextbox = (): Textbox | null => {
    const a = fabricRef.current?.getActiveObject();
    return a && a.type === 'textbox' ? (a as Textbox) : null;
  };

  const bumpFontSize = (delta: number) => {
    const tb = activeTextbox();
    if (!tb) return;
    const next = Math.max(12, (tb.fontSize ?? 48) + delta);
    tb.set({ fontSize: next });
    fabricRef.current?.renderAll();
    setSelFontSize(Math.round(next));
  };

  const changeColor = (color: string) => {
    const tb = activeTextbox();
    if (!tb) return;
    tb.set({ fill: color });
    fabricRef.current?.renderAll();
    setSelColor(color);
  };

  const toggleVisible = (id: string) => {
    const obj = objMapRef.current.get(id);
    const canvas = fabricRef.current;
    if (!obj || !canvas) return;
    const nextVisible = !(obj.visible ?? true);
    obj.set({ visible: nextVisible });
    canvas.renderAll();
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (nextVisible) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addTextLayer = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const id = `text-${Date.now()}`;
    const tb = new Textbox('새 텍스트', {
      left: 80,
      top: 120,
      width: CANVAS_W - 160,
      fontSize: 64,
      fill: '#ffffff',
      fontWeight: 700,
      fontFamily: FONT_FAMILY,
      charSpacing: -50,
      shadow: new Shadow({ color: 'rgba(0,0,0,0.5)', blur: 12, offsetX: 0, offsetY: 2 }),
      editable: true,
    });
    (tb as FabricObject & { layerId?: string }).layerId = id;
    objMapRef.current.set(id, tb);
    canvas.add(tb);
    canvas.setActiveObject(tb);
    canvas.renderAll();
    setTextLayers((prev) => [...prev, { id, label: '새 텍스트' }]);
  }, []);

  // Delete the active object (keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const canvas = fabricRef.current;
      const active = canvas?.getActiveObject();
      // Don't hijack Backspace while editing text.
      if (!canvas || !active || (active as Textbox).isEditing) return;
      e.preventDefault();
      canvas.remove(active);
      canvas.discardActiveObject();
      canvas.renderAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleExport = async () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    setSaving(true);
    setError('');
    try {
      canvas.discardActiveObject();
      canvas.renderAll();
      await ensureKoreanFont();
      canvas.renderAll();
      // Backing store is already full-resolution (1024x1536), so multiplier 1.
      const dataUrl = canvas.toDataURL({ format: 'jpeg', quality: 0.95, multiplier: 1 });
      const a = window.document.createElement('a');
      a.href = dataUrl;
      a.download = `cardnews-${Date.now()}.jpg`;
      a.click();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Re-roll the AI background for the current theme, keeping all other layers.
  const regenerateBackground = async () => {
    if (!theme) return;
    const canvas = fabricRef.current;
    if (!canvas) return;
    setRegenerating(true);
    setError('');
    try {
      const res = await fetch('/api/generate-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '배경 생성 실패');

      const img = await FabricImage.fromURL(proxied(data.url), { crossOrigin: 'anonymous' });
      const s = Math.max(CANVAS_W / (img.width || CANVAS_W), CANVAS_H / (img.height || CANVAS_H));
      img.set({
        left: (CANVAS_W - (img.width || 0) * s) / 2,
        top: (CANVAS_H - (img.height || 0) * s) / 2,
        scaleX: s,
        scaleY: s,
        selectable: false,
        evented: false,
      });

      // Replace the existing background object (id 'bg') if present, else add to back.
      const prev = objMapRef.current.get('bg');
      if (prev) canvas.remove(prev);
      canvas.add(img);
      canvas.sendObjectToBack(img);
      objMapRef.current.set('bg', img);
      canvas.renderAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
      <div
        style={{
          width: previewWidth,
          height: previewHeight,
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
          background: '#111',
        }}
      >
        <canvas ref={canvasElRef} />
      </div>

      {!ready && <p style={{ fontSize: 13, color: '#666' }}>편집기를 불러오는 중…</p>}

      {/* Selected text layer controls */}
      {selFontSize != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
          <span style={{ fontSize: 12, color: '#666' }}>글자</span>
          <button onClick={() => bumpFontSize(-6)} style={ctrlBtn}>A−</button>
          <span style={{ fontSize: 12, width: 36, textAlign: 'center' }}>{selFontSize}</span>
          <button onClick={() => bumpFontSize(6)} style={ctrlBtn}>A+</button>
          <input
            type="color"
            value={selColor}
            onChange={(e) => changeColor(e.target.value)}
            style={{ width: 32, height: 28, border: 'none', background: 'none', cursor: 'pointer' }}
            title="글자 색"
          />
        </div>
      )}

      {/* Layer visibility chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
        {textLayers.map((l) => {
          const hidden = hiddenIds.has(l.id);
          return (
            <button
              key={l.id}
              onClick={() => toggleVisible(l.id)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid #ccc',
                background: hidden ? '#eee' : '#fff',
                opacity: hidden ? 0.5 : 1,
                cursor: 'pointer',
              }}
            >
              {hidden ? '🚫' : '👁'} {l.label}
            </button>
          );
        })}
        <button onClick={addTextLayer} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px dashed #ff6b35', background: '#fff', color: '#ff6b35', cursor: 'pointer' }}>
          ＋ 텍스트
        </button>
      </div>

      <p style={{ fontSize: 13, color: '#666', margin: 0, textAlign: 'center' }}>
        💡 레이어를 드래그해 옮기고, 텍스트는 더블클릭해 수정하세요. 선택 후 Delete로 삭제, 칩으로 켜고 끌 수 있어요.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
        {theme && (
          <button
            onClick={regenerateBackground}
            disabled={regenerating || saving}
            style={{
              padding: '12px 22px',
              borderRadius: 10,
              border: '1px solid #ff6b35',
              background: '#fff',
              color: '#ff6b35',
              fontWeight: 700,
              fontSize: 15,
              cursor: regenerating || saving ? 'default' : 'pointer',
              opacity: regenerating || saving ? 0.6 : 1,
            }}
          >
            {regenerating ? '배경 생성 중…' : '🔄 AI 배경 다시 생성'}
          </button>
        )}
        <button
          onClick={handleExport}
          disabled={saving || regenerating || !ready}
          style={{
            padding: '12px 28px',
            borderRadius: 10,
            border: 'none',
            background: saving ? '#999' : '#ff6b35',
            color: '#fff',
            fontWeight: 700,
            fontSize: 15,
            cursor: saving || regenerating ? 'default' : 'pointer',
          }}
        >
          {saving ? '고화질 렌더링 중…' : '✨ 고화질로 저장하기'}
        </button>
      </div>
      {error && <p style={{ color: '#d33', fontSize: 13 }}>{error}</p>}
    </div>
  );
}

const ctrlBtn: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  width: 36,
  height: 28,
  borderRadius: 6,
  border: '1px solid #ccc',
  background: '#fff',
  cursor: 'pointer',
};
