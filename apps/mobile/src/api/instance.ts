import { instanceServerUrl, readInstanceManifest, InstanceManifest } from '../domain/instance';

type InspectInstanceOptions = {
  allowInsecureLan?: boolean; expectedId?: string; signal?: AbortSignal;
  fetcher?: typeof fetch;
};

/**
 * Only concurrent requests may share an anonymous check. A completed check must
 * never authorize later traffic: the server at the same address can be replaced.
 * The public instance ID detects routine replacement; it is not an attestation.
 */
export function createInstanceIdentityGuard(input: string, options: Omit<InspectInstanceOptions, 'signal'> = {}) {
  let generation = 0;
  let disposed = false;
  let inFlight: { controller: AbortController; promise: Promise<void> } | undefined;
  const invalidate = () => {
    generation += 1;
    inFlight?.controller.abort();
    inFlight = undefined;
  };
  return {
    verify(): Promise<void> {
      if (disposed) return Promise.reject(new Error('服务器连接已变化，请重新操作。'));
      if (!inFlight) {
        const checkedGeneration = generation;
        const controller = new AbortController();
        const check = {
          controller,
          promise: Promise.resolve(),
        };
        check.promise = inspectInstance(input, { ...options, signal: controller.signal })
          .then(() => {
            // Native fetch may finish even after cancellation. Such a result
            // cannot release a request queued before a foreground transition.
            if (disposed || checkedGeneration !== generation) {
              throw new Error('服务器连接已变化，请重新操作。');
            }
          })
          .finally(() => {
            if (inFlight === check) inFlight = undefined;
          });
        inFlight = check;
      }
      return inFlight.promise;
    },
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
  };
}

/** Anonymous handshake, before an account password/token is sent to a server. */
export async function inspectInstance(input: string, options: InspectInstanceOptions = {}): Promise<{ serverUrl: string; instance: InstanceManifest }> {
  const serverUrl = instanceServerUrl(input, options.allowInsecureLan);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel);
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(cancel, 12000);
  try {
    const response = await (options.fetcher ?? fetch)(`${serverUrl}/v1/instance`, {
      // React Native's fetch polyfill rewrites GET URLs for cache:'no-store'.
      // Headers request freshness without changing the identity endpoint URL.
      method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
      credentials: 'omit', redirect: 'error', signal: controller.signal,
    } as RequestInit & { redirect: 'error' });
    // Some native fetch implementations follow redirects despite the option.
    // Never accept the redirected result as the requested server identity.
    if (response.redirected || (response.url && response.url !== `${serverUrl}/v1/instance`)) {
      throw new Error('服务器身份接口发生跳转，请直接填写最终 HTTPS 地址。');
    }
    if (!response.ok) throw new Error('服务器尚未就绪或版本不兼容，请检查后台初始化状态。');
    const text = await response.text();
    if (text.length > 16000) throw new Error('服务器身份信息过大。');
    const instance = readInstanceManifest(JSON.parse(text));
    if (options.expectedId && instance.id !== options.expectedId) {
      throw new Error('服务器身份已变化。请重新检查并确认连接，原账号信息不会自动发送。');
    }
    return { serverUrl, instance };
  } catch (error) {
    if ((error as Error).name === 'TypeError' || (error as Error).name === 'AbortError') {
      throw new Error('暂时无法验证这台服务器。请检查网络和地址；不会切换到其他服务器。');
    }
    if (error instanceof SyntaxError) throw new Error('服务器没有返回兼容的身份信息。');
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}
