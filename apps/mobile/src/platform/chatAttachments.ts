import { platform, type LocalFile } from './ports';

export type ChatAttachmentSource = 'camera' | 'image' | 'file' | { recentId: string };

export function pickChatAttachment(source: ChatAttachmentSource): Promise<LocalFile | null> {
  if (typeof source === 'object') return platform.pickRecentChatImage(source.recentId);
  if (source === 'camera') return platform.capturePhoto();
  if (source === 'image') return platform.pickImage();
  return platform.pickDocument();
}

export const isTextFile = (file: LocalFile) =>
  /\.(txt|md|csv|tsv|json|log|docx|xlsx)$/i.test(file.name);
export const isAudioFile = (file: LocalFile) => file.mime_type.startsWith('audio/');
export const isImageFile = (file: LocalFile) =>
  /^image\/(jpeg|png)$/i.test(file.mime_type) || /\.(jpe?g|png)$/i.test(file.name);
