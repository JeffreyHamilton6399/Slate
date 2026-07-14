/**
 * Decode an image file into a data URL small enough to live inside the
 * synced document (one Yjs update must stay under MAX_UPDATE_BYTES, so we
 * cap the encoded payload and progressively downscale until it fits).
 */

// Matches the shape validator's `src` cap with headroom for the rest of
// the update (base64 chars, not bytes).
const MAX_SRC_CHARS = 550_000;
const MAX_DIM_FIRST_TRY = 1600;

export interface ImportedImage {
  src: string;
  /** Natural (possibly downscaled) pixel size. */
  w: number;
  h: number;
}

export async function fileToImageShape(file: Blob): Promise<ImportedImage> {
  const bitmap = await decode(file);
  try {
    let maxDim = Math.min(MAX_DIM_FIRST_TRY, Math.max(bitmap.width, bitmap.height));
    let quality = 0.85;
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 2d context unavailable');
      ctx.drawImage(bitmap, 0, 0, w, h);
      // WebP keeps alpha and compresses well; browsers without a webp
      // encoder silently return PNG, which the size loop still handles.
      const src = canvas.toDataURL('image/webp', quality);
      if (src.length <= MAX_SRC_CHARS) return { src, w, h };
      maxDim = Math.round(maxDim * 0.7);
      quality = Math.max(0.5, quality - 0.1);
    }
    throw new Error('image is too large to embed — try a smaller file');
  } finally {
    if ('close' in bitmap) (bitmap as ImageBitmap).close();
  }
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through: some browsers can't bitmap-decode SVGs.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('could not decode image'));
      img.src = url;
    });
  } finally {
    // Revoke after decode; the pixels are already in the <img>.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** File extensions we route to the 2D image importer. */
export function isImageFile(file: File): boolean {
  return (
    file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg|avif)$/i.test(file.name)
  );
}
