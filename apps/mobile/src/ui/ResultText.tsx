import React from 'react';
import { View } from 'react-native';
import { Text } from './Text';
import { colors, styles as s } from './theme';

/** Safe native rendering: model output never becomes executable HTML or a WebView. */
export function ResultText({ content }: { content: string }) {
  let code = false;
  return (
    <View style={{ gap: 7 }}>
      {content.split('\n').map((line, index) => {
        if (
          line.startsWith('~~~') ||
          line.startsWith(String.fromCharCode(96).repeat(3))
        ) {
          code = !code;
          return null;
        }
        const heading = /^(#{1,4})\s+(.+)$/.exec(line);
        const plain = line
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/__(.+?)__/g, '$1');
        if (!line.trim()) {
          return <View key={index} style={{ height: 4 }} />;
        }
        return (
          <Text
            selectable
            key={index}
            style={[
              s.body,
              heading && {
                fontSize: heading[1].length < 3 ? 18 : 15,
                fontWeight: '600',
                color: colors.ink,
                marginTop: 12,
              },
              code && {
                fontFamily: 'monospace',
                fontSize: 12,
                backgroundColor: colors.cream,
                padding: 8,
              },
              /^[-*]\s/.test(line) && { paddingLeft: 7 },
            ]}
          >
            {heading ? heading[2] : plain.replace(/^[-*]\s/, '• ')}
          </Text>
        );
      })}
    </View>
  );
}
