// Client-side image compressor. Runs in the browser before any upload.
// Decodes an image, auto-rotates via EXIF, resizes the longest side to
// `maxDimension`, and re-encodes as JPEG at `quality`. Returns a new File.
// Non-image files are returned unchanged. On any failure, the original file
// is returned so the upload is never blocked.

const DEFAULT_MAX_DIMENSION = 2048;
const DEFAULT_QUALITY = 0.82;

const COMPRESSIBLE_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export type CompressImageOptions = {
  maxDimension?: number;
  quality?: number;
};

export async function compressImageClient(
  file: File,
  opts: CompressImageOptions = {}
): Promise<File> {
  if (typeof window === "undefined") return file;
  if (!COMPRESSIBLE_MIME.has(file.type)) return file;

  const maxDimension = opts.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const quality = opts.quality ?? DEFAULT_QUALITY;

  try {
    const { width, height, draw } = await decodeImage(file);
    if (!width || !height) return file;

    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = makeCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    draw(ctx, targetW, targetH);

    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (!blob || blob.size >= file.size) {
      // If the "compressed" blob is larger (rare for tiny PNGs), keep the original.
      return blob && blob.size < file.size ? toJpegFile(file, blob) : file;
    }
    return toJpegFile(file, blob);
  } catch (err) {
    console.warn("[compressImageClient] failed, uploading original:", err);
    return file;
  }
}

type DecodedImage = {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number) => void;
};

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => {
        (ctx as CanvasRenderingContext2D).drawImage(bitmap, 0, 0, w, h);
        bitmap.close?.();
      },
    };
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Image decode failed"));
      el.src = url;
    });
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      draw: (ctx, w, h) => {
        (ctx as CanvasRenderingContext2D).drawImage(img, 0, 0, w, h);
      },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(w, h);
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas: AnyCanvas, mime: string, quality: number): Promise<Blob | null> {
  if ("convertToBlob" in canvas) {
    return (canvas as OffscreenCanvas).convertToBlob({ type: mime, quality });
  }
  return new Promise((resolve) => {
    (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), mime, quality);
  });
}

function toJpegFile(original: File, blob: Blob): File {
  const base = original.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${base}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}
