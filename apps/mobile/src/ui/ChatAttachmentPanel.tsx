import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { platform, type RecentChatImage } from '../platform/ports';
import { chatAppearance as colors } from './ChatAppearance';
import { Text } from './Text';
import { Icon } from './visuals';

type Props = {
  disabled: boolean;
  onCamera: () => void;
  onImage: () => void;
  onFile: () => void;
  onRecent: (id: string) => void;
};

export function ChatAttachmentPanel({ disabled, onCamera, onImage, onFile, onRecent }: Props) {
  const [images, setImages] = useState<RecentChatImage[]>([]);
  useEffect(() => {
    if (!platform.hasRecentChatImages) return;
    let current = true;
    void platform.recentChatImages().then(items => { if (current) setImages(items.slice(0, 8)); }, () => {});
    return () => { current = false; };
  }, []);

  const actions = [
    { label: '相机', a11y: '从相机拍照', icon: 'camera', run: onCamera },
    { label: '相册', a11y: '选择图片', icon: 'image', run: onImage },
    { label: '文件', a11y: '选择文件', icon: 'attachment', run: onFile },
    { label: '打电话', a11y: '打电话，暂未开放', icon: 'phone', run: undefined },
  ] as const;
  return (
    <View style={styles.panel} testID="chat-attachment-panel">
      <View style={styles.row}>
        {actions.map(({ label, a11y, icon, run }) => (
          <Pressable key={label} accessibilityRole="button" accessibilityLabel={a11y}
            disabled={disabled || !run} onPress={run} style={[styles.action, !run && styles.unavailable]}>
            <Icon name={icon} size={22} color={colors.accent} />
            <Text style={styles.label}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {images.length > 0 && <View style={styles.recent}>
        {images.map(image => <Pressable key={image.id} style={styles.thumbnail} disabled={disabled}
          accessibilityRole="button" accessibilityLabel={`添加照片：${image.name}`} onPress={() => onRecent(image.id)}>
          <Image accessible={false} source={{ uri: image.uri }} style={styles.image} resizeMode="cover" />
        </Pressable>)}
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 8, padding: 10, gap: 8, borderRadius: 20, backgroundColor: colors.surface },
  row: { flexDirection: 'row', gap: 6 },
  action: { flex: 1, minHeight: 64, gap: 4, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: colors.tint },
  unavailable: { opacity: 0.55 },
  label: { fontSize: 12, color: colors.ink },
  recent: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  thumbnail: { width: '23%', minHeight: 44, aspectRatio: 1, borderRadius: 9, overflow: 'hidden', backgroundColor: colors.tint },
  image: { width: '100%', height: '100%' },
});
