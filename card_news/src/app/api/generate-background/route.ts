import { NextResponse } from 'next/server';
import { generateBackground } from '@/lib/backgroundGen';

export const maxDuration = 60;

// Generate a text-free AI background for a given theme. Returns a URL the
// client drops into a background layer (source: 'ai'); Korean copy stays as
// editable text layers on top. Degrades gracefully when the provider token is
// absent so the existing photo/gradient flow is unaffected.
export async function POST(req: Request) {
  try {
    const { theme } = await req.json();
    if (typeof theme !== 'string' || !theme.trim()) {
      return NextResponse.json({ error: 'theme is required' }, { status: 400 });
    }

    const result = await generateBackground(theme);
    if (!result.ok) {
      const status = result.reason === 'not_configured' ? 503 : 502;
      return NextResponse.json({ error: result.error, reason: result.reason }, { status });
    }

    return NextResponse.json({ url: result.url, source: 'ai' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[generate-background]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
