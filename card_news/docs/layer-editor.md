# 레이어 편집기 (carnews-insta PR #11 이식)

`carnews-insta` PR #11("편집 가능한 레이어 문서 파이프라인")의 핵심 기능을 현재
`card_news` 서비스로 가져왔습니다. 단, "별로였던 서비스"의 무거운 인프라
(Puppeteer/Chromium 서버 렌더링, Redis 잡스토어, Prisma/Postgres, next-auth,
Instagram 스크래핑)는 **가져오지 않았고**, 렌더링·편집·내보내기는 모두
**Fabric.js 기반 클라이언트 사이드**로 대체했습니다.

## 흐름

```
레퍼런스 카드 + 내 사진  ──►  POST /api/analyze (OpenAI 이미지 합성, 기존)
        │                         └─► 합성 이미지 1장
        ▼
"✏️ 편집기로 꾸미기"      ──►  POST /api/generate-layers
        │                         └─► AI(LLM)가 편집 가능한 LayerDocument 설계
        │                             (한글 카피 + 위치/계층). 실패 시 휴리스틱 폴백.
        │                         합성 이미지를 배경 레이어로 주입.
        ▼
FabricLayerEditor (브라우저)
  · 클릭 선택 / 드래그 이동 / 더블클릭 인라인 텍스트 편집
  · 글자 크기·색, 레이어 가시성 토글, 텍스트 추가, Delete 삭제
  · 🔄 AI 배경 다시 생성  ──►  POST /api/generate-background (Replicate)
  · ✨ 고화질로 저장       ──►  canvas.toDataURL (1024×1536 풀해상도 JPEG)
```

## 추가된 파일

| 파일 | 역할 |
|---|---|
| `src/lib/layerSchema.ts` | `LayerDocument` 타입 + 의존성 0 검증기. **렌더 방식과 무관한 계약** |
| `src/lib/layerGenerator.ts` | LLM(`gpt-4.1-mini`, `response_format: json_object`)이 LayerDocument 생성. 누락 렌더 필드 backfill, 검증 실패 시 null |
| `src/lib/layerBuilder.ts` | 휴리스틱 폴백 빌더(헤드라인/서브/배지 기본 카드) |
| `src/lib/backgroundGen.ts` | Replicate(FLUX schnell) 텍스트 없는 배경 생성. 토큰 없으면 graceful degrade |
| `src/components/FabricLayerEditor.tsx` | Fabric.js 편집기. LayerDocument → fabric 객체, 풀해상도 export |
| `src/app/api/generate-layers/route.ts` | 레이어 문서 생성 API |
| `src/app/api/generate-background/route.ts` | AI 배경 생성 API |
| `src/app/api/proxy/route.ts` | 원격 이미지 프록시(SSRF 방어). export 캔버스 taint 방지 |

## 환경변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | 이미지 합성(`/api/analyze`) + 레이어 카피/레이아웃 생성 |
| `REPLICATE_API_TOKEN` | 선택 | AI 배경 생성. 없으면 배경 생성 버튼이 503으로 우아하게 비활성 |
| `REPLICATE_BG_MODEL` | 선택 | 기본 `black-forest-labs/flux-schnell` |

## PR #11 대비 변경점 (Chromium → Fabric.js)

`LayerDocument` 스키마와 생성 파이프라인은 렌더 방식과 분리돼 있어 그대로 재사용하고,
렌더링 레이어만 교체했습니다.

- ❌ `puppeteerShot.ts` / `render-layers` / `render-card`(서버 래스터) — 제거
- ❌ `@sparticuz/chromium`, `puppeteer-core`, `html-to-image` — 불필요
- ❌ Redis 잡스토어, Prisma, next-auth — 미이식
- ✅ Fabric `Textbox`로 인라인 편집·줄바꿈·드래그를 기본 제공받아 수작업 로직 제거
- ✅ export는 `canvas.toDataURL({ format:'jpeg', multiplier:1 })` — 백킹스토어가 풀해상도
- ✅ 원격 이미지는 `/api/proxy`로 same-origin 처리해 `toDataURL` taint 에러 회피
