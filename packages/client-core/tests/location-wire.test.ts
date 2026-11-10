import {describe, expect, it} from 'vitest';
import {ApiClient, type ChatIntent, type ClientTransport, type TransportRequest} from '../src/index';

describe('location request contract', () => {
  it('sends location/timezone through the real client serializer and replays exactly the same body', async () => {
    const calls: TransportRequest[] = [];
    const transport: ClientTransport = {request: async input => {
      calls.push(input);
      if (input.url.endsWith('/instance')) return {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify({id: 'location-wire', name: 'synthetic', deployment_mode: 'self_hosted', api_version: 1, auth_methods: ['phone_password'], registration_policy: 'closed', public_url: '', dataflow: {}})};
      input.onChunk?.('id: 1\nevent: done\ndata: {"response":{"conversation_id":"c","message":{"id":"a","conversation_id":"c","role":"assistant","content":"synthetic","created_at":""}}}\n\n');
      return {status: 200, headers: {'content-type': 'text/event-stream'}, body: ''};
    }};
    const api = new ApiClient('http://127.0.0.1:19569', {transport});
    const intent: ChatIntent = {message: '附近有什么餐厅', conversation_id: null, client_request_id: 'location-wire-one', remember: false, upload_ids: [],
      client_context: {timezone: 'Asia/Shanghai', location: {source: 'device', latitude: 31.2, longitude: 121.5, accuracy_m: 45, observed_at: '2026-11-04T00:00:00.000Z', coordinate_system: 'wgs84'}}};
    await api.chatStream(intent, () => {}, {});
    await api.chatStream(intent, () => {}, {retry: true, lastEventId: 1});
    const posts = calls.filter(call => call.method === 'POST');
    expect(posts).toHaveLength(2); expect(JSON.parse(posts[0].body!)).toEqual(intent); expect(posts[1].body).toBe(posts[0].body);
    expect(posts[1].headers['X-Chat-Retry']).toBe('1'); expect(posts[1].headers['Last-Event-ID']).toBe('1');
  });
});
