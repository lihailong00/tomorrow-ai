import { platform, type LocalFile } from './ports';

/** Microphone ownership spans screens and pending native permission dialogs. */
export const recordingSession = { active: null as object | null };
const stops = new WeakMap<object, Promise<LocalFile | null>>();

export function stopRecorder(lease: object | null): Promise<LocalFile | null> {
  if (!lease) return platform.stopRecording();
  let pending = stops.get(lease);
  if (!pending) {
    pending = platform.stopRecording().catch(failure => {
      stops.delete(lease);
      throw failure;
    });
    stops.set(lease, pending);
  }
  return pending;
}

export function releaseRecorder(lease: object | null) {
  if (lease && recordingSession.active === lease)
    recordingSession.active = null;
}
