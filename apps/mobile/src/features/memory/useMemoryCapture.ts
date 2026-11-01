import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useApp } from '../../app/context';
import { errorMessage } from '../../api/client';
import { platform, type LocalFile } from '../../platform/ports';
import {
  recordingSession,
  releaseRecorder,
  stopRecorder,
} from '../../platform/recordingSession';

type Pending = {
  kind: 'voice' | 'image' | 'text';
  file: LocalFile;
  upload?: string;
  text?: string;
};
type Gesture = {
  lease: object;
  held: boolean;
  started: boolean;
  ended: boolean;
  cancelled: boolean;
  y?: number;
};

/** Captures input only. Saving a memory always requires a separate confirmation. */
export function useMemoryCapture(
  value: string,
  onText: (text: string) => void,
) {
  const { api } = useApp();
  const scope = useMemo(
    () => ({ active: true, gesture: null as Gesture | null }),
    [api],
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const content = useRef(value);
  content.current = value;
  const change = useRef(onText);
  change.current = onText;
  const request = useRef<{
    controller: AbortController;
    scope: typeof scope;
  } | null>(null);
  const pending = useRef<Pending | null>(null);
  const pendingOwner = useRef(scope);
  const selectionGeneration = useRef(0);
  const selectionLease = useRef<object | null>(null);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const current = () => scope.active && currentScope.current === scope;
  const removeUpload = (id?: string) => {
    if (id) void api.deleteUpload(id).catch(() => {});
  };
  const insert = (text: string) => {
    const cleaned = text.trim();
    if (!cleaned) throw new Error('没有识别到文字，请重试或直接输入。');
    const combined = [content.current.trim(), cleaned]
      .filter(Boolean)
      .join('\n');
    if (combined.length > 10000)
      throw new Error('记忆最多 10,000 字，请先缩短内容再重试。');
    change.current(combined);
  };
  const convert = async (input: Pending) => {
    if (!current() || request.current) return;
    const operation = { controller: new AbortController(), scope };
    request.current = operation;
    const valid = () => current() && request.current === operation;
    if (pending.current && pending.current !== input)
      removeUpload(pending.current.upload);
    pending.current = input;
    pendingOwner.current = scope;
    setError(null);
    try {
      let text: string;
      if (input.text !== undefined) {
        text = input.text;
      } else if (input.kind === 'text') {
        setPhase('正在读取文字…');
        text = await platform.readTextFile(input.file);
      } else {
        if (!input.upload) {
          setPhase(input.kind === 'voice' ? '正在识别语音…' : '正在整理照片…');
          const file =
            input.kind === 'image'
              ? await platform.prepareChatImage(input.file)
              : input.file;
          if (!valid()) return;
          const upload = await api.upload(file, operation.controller.signal);
          if (!valid()) {
            removeUpload(upload.id);
            return;
          }
          input.upload = upload.id;
        }
        setPhase(input.kind === 'voice' ? '正在转成文字…' : '正在理解图片…');
        const result =
          input.kind === 'voice'
            ? await api.transcribe(input.upload, operation.controller.signal)
            : await api.analyzeImage(input.upload, operation.controller.signal);
        text = result.text;
      }
      if (!valid()) return;
      input.text = text;
      insert(text);
      pending.current = null;
      removeUpload(input.upload);
    } catch (failure) {
      if (valid()) setError(errorMessage(failure));
    } finally {
      if (valid()) {
        request.current = null;
        setPhase('');
      }
    }
  };
  const cancel = () => {
    selectionGeneration.current++;
    const g = scope.gesture;
    if (g && !g.ended) {
      g.held = false;
      g.cancelled = true;
      if (g.started) void end(g);
    }
    const op = request.current;
    request.current = null;
    op?.controller.abort();
    removeUpload(pending.current?.upload);
    pending.current = null;
    if (current()) {
      setPhase('');
      setError(null);
    }
  };
  const end = async (gesture: Gesture) => {
    if (!gesture.started || gesture.ended) return;
    gesture.ended = true;
    gesture.held = false;
    try {
      const file = await stopRecorder(gesture.lease);
      releaseRecorder(gesture.lease);
      if (current()) {
        setRecording(false);
        setPhase('');
      }
      if (file && !gesture.cancelled && current())
        await convert({ kind: 'voice', file });
    } catch (failure) {
      if (current()) setError(errorMessage(failure));
    } finally {
      releaseRecorder(gesture.lease);
      if (current()) {
        setRecording(false);
        if (!request.current) setPhase('');
      }
    }
  };
  const begin = (y?: number) => {
    if (
      !current() ||
      recordingSession.active ||
      request.current ||
      phase ||
      (scope.gesture && !scope.gesture.ended)
    )
      return;
    const lease = {};
    recordingSession.active = lease;
    const gesture: Gesture = {
      lease,
      held: true,
      started: false,
      ended: false,
      cancelled: false,
      y,
    };
    scope.gesture = gesture;
    setCancelled(false);
    setError(null);
    setPhase('正在开启麦克风…');
    void (async () => {
      try {
        await platform.startRecording();
        gesture.started = true;
        if (!current()) gesture.cancelled = true;
        if (current()) {
          setRecording(true);
          setSeconds(0);
          setPhase('');
        }
        if (!gesture.held || gesture.cancelled) await end(gesture);
      } catch (failure) {
        gesture.ended = true;
        releaseRecorder(lease);
        if (current()) {
          setRecording(false);
          setPhase('');
          setError(errorMessage(failure));
        }
      }
    })();
  };
  const release = (forceCancel = false) => {
    const g = scope.gesture;
    if (!g || g.ended) return;
    g.held = false;
    g.cancelled ||= forceCancel || !g.started;
    if (g.started) void end(g);
  };
  const choose = async (kind: 'camera' | 'image' | 'file') => {
    if (
      !current() ||
      phase ||
      request.current ||
      recording ||
      selectionLease.current
    )
      return;
    const lease = {};
    selectionLease.current = lease;
    const generation = ++selectionGeneration.current;
    setError(null);
    setPhase('正在选择内容…');
    try {
      const file =
        kind === 'camera'
          ? await platform.capturePhoto()
          : kind === 'image'
          ? await platform.pickImage()
          : await platform.pickDocument();
      if (!current() || generation !== selectionGeneration.current || !file)
        return;
      const image =
        /^image\//i.test(file.mime_type) || /\.(png|jpe?g)$/i.test(file.name);
      if (!image && !/\.(txt|md|csv|tsv|json|log)$/i.test(file.name))
        throw new Error(
          '记忆支持图片和 UTF-8 文字文件；其他文档可先在对话中整理。',
        );
      await convert({ kind: image ? 'image' : 'text', file });
    } catch (failure) {
      if (current() && generation === selectionGeneration.current)
        setError(errorMessage(failure));
    } finally {
      if (selectionLease.current === lease) selectionLease.current = null;
      if (
        current() &&
        generation === selectionGeneration.current &&
        !request.current
      )
        setPhase('');
    }
  };
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      selectionGeneration.current++;
      const op = request.current;
      if (op?.scope === scope) {
        request.current = null;
        op.controller.abort();
      }
      if (pendingOwner.current === scope) {
        removeUpload(pending.current?.upload);
        pending.current = null;
      }
      const g = scope.gesture;
      if (g && !g.ended) {
        g.held = false;
        g.cancelled = true;
        if (g.started) void end(g);
      }
    };
    // Operations belong to the API instance which created them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  useEffect(() => {
    if (!recording) return;
    const clock = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(clock);
  }, [recording]);
  useEffect(() => {
    if (recording && seconds >= 115) release();
  });
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') release(true);
    });
    return () => listener.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);
  const retryInput = pending.current;
  return {
    phase,
    error,
    recording,
    cancelled,
    seconds,
    busy: recording || Boolean(phase),
    retry:
      retryInput && retryInput.text?.trim() !== '' && !phase && !recording
        ? () => {
            if (pending.current === retryInput) return convert(retryInput);
          }
        : undefined,
    cancel,
    choose,
    begin,
    release,
    move: (y: number) => {
      const g = scope.gesture;
      if (!g?.held || g.y === undefined) return;
      g.cancelled = g.y - y > 44;
      setCancelled(g.cancelled);
    },
    toggle: () => {
      if (scope.gesture?.started && !scope.gesture.ended) release();
      else begin();
    },
  };
}
