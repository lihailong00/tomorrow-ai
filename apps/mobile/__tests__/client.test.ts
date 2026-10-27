import { ApiClient, ApiError, normalizeServerUrl } from '../src/api/client';

const response = (data: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  } as Response);

describe('mobile API boundary', () => {
  it('allows a slow accepted SMS response beyond the general request deadline without retrying', async () => {
    jest.useFakeTimers();
    try {
      let signal!: AbortSignal;
      const fetcher = jest.fn((_url, init) => {
        signal = init.signal;
        return new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(response({ challenge_id: 'slow-challenge', expires_in: 300, retry_after: 60, test_mode: false })), 31000);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
        });
      });
      const api = new ApiClient('https://api.example.com', undefined, undefined, fetcher);
      const result = api.requestPhoneCode('13800138000', 'register');
      await jest.advanceTimersByTimeAsync(21000);
      expect(signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(10000);
      await expect(result).resolves.toMatchObject({ challenge_id: 'slow-challenge', test_mode: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });
  it('treats an expired SMS request as uncertain and enforces a wait without retrying', async () => {
    jest.useFakeTimers();
    try {
      const fetcher = jest.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      const api = new ApiClient('https://api.example.com', undefined, undefined, fetcher);
      const result = api.requestPhoneCode('13800138000', 'register').catch(error => error);
      await jest.advanceTimersByTimeAsync(45000);
      expect(await result).toMatchObject({ code: 'sms_send_uncertain', retryAfterSeconds: 60 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });
  it('does not claim an SMS failed when the network loses the result', async () => {
    const fetcher = jest.fn().mockRejectedValue(new TypeError('network lost'));
    const api = new ApiClient('https://api.example.com', undefined, undefined, fetcher);
    await expect(api.requestPhoneCode('13800138000', 'register')).rejects.toMatchObject({
      code: 'sms_send_uncertain', retryAfterSeconds: 60,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses password login and sends passwords exactly as entered for register and reset', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({ ok: true }));
    const api = new ApiClient(
      'https://api.example.com',
      undefined,
      undefined,
      fetcher,
    );
    const password = '  meaningful spaces  ';
    await api.loginWithPhone('008613800138000', password);
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://api.example.com/v1/auth/phone/login',
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      phone: '+8613800138000',
      password,
    });
    await api.registerWithPhone(
      '13800138000',
      '123456',
      'registration-code',
      password,
      ' 名字 ',
    );
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      phone: '+8613800138000',
      code: '123456',
      challenge_id: 'registration-code',
      password,
      name: '名字',
      timezone: 'Asia/Shanghai',
    });
    await api.requestPhoneCode('13800138000', 'reset_password');
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
      phone: '+8613800138000',
      purpose: 'reset_password',
    });
    await api.resetPhonePassword(
      '13800138000',
      '654321',
      'reset-code',
      password,
    );
    expect(fetcher.mock.calls[3][0]).toBe(
      'https://api.example.com/v1/auth/phone/password/reset',
    );
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({
      phone: '+8613800138000',
      code: '654321',
      challenge_id: 'reset-code',
      new_password: password,
    });
  });

  it('rejects invalid password lengths before making a phone-auth request', () => {
    const fetcher = jest.fn();
    const api = new ApiClient(
      'https://api.example.com',
      undefined,
      undefined,
      fetcher,
    );
    expect(() => api.loginWithPhone('13800138000', 'short')).toThrow('8–128');
    expect(() =>
      api.registerWithPhone('13800138000', '123456', 'c', 'x'.repeat(129), ''),
    ).toThrow('8–128');
    expect(() =>
      api.resetPhonePassword('13800138000', '123456', 'c', 'short'),
    ).toThrow('8–128');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'preserves Retry-After and a readable rate-limit error (JSON=%s)',
    async json => {
      const fetcher = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => '37' },
        text: async () =>
          json
            ? JSON.stringify({
                error: { code: 'rate_limited', message: '请稍后重试' },
              })
            : '<html>Too many requests</html>',
      });
      const api = new ApiClient(
        'https://api.example.com',
        undefined,
        undefined,
        fetcher,
      );
      await expect(
        api.requestPhoneCode('13800138000', 'register'),
      ).rejects.toMatchObject({
        code: 'rate_limited',
        status: 429,
        retryAfterSeconds: 37,
        message: json ? '请稍后重试' : '操作过于频繁，请稍后重试。',
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['-3', 'Infinity', '2026-10-27', '1.5'])(
    'ignores an invalid retry duration %s',
    async header => {
      const fetcher = jest.fn().mockResolvedValue({
        ...response(
          { error: { code: 'rate_limited', message: '请稍后重试' } },
          429,
        ),
        headers: { get: () => header },
      });
      const api = new ApiClient(
        'https://api.example.com',
        undefined,
        undefined,
        fetcher,
      );
      await expect(api.health()).rejects.toMatchObject({
        retryAfterSeconds: undefined,
      });
    },
  );

  it('deletes the selected upload through its authenticated resource path', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({ ok: true }));
    const api = new ApiClient(
      'https://api.example.com',
      'token',
      undefined,
      fetcher,
    );
    await api.deleteUpload('upload/one');
    expect(fetcher.mock.calls[0][0]).toBe(
      'https://api.example.com/v1/uploads/upload%2Fone',
    );
    expect(fetcher.mock.calls[0][1].method).toBe('DELETE');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer token');
  });
  it('normalizes a user-entered base URL and rejects credentials or non-http schemes', () => {
    expect(normalizeServerUrl(' http://10.0.2.2:8080/v1/ ')).toBe(
      'http://10.0.2.2:8080',
    );
    expect(normalizeServerUrl('https://assistant.example.com/')).toBe(
      'https://assistant.example.com',
    );
    for (const url of [
      'file:///secret',
      'javascript:alert(1)',
      'https://name:secret@example.com',
      'https://example.com?token=secret',
      'invalid host',
    ]) {
      expect(() => normalizeServerUrl(url)).toThrow();
    }
  });

  it('sends versioned authenticated JSON and preserves the task idempotency key on retry', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({ id: 'task-1' }));
    const api = new ApiClient(
      'https://api.example.com',
      'session-secret',
      undefined,
      fetcher,
    );
    await api.createTask('整理计划', true, 'one-user-action');
    await api.createTask('整理计划', true, 'one-user-action');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/tasks');
    expect(options.headers.Authorization).toBe('Bearer session-secret');
    expect(JSON.parse(options.body)).toEqual({
      instruction: '整理计划',
      approval_required: true,
      client_request_id: 'one-user-action',
    });
    expect(fetcher.mock.calls[1][1].body).toBe(options.body);
  });

  it('expires the signed-in session on 401 and keeps the actionable server error', async () => {
    const expired = jest.fn();
    const fetcher = jest
      .fn()
      .mockResolvedValue(
        response(
          { error: { code: 'session_expired', message: '请重新登录' } },
          401,
        ),
      );
    const api = new ApiClient(
      'https://api.example.com',
      'expired-token',
      expired,
      fetcher,
    );
    await expect(api.today()).rejects.toMatchObject({
      status: 401,
      code: 'session_expired',
      message: '请重新登录',
    });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate a session for a stale memory edit', async () => {
    const expired = jest.fn();
    const fetcher = jest.fn().mockResolvedValue(
      response(
        {
          error: {
            code: 'version_conflict',
            message: '记忆已被更新，请刷新',
          },
        },
        409,
      ),
    );
    const api = new ApiClient(
      'https://api.example.com',
      'token',
      expired,
      fetcher,
    );
    await expect(
      api.saveMemory(
        { content: '新版偏好', kind: 'preference', version: 1 },
        'memory-1',
      ),
    ).rejects.toMatchObject({ code: 'version_conflict', status: 409 });
    expect(expired).not.toHaveBeenCalled();
  });

  it('keeps network failures and invalid server responses understandable', async () => {
    const offline = new ApiClient(
      'http://10.0.2.2:8080',
      undefined,
      undefined,
      jest.fn().mockRejectedValue(new TypeError('Network request failed')),
    );
    await expect(offline.health()).rejects.toMatchObject({ code: 'network' });
    const malformed = new ApiClient(
      'http://10.0.2.2:8080',
      undefined,
      undefined,
      jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '<html>',
      }),
    );
    await expect(malformed.today()).rejects.toBeInstanceOf(ApiError);
  });

  it('does not override the multipart boundary when uploading a real native file', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({ id: 'upload-1' }));
    const api = new ApiClient(
      'https://api.example.com',
      'token',
      undefined,
      fetcher,
    );
    await api.upload({
      uri: 'file:///cache/note.txt',
      name: 'note.txt',
      mime_type: 'text/plain',
      size: 20,
    });
    const [, options] = fetcher.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer token');
    expect(options.headers['Content-Type']).toBeUndefined();
    expect(options.body).toBeInstanceOf(FormData);
  });

  it('passes only the explicitly selected upload ids to a chat request', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue(response({ conversation_id: 'c1', message: {} }));
    const api = new ApiClient(
      'https://api.example.com',
      'token',
      undefined,
      fetcher,
    );
    await api.chat('总结附件', 'c1', 'request-1', ['own-upload']);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      message: '总结附件',
      conversation_id: 'c1',
      client_request_id: 'request-1',
      remember: false,
      upload_ids: ['own-upload'],
    });
  });
});
