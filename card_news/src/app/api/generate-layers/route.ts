import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { generateLayerDocument } from '@/lib/layerGenerator';
import { buildCardLayerDocument } from '@/lib/layerBuilder';
import { generateBestOfLayerDocument, type TtsResult } from '@/lib/tts';

export const maxDuration = 60;

// Test-Time Scaling is opt-in: set AGENT_TTS_ENABLED=1 (or true) to spend extra
// inference on harder topics. Off by default to keep latency/cost predictable.
function ttsEnabled() {
  const v = (process.env.AGENT_TTS_ENABLED ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// AI가 카드 레이아웃을 통째로 설계한다. theme(주제)와 선택적 배경 이미지를 받아
// 편집 가능한 LayerDocument를 반환한다. AGENT_TTS_ENABLED가 켜져 있으면
// Test-Time Scaling(Best-of-N + budget forcing)으로 품질을 끌어올린다.
// LLM 생성이 실패하면 휴리스틱 빌더로 기본 카드를 만들어 항상 편집기가 열릴 수
// 있게 한다.
export async function POST(req: Request) {
  try {
    const { theme, backgroundSrc, clientContext } = await req.json();

    if (typeof theme !== 'string' || !theme.trim()) {
      return NextResponse.json({ error: '주제(theme)가 필요합니다.' }, { status: 400 });
    }

    let layerDocument = null;
    let ttsMeta: TtsResult['meta'] | undefined;
    if (process.env.OPENAI_API_KEY) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const common = {
        openai,
        theme,
        clientContext: typeof clientContext === 'string' ? clientContext : undefined,
        backgroundSrc: typeof backgroundSrc === 'string' ? backgroundSrc : undefined,
      };

      if (ttsEnabled()) {
        const result = await generateBestOfLayerDocument({
          ...common,
          useLlmReward: (process.env.AGENT_TTS_LLM_REWARD ?? '').toLowerCase() === '1',
        });
        layerDocument = result.doc;
        ttsMeta = result.meta;
      } else {
        layerDocument = await generateLayerDocument(common);
      }
    }

    // Heuristic fallback so the editor always has a document to open.
    if (!layerDocument) {
      layerDocument = buildCardLayerDocument({
        copy: { headline: theme.trim(), subheadline: '', badge: '' },
        backgroundSrc: typeof backgroundSrc === 'string' ? backgroundSrc : undefined,
      });
    }

    return NextResponse.json({ layerDocument, ...(ttsMeta ? { tts: ttsMeta } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[generate-layers]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
