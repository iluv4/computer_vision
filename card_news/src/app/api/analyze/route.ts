import { NextResponse } from "next/server";
import OpenAI from "openai";

export async function POST(request: Request) {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  try {
    const { referenceImage, userImage } = await request.json();

    if (!referenceImage || !userImage) {
      return NextResponse.json(
        {
          error: "레퍼런스와 유저 사진이 모두 필요합니다.",
        },
        {
          status: 400,
        },
      );
    }

    const response = await openai.responses.create({
      model: "gpt-4.1",
      tools: [{ type: "image_generation" }],
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `
Use image 1 as the PRIMARY template and design source.

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

Image 2 controls ONLY the product/food.

Completely remove the background from image 2.

Extract only the main food/product from image 2 and place it naturally into the advertising scene from image 1.

Do NOT create a new advertisement design.

Do NOT redesign the layout.

Do NOT invent a new background.

Do NOT change the typography positions.

Do NOT change the badge positions.

Do NOT change the visual hierarchy.

Reuse the visual structure of image 1 as closely as possible.

The final result should look almost identical to image 1 in terms of design, background, colors, composition, and marketing style.

Only replace the original product shown in image 1 with the product from image 2.

If there is any conflict between the two images, always follow image 1.

The output should look like a professionally edited marketing card-news where the product has been replaced while preserving the original advertisement design.
              `,
            },
            {
              type: "input_image",
              image_url: referenceImage,
              detail: "high",
            },
            {
              type: "input_image",
              image_url: userImage,
              detail: "high",
            },
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
