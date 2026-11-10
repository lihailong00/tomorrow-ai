import {MAX_CHAT_IMAGE_BYTES} from '@tada/client-core';

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 6_291_456;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];

export function pastedImage(clipboard: DataTransfer): File | undefined {
  return Array.from(clipboard.files).find(file => file.type.startsWith('image/'))
    ?? Array.from(clipboard.items).find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile()
    ?? undefined;
}

export function pastedImageError(file: File): string | undefined {
  if (!IMAGE_TYPES.includes(file.type)) return '请复制截图，或粘贴 PNG、JPEG、WebP 等常见格式的图片。';
  if (!file.size || file.size > MAX_SOURCE_BYTES) return '图片为空或超过 25 MiB，请缩小后重新粘贴。';
}

export async function prepareChatImage(file: File): Promise<File> {
  let bitmap: ImageBitmap;
  try {bitmap = await createImageBitmap(file);}
  catch {throw new Error('无法读取这张图片，请重新复制或更换图片。');}
  try {
    const {width, height} = bitmap;
    const scale = Math.min(1, 8192 / width, 8192 / height, Math.sqrt(MAX_PIXELS / (width * height)));
    if (scale === 1 && width >= 32 && height >= 32 && file.size <= MAX_CHAT_IMAGE_BYTES
      && (file.type === 'image/png' || file.type === 'image/jpeg')) {
      return new File([file], file.type === 'image/png' ? '粘贴的图片.png' : '粘贴的图片.jpg', {type: file.type});
    }
    const canvas = document.createElement('canvas');
    const imageWidth = Math.max(1, Math.floor(width * scale));
    const imageHeight = Math.max(1, Math.floor(height * scale));
    canvas.width = Math.max(32, imageWidth);
    canvas.height = Math.max(32, imageHeight);
    const context = canvas.getContext('2d', {alpha: false});
    if (!context) throw new Error('无法处理这张图片，请更换图片。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, imageWidth, imageHeight);
    const encode = (quality: number) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    let blob = await encode(0.9);
    if (blob && blob.size > MAX_CHAT_IMAGE_BYTES) blob = await encode(0.7);
    if (!blob || blob.size > MAX_CHAT_IMAGE_BYTES) throw new Error('图片压缩后仍无法发送，请裁剪后重试。');
    return new File([blob], '粘贴的图片.jpg', {type: blob.type});
  } finally {
    bitmap.close();
  }
}
