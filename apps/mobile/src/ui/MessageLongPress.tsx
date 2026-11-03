import { createContext, useContext } from 'react';
import type { GestureResponderEvent } from 'react-native';

/** Chat text opens the message menu first; other readers keep native selection. */
export const MessageLongPress = createContext<((event?: GestureResponderEvent) => void) | undefined>(undefined);
export const useMessageLongPress = () => useContext(MessageLongPress);
