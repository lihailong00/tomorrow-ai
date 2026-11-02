import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApp } from '../../app/context';
import { conversationPinStorage } from '../../platform/conversationPins';
import { conversationPinKey, createConversationPinStore } from './pins';

const store = createConversationPinStore(conversationPinStorage);

export function useConversationPins() {
  const { user, preferences } = useApp();
  const key = conversationPinKey(
    user?.id,
    preferences?.serverUrl,
    preferences?.instance?.id,
  );
  const owner = useMemo(() => store.owner(key), [key]);
  const snapshot = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    owner.getSnapshot,
  );
  useEffect(() => {
    void owner.load();
  }, [owner]);
  return {
    ...snapshot,
    key,
    owner,
    enabled: Boolean(key) && snapshot.ready && !snapshot.busy,
  };
}
