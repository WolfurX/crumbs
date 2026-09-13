// The picture step: validate, resize to fit 1024px, encode as WebP in the browser.
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const IMAGE_SIDE = 1024
const TYPES: Record<string, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/gif': 'GIF', 'image/webp': 'WebP' }

export interface PreparedImage {
  bytes: Uint8Array
  mime: string
  width: number
  height: number
  /** Something worth saying next to the preview, never an error. */
  note?: string
  previewUrl: string
}

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

function describe(file: File): string {
  if (file.type) return `That is ${file.type.replace(/^application\//, 'a ').replace(/^[a-z]+\//, '')}`.replace('That is pdf', 'That is a PDF')
  const ext = file.name.split('.').pop()
  return ext ? `That is a .${ext} file` : 'That file type is not a picture'
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!TYPES[file.type]) throw new Error(`${describe(file)}. PNG, JPG, GIF or WebP.`)
  if (file.size > IMAGE_MAX_BYTES) throw new Error(`${fmtBytes(file.size)}, the limit is ${fmtBytes(IMAGE_MAX_BYTES)}.`)
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    throw new Error('That picture could not be read. Try exporting it again as PNG or JPG.')
  }
  const scale = Math.min(1, IMAGE_SIDE / Math.max(bmp.width, bmp.height))
  const width = Math.max(1, Math.round(bmp.width * scale))
  const height = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot draw pictures.')
  ctx.drawImage(bmp, 0, 0, width, height)
  bmp.close()
  let blob = await toBlob(canvas, 'image/webp', 0.82)
  let mime = 'image/webp'
  if (!blob || blob.type !== 'image/webp') {
    // Browsers without a WebP encoder (older Safari) get JPEG; transparency is lost there.
    blob = await toBlob(canvas, 'image/jpeg', 0.85)
    mime = 'image/jpeg'
  }
  if (!blob) throw new Error('This browser could not encode the picture.')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const note = file.type === 'image/gif' ? 'Animation is not kept, the first frame is used.' : mime === 'image/jpeg' ? 'Saved as JPG because this browser cannot write WebP.' : undefined
  return { bytes, mime, width, height, note, previewUrl: URL.createObjectURL(blob) }
}
