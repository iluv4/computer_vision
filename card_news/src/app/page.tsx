"use client";

import { useState, ChangeEvent } from "react";
import dynamic from "next/dynamic";
import styles from "./page.module.css";
import type { LayerDocument, BackgroundLayer } from "@/lib/layerSchema";

// Fabric.js touches the DOM/canvas, so load the editor client-side only.
const FabricLayerEditor = dynamic(
  () => import("@/components/FabricLayerEditor"),
  { ssr: false },
);

export default function HomePage() {
  const [refImage, setRefImage] = useState<string | null>(null);
  // 합성 주체(상품) 사진은 여러 장 첨부할 수 있다.
  const [userImages, setUserImages] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  // 텍스트 결과 대신 이미지 URL 상태 관리
  const [resultImageUrl, setResultImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  // 카드 주제(문구 생성 + AI 배경 재생성에 사용)
  const [theme, setTheme] = useState<string>("");
  // AI가 설계한 편집 가능한 레이어 문서
  const [layerDoc, setLayerDoc] = useState<LayerDocument | null>(null);
  const [openingEditor, setOpeningEditor] = useState<boolean>(false);

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const handleImageChange = (
    e: ChangeEvent<HTMLInputElement>,
    setImage: (value: string | null) => void,
  ) => {
    const file = e.target.files?.[0];
    if (file) {
      readFileAsDataUrl(file).then(setImage);
    }
  };

  // 여러 장의 주체 사진을 한 번에 첨부할 수 있도록 누적 방식으로 추가한다.
  const handleAddUserImages = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const dataUrls = await Promise.all(
      Array.from(files).map((file) => readFileAsDataUrl(file)),
    );
    setUserImages((prev) => [...prev, ...dataUrls]);
    // 같은 파일을 다시 선택할 수 있도록 input 값을 비운다.
    e.target.value = "";
  };

  const removeUserImage = (index: number) => {
    setUserImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAnalyze = async () => {
    if (!refImage || userImages.length === 0) {
      alert("레퍼런스 이미지와 촬영하신 사진을 모두 등록해주세요.");
      return;
    }

    setLoading(true);
    setError("");
    setResultImageUrl(null); // 이전 결과 초기화

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          referenceImage: refImage,
          // 다중 주체 사진 전송. 구버전 호환을 위해 단일 필드도 함께 보낸다.
          userImages,
          userImage: userImages[0],
          theme: theme.trim(),
        }),
      });

      const data = await response.json();

      if (response.ok) {
        // 백엔드에서 보낸 resultImageUrl 설정
        setResultImageUrl(data.resultImageUrl);
      } else {
        setError(data.error || "이미지 생성 중 오류가 발생했습니다.");
      }
    } catch (err) {
      setError("서버와 통신하는 중 문제가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  // AI에게 카드 레이아웃(편집 가능한 레이어)을 설계시키고, 생성된 이미지를
  // 배경 레이어로 주입한 뒤 Fabric 편집기를 연다.
  const handleOpenEditor = async () => {
    if (!resultImageUrl) return;
    setOpeningEditor(true);
    setError("");
    try {
      const response = await fetch("/api/generate-layers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: theme.trim() || "카드뉴스" }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "레이어 생성에 실패했습니다.");
      }

      // AI가 만든 문서의 배경을 방금 생성한 합성 이미지로 교체한다.
      const document = data.layerDocument as LayerDocument;
      const bg = document.layers.find((l) => l.type === "background") as
        | BackgroundLayer
        | undefined;
      if (bg) {
        bg.source = "image";
        bg.value = resultImageUrl;
        if (bg.overlayOpacity == null) bg.overlayOpacity = 0.45;
      } else {
        document.layers.unshift({
          id: "bg",
          type: "background",
          source: "image",
          value: resultImageUrl,
          overlayOpacity: 0.45,
          z: 0,
        });
      }
      setLayerDoc(document);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "레이어 생성 중 오류가 발생했습니다.",
      );
    } finally {
      setOpeningEditor(false);
    }
  };

  return (
    <main className={styles.mainContainer}>
      {/* 상단 헤더 (그대로 유지) */}
      <header className={styles.header}>
        <span className={styles.badge}>AI Vision-Gen Project</span>
        <h1 className={styles.title}>카드뉴스 사진 생성기</h1>
        <p className={styles.description}>
          레퍼런스 카드뉴스의 구도에 내 사진을 합성하여 완벽한 결과물을
          만들어냅니다.
        </p>
      </header>

      {/* 메인 콘텐츠 구역 */}
      <section className={styles.contentSection}>
        {/* 이미지 업로드 그리드 (그대로 유지) */}
        <div className={styles.gridContainer}>
          {/* 1. 레퍼런스 카드뉴스 업로드 */}
          <div className={styles.card}>
            <div>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>01. 레퍼런스 카드뉴스</h2>
                {refImage && <span className={styles.statusBadge}>등록됨</span>}
              </div>

              <label
                className={`${styles.dropzone} ${refImage ? styles.dropzoneActive : ""}`}
              >
                {refImage ? (
                  <img
                    src={refImage}
                    alt="Reference"
                    className={styles.previewImage}
                  />
                ) : (
                  <div className={styles.uploadInfo}>
                    {/* SVG 아이콘 그대로 유지 */}
                    <svg
                      className={styles.uploadIcon}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 002-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                    <p className={styles.uploadText}>클릭하여 이미지 업로드</p>
                    <p className={styles.uploadSubtext}>
                      PNG, JPG, WEBP (카드뉴스 예시)
                    </p>
                  </div>
                )}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleImageChange(e, setRefImage)}
                  style={{ display: "none" }}
                />
              </label>
            </div>
            {refImage && (
              <button
                onClick={() => setRefImage(null)}
                className={styles.clearButton}
              >
                이미지 지우기
              </button>
            )}
          </div>

          {/* 2. 유저 촬영 이미지 업로드 (여러 장 첨부 가능) */}
          <div className={styles.card}>
            <div>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardTitle}>02. 내가 직접 찍은 사진</h2>
                {userImages.length > 0 && (
                  <span className={styles.statusBadge}>
                    {userImages.length}장 등록됨
                  </span>
                )}
              </div>

              {userImages.length > 0 ? (
                <div className={styles.thumbGrid}>
                  {userImages.map((img, index) => (
                    <div key={index} className={styles.thumbItem}>
                      <img
                        src={img}
                        alt={`Subject ${index + 1}`}
                        className={styles.thumbImage}
                      />
                      <button
                        type="button"
                        onClick={() => removeUserImage(index)}
                        className={styles.thumbRemove}
                        aria-label="사진 삭제"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <label className={styles.thumbAdd}>
                    <span>＋ 사진 추가</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleAddUserImages}
                      style={{ display: "none" }}
                    />
                  </label>
                </div>
              ) : (
                <label className={styles.dropzone}>
                  <div className={styles.uploadInfo}>
                    {/* SVG 아이콘 그대로 유지 */}
                    <svg
                      className={styles.uploadIcon}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                        d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                        d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    <p className={styles.uploadText}>클릭하여 이미지 업로드</p>
                    <p className={styles.uploadSubtext}>
                      여러 장 동시 선택 가능 (촬영한 원본 사진)
                    </p>
                  </div>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={handleAddUserImages}
                    style={{ display: "none" }}
                  />
                </label>
              )}
            </div>
            {userImages.length > 0 && (
              <button
                onClick={() => setUserImages([])}
                className={styles.clearButton}
              >
                전체 지우기
              </button>
            )}
          </div>
        </div>

        {/* 카드 주제 입력 (문구 생성 / AI 배경 재생성에 사용) */}
        <div className={styles.actionArea}>
          <input
            type="text"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="카드 주제·문구 (예: 가을 신메뉴 출시, 주말 한정 할인)"
            style={{
              width: "100%",
              maxWidth: 560,
              padding: "12px 16px",
              borderRadius: 10,
              border: "1px solid #d1d5db",
              fontSize: 15,
              outline: "none",
            }}
          />
        </div>

        {/* 분석 실행 버튼 */}
        <div className={styles.actionArea}>
          <button
            onClick={handleAnalyze}
            disabled={loading}
            className={styles.submitButton}
          >
            {loading ? (
              <div className={styles.loadingFlex}>
                <span>AI가 이미지를 생성 중입니다... (약 20~30초 소요)</span>
              </div>
            ) : (
              "완성된 카드뉴스 생성하기"
            )}
          </button>
        </div>

        {/* 에러창 (유지) */}
        {error && <div className={styles.errorBox}>⚠️ {error}</div>}

        {/* [수정] 결과 리포트 창 -> 결과 이미지 창 */}
        {resultImageUrl && (
          <div className={styles.resultReport}>
            <div className={styles.reportHeader}>
              <div className={styles.reportIconContainer}>
                {/* 아이콘 그대로 유지 */}
                <svg
                  className={styles.reportIcon}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
              </div>
              <h3 className={styles.reportTitle}>최종 합성 결과물</h3>
            </div>

            {/* 생성된 이미지 출력 */}
            <div className={styles.generatedImageWrapper}>
              <img
                src={resultImageUrl}
                alt="AI Generated Result"
                className={styles.generatedImage}
              />
            </div>

            {/* 다운로드 링크 (DALL-E URL은 임시이므로 다운로드 권장) */}
            <a
              href={resultImageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.downloadLink}
            >
              고화질 이미지 보기 및 저장
            </a>

            {/* 편집기 열기: AI가 편집 가능한 텍스트/배경 레이어를 설계 */}
            {!layerDoc && (
              <button
                onClick={handleOpenEditor}
                disabled={openingEditor}
                className={styles.submitButton}
                style={{ marginTop: 16 }}
              >
                {openingEditor
                  ? "AI가 편집 가능한 레이어를 만드는 중…"
                  : "✏️ 편집기로 꾸미기 (텍스트·배경 편집)"}
              </button>
            )}
          </div>
        )}

        {/* 편집 가능한 레이어 에디터 (Fabric.js) */}
        {layerDoc && (
          <div className={styles.resultReport}>
            <div className={styles.reportHeader}>
              <h3 className={styles.reportTitle}>레이어 편집기</h3>
            </div>
            <FabricLayerEditor
              document={layerDoc}
              theme={theme.trim() || "카드뉴스"}
            />
          </div>
        )}
      </section>
    </main>
  );
}
