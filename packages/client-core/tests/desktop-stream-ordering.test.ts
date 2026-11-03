import {afterEach, describe, expect, it, vi} from 'vitest';
import {createDesktopTransport, type DesktopBridge, type DesktopStreamEvent} from '../src/index';

const headers: DesktopStreamEvent = {type: 'headers', status: 200, headers: {'Content-Type': 'text/event-stream'}};
const request = {url: 'https://example.com/v1/chat/stream', method: 'POST', headers: {}};
function fixture(start?: (emit: (event: DesktopStreamEvent) => void) => Promise<void> | void) {
  let emit!: (event: DesktopStreamEvent) => void;
  const commands: string[] = [];
  const bridge: DesktopBridge = {
    createChannel(handler) {emit = handler; return {};},
    async invoke<T>(command: string) {
      commands.push(command);
      if (command === 'desktop_stream') await start?.(event => emit(event));
      return undefined as T;
    },
  };
  return {transport: createDesktopTransport(bridge), commands, emit: (event: DesktopStreamEvent) => emit(event)};
}
const observe = <T>(promise: Promise<T>) => promise.then(value => ({value, error: undefined}), error => ({value: undefined, error}));
afterEach(() => vi.useRealTimers());

describe('native command and channel completion ordering', () => {
  it('waits for a delayed end notification after receiving the complete reply', async () => {
    const received: string[] = [];
    const f = fixture(emit => {
      emit(headers);
      emit({type: 'chunk', bytes: [...new TextEncoder().encode('id: 1\nevent: done\ndata: {}\n\n')]});
    });
    const pending = observe(f.transport.request({...request, onChunk: text => received.push(text)}));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    f.emit({type: 'end'});
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.value?.status).toBe(200);
    expect(received.join('')).toContain('event: done');
  });

  it('accepts headers and split UTF-8 data delivered after the command resolves', async () => {
    const received: string[] = []; const f = fixture();
    const pending = observe(f.transport.request({...request, onChunk: text => received.push(text)}));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    f.emit(headers);
    const bytes = new TextEncoder().encode('已经完成🙂');
    f.emit({type: 'chunk', bytes: [...bytes.slice(0, 2)]});
    f.emit({type: 'chunk', bytes: [...bytes.slice(2)]});
    f.emit({type: 'end'});
    expect((await pending).error).toBeUndefined();
    expect(received.join('')).toBe('已经完成🙂');
  });

  it('still waits for the command when the channel finishes first', async () => {
    let finishCommand!: () => void;
    const f = fixture(emit => {emit(headers); emit({type: 'end'}); return new Promise(resolve => {finishCommand = resolve;});});
    let settled = false;
    const pending = observe(f.transport.request({...request, onChunk: () => {}})).then(result => {settled = true; return result;});
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    finishCommand();
    expect((await pending).value?.status).toBe(200);
  });

  it('bounds the wait when a successful command never delivers channel end', async () => {
    vi.useFakeTimers();
    const f = fixture(emit => emit(headers));
    const pending = observe(f.transport.request({...request, onChunk: () => {}}));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).error).toMatchObject({code: 'network'});
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows cancellation while draining and ignores late data', async () => {
    vi.useFakeTimers();
    const f = fixture(emit => emit(headers)); const controller = new AbortController(); const received = vi.fn();
    const pending = observe(f.transport.request({...request, signal: controller.signal, onChunk: received}));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await pending).error).toMatchObject({code: 'cancelled'});
    f.emit({type: 'chunk', bytes: [...new TextEncoder().encode('late')]}); f.emit({type: 'end'});
    expect(received).not.toHaveBeenCalled();
    expect(f.commands).toEqual(['desktop_stream', 'desktop_cancel']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not hide a native command failure or wait for an end that cannot arrive', async () => {
    const f = fixture(emit => {emit(headers); throw new Error('native request failed');});
    const result = await observe(f.transport.request({...request, onChunk: () => {}}));
    expect(result.error).toMatchObject({message: 'native request failed'});
  });

  it('rejects malformed delayed channel data promptly and clears the drain timer', async () => {
    vi.useFakeTimers(); const f = fixture();
    const pending = observe(f.transport.request({...request, onChunk: () => {}}));
    await vi.advanceTimersByTimeAsync(0);
    f.emit({type: 'chunk', bytes: [65]});
    expect((await pending).error).toMatchObject({code: 'invalid_response'});
    expect(f.commands).toContain('desktop_cancel');
    expect(vi.getTimerCount()).toBe(0);
  });
});
