// Research execution is bounded to twenty minutes on the server. Allow its
// terminal event and return path to arrive before rotating the native reader.
// This is a total connection deadline, not an idle/read timeout.
export const CHAT_REQUEST_TIMEOUT_MS = 1_290_000;
