import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../../ui/Text';
import { Icon } from '../../ui/visuals';
import type { HubEntry } from './model';

export function CapabilityLogo({ entry }: { entry: HubEntry }) {
  if (entry.kind === 'phone' || entry.kind === 'notifications') {
    const phone = entry.kind === 'phone';
    return (
      <View style={[styles.tile, phone ? styles.phone : styles.notifications]}>
        <Icon name={phone ? 'phone' : 'bell'} size={20} color={phone ? '#4266B8' : '#9B641E'} />
      </View>
    );
  }
  const initials = Array.from(entry.name.trim()).slice(0, 2).join('').toUpperCase();
  return (
    <View style={[styles.tile, styles.fallback]}>
      <Text style={styles.initials}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: 39,
    height: 39,
    borderRadius: 12,
    backgroundColor: '#FAFBFE',
    borderColor: '#EAEDF4',
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    alignItems: 'center',
  },
  phone: { backgroundColor: '#EBF1FE', borderColor: '#E3EBFB' },
  notifications: { backgroundColor: '#FFF3E4', borderColor: '#FAEBD8' },
  fallback: { backgroundColor: '#F0F2FA', borderColor: '#E8EBF6' },
  initials: { fontSize: 12, fontWeight: '700', color: '#515D83' },
});
