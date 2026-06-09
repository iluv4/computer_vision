import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { generateLayerDocument } from '@/lib/layerGenerator';
import { buildCardLayerDocument } from '@/lib/layerBuilder';

export const maxDuration = 60;

// AI가 카드 레이아웃을 통째로 설계한다. theme(주제)와 선택적 배경 이미지를 받아
// 편집 가능한 LayerDocument를 반환한다. LLM 생성이 실패하면 휴리스틱 빌더로
// 기본 카드를 만들어 항상 편집기가 열릴 수 있게 한다.
export async function POST(req: Request) {
  try {
    const { theme, backgroundSrc, clientContext } = await req.json();

    if (typeof theme !== 'string' || !theme.trim()) {
      return NextResponse.json({ error: '주제(theme)가 필요합니다.' }, { status: 400 });
    }

    let layerDocument = null;
    if (process.env.OPENAI_API_KEY) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      layerDocument = await generateLayerDocument({
        openai,
        theme,
        clientContext: typeof clientContext === 'string' ? clientContext : undefined,
        backgroundSrc: typeof backgroundSrc === 'string' ? backgroundSrc : undefined,
      });
    }

    // Heuristic fallback so the editor always has a document to open.
    if (!layerDocument) {
      layerDocument = buildCardLayerDocument({
        copy: { headline: theme.trim(), subheadline: '', badge: '' },
        backgroundSrc: typeof backgroundSrc === 'string' ? backgroundSrc : undefined,
      });
    }

    return NextResponse.json({ layerDocument });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[generate-layers]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
