import { NextResponse } from "next/server";
import OpenAI from "openai";

export async function POST(request: Request) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  try {
    const body = await request.json();
    const { referenceImage, userImage, userImages, theme } = body;

    // 사용자가 입력한 카드 주제·문구. 있을 때만 프롬프트에 반영한다.
    const topicText = typeof theme === "string" ? theme.trim() : "";

    // 다중 주체 사진 지원: userImages 배열을 우선 사용하고, 없으면 단일 userImage로 폴백한다.
    const subjectImages: string[] = Array.isArray(userImages)
      ? userImages.filter((img): img is string => typeof img === "string" && !!img)
      : typeof userImage === "string" && userImage
        ? [userImage]
        : [];

    if (!referenceImage || subjectImages.length === 0) {
      return NextResponse.json(
        {
          error: "레퍼런스와 유저 사진이 모두 필요합니다.",
        },
        {
          status: 400,
        },
      );
    }

    // 주제 문구가 있으면, 이미지1의 헤드라인 텍스트만 이 주제로 교체하도록 강하게 지시한다.
    const topicInstruction = topicText
      ? `
=== CARD-NEWS TOPIC (MUST be reflected in the output) ===
The headline/promotional copy MUST convey this topic: "${topicText}".
- This is a HARD requirement: the rendered image MUST visibly contain text expressing this topic.
- Replace the existing main headline/promotional copy from image 1 with text expressing this topic.
- Write it in the SAME language as image 1 (Korean if image 1 is Korean), and make sure every character is spelled correctly and fully legible.
- Keep the original font, size, color, alignment and POSITION of that text exactly as in image 1 — change only the wording.
- Do NOT add new text blocks beyond those already present in image 1, and do NOT translate or alter any text that is unrelated to the topic.
========================================================
`
      : "";

    // 첨부된 주체 사진 수에 맞춰 합성 지시를 동적으로 구성한다.
    const productImageCount = subjectImages.length;
    const productInstruction =
      productImageCount > 1
        ? `Images 2 through ${productImageCount + 1} each contain a separate product/food item.
For EACH of those images: completely remove its background, extract only the main product/food, and place ALL of them naturally into the advertising scene from image 1.
Arrange the multiple products together in a balanced, professional composition that fits the original layout — do NOT drop or ignore any of the provided products.`
        : `Image 2 controls ONLY the product/food.
Completely remove the background from image 2.
Extract only the main food/product from image 2 and place it naturally into the advertising scene from image 1.`;

    const response = await openai.responses.create({
      model: "gpt-4.1",
      // 카드뉴스는 세로형이므로 세로 캔버스로 생성해 편집기(1024x1536)와 비율을 맞춘다.
      tools: [{ type: "image_generation", size: "1024x1536" }],
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `
Use image 1 as the PRIMARY template and design source.
${topicInstruction}

Image 1 controls:
- background
- layout
- typography placement
- graphic elements
- promotional badges
- colors
- lighting
- composition
- camera angle
- overall advertising style

${productInstruction}

Do NOT create a new advertisement design.

Do NOT redesign the layout.

Do NOT invent a new background.

Do NOT change the typography positions.

Do NOT change the badge positions.

Do NOT change the visual hierarchy.

Reuse the visual structure of image 1 as closely as possible.

The final result should look almost identical to image 1 in terms of design, background, colors, composition, and marketing style.

Replace the original product shown in image 1 with the product(s) from the provided product image(s).

If there is any conflict between the images, always follow image 1.

The output should look like a professionally edited marketing card-news where the product has been replaced while preserving the original advertisement design${topicText ? " AND the headline text reflects the requested topic" : ""}.
              `,
            },
            {
              type: "input_image" as const,
              image_url: referenceImage,
              detail: "high" as const,
            },
            ...subjectImages.map((img) => ({
              type: "input_image" as const,
              image_url: img,
              detail: "high" as const,
            })),
          ],
        },
      ],
    });

    console.log("OPENAI RESPONSE:", JSON.stringify(response, null, 2));

    const imageOutput = response.output?.find(
      (item) => item.type === "image_generation_call",
    );

    if (!imageOutput) {
      throw new Error("이미지 생성 결과를 찾을 수 없습니다.");
    }

    const base64Image = imageOutput.result;

    if (!base64Image) {
      throw new Error("이미지 데이터가 없습니다.");
    }

    return NextResponse.json({
      resultImageUrl: `data:image/png;base64,${base64Image}`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error("서버 에러:", error);

    return NextResponse.json(
      {
        error:
          error?.message ?? "이미지 생성 중 알 수 없는 오류가 발생했습니다.",
      },
      {
        status: 500,
      },
    );
  }
}
