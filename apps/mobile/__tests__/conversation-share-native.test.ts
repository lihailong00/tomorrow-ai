import { NativeModules } from 'react-native';
import { conversationShare, readPreparedConversationImage, type ConversationShareDocument } from '../src/platform/conversationShare';

const id = '4d8c3b7a-1c9e-4e31-97a8-c361c6dfdf98';
const image = { id, uri: `content://com.tomorrowai.attachments/conversation_share/${id}.png`, width: 900, height: 1500, size: 120000 };
const document: ConversationShareDocument = { title: '对话分享', messages: [{ role: 'assistant', blocks: [{ type: 'text', text: '这是选中的回答' }] }] };
beforeEach(async () => {
  NativeModules.TadaConversationShare = { prepare: jest.fn().mockResolvedValue(image), cancel: jest.fn().mockResolvedValue(undefined),
    cancelAll: jest.fn().mockResolvedValue(undefined), save: jest.fn().mockResolvedValue(undefined), share: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined) };
  await conversationShare.cancelAll(); jest.clearAllMocks();
});
afterEach(async () => { await conversationShare.cancelAll(); delete NativeModules.TadaConversationShare; });

test('native-only adapter reports unsupported without fabricating image or saving', async () => {
  delete NativeModules.TadaConversationShare;
  expect(conversationShare.available).toBe(false);
  await expect(conversationShare.prepare(document)).rejects.toMatchObject({ code: 'unsupported' });
});
test('local request contains only supplied selected document and returned opaque id controls actions', async () => {
  expect(await conversationShare.prepare(document)).toEqual(image);
  expect(NativeModules.TadaConversationShare.prepare).toHaveBeenCalledWith(expect.stringMatching(/^share-\d+-\d+$/), JSON.stringify(document));
  await conversationShare.save(id); await conversationShare.share(id);
  expect(NativeModules.TadaConversationShare.save).toHaveBeenCalledWith(id);
  expect(NativeModules.TadaConversationShare.share).toHaveBeenCalledWith(id);
  await conversationShare.release(id);
  await expect(conversationShare.share(id)).rejects.toMatchObject({ code: 'expired' });
});
test.each([undefined, null])('malformed empty response %s rejects instead of leaving generation pending', async raw => {
  NativeModules.TadaConversationShare.prepare.mockResolvedValueOnce(raw);
  await expect(conversationShare.prepare(document)).rejects.toMatchObject({ code: 'unavailable' });
});
test.each([{ uri: 'file:///data/private.png' }, { uri: 'https://server.test/private' }, { uri: 'content://other.app.attachments/conversation_share/'+id+'.png' },
  { id: '../../private' }, { width: 1 }, { height: 12001 }, { size: 8 * 1024 * 1024 + 1 }])('rejects unsafe or unbounded native results %o', changes => {
  expect(() => readPreparedConversationImage({ ...image, ...changes })).toThrow();
});
test('abort before start does not dispatch and abort after start cancels exact request and releases late image', async () => {
  const already = new AbortController(); already.abort();
  await expect(conversationShare.prepare(document, already.signal)).rejects.toMatchObject({ code: 'cancelled' });
  expect(NativeModules.TadaConversationShare.prepare).not.toHaveBeenCalled();
  let resolve!: (value: typeof image) => void;
  NativeModules.TadaConversationShare.prepare.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const controller = new AbortController();
  const result = conversationShare.prepare(document, controller.signal).catch(error => error);
  await Promise.resolve();
  const request = NativeModules.TadaConversationShare.prepare.mock.calls[0][0];
  controller.abort(); expect(await result).toMatchObject({ code: 'cancelled' });
  expect(NativeModules.TadaConversationShare.cancel).toHaveBeenCalledWith(request);
  resolve(image); await new Promise<void>(done => setImmediate(done));
  expect(NativeModules.TadaConversationShare.release).toHaveBeenCalledWith(id);
});
test('owner cancellation invalidates already prepared ids and in-flight results without sharing', async () => {
  await conversationShare.prepare(document);
  await conversationShare.cancelAll();
  await expect(conversationShare.save(id)).rejects.toMatchObject({ code: 'expired' });
  expect(NativeModules.TadaConversationShare.save).not.toHaveBeenCalled();
  expect(NativeModules.TadaConversationShare.share).not.toHaveBeenCalled();
});
test('global owner invalidation rejects an in-flight preparation and discards its late image', async () => {
  let resolve!: (value: typeof image) => void;
  NativeModules.TadaConversationShare.prepare.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const result = conversationShare.prepare(document).catch(error => error);
  await Promise.resolve(); await conversationShare.cancelAll();
  expect(await result).toMatchObject({ code: 'cancelled' });
  resolve(image); await new Promise<void>(done => setImmediate(done));
  expect(NativeModules.TadaConversationShare.release).toHaveBeenCalledWith(id);
  await expect(conversationShare.share(id)).rejects.toMatchObject({ code: 'expired' });
});
test('invalid returned preview URI releases only a syntactically valid opaque artifact id', async () => {
  NativeModules.TadaConversationShare.prepare.mockResolvedValueOnce({ ...image, uri: 'file:///private.png' });
  await expect(conversationShare.prepare(document)).rejects.toMatchObject({ code: 'unavailable' });
  expect(NativeModules.TadaConversationShare.release).toHaveBeenCalledWith(id);
  NativeModules.TadaConversationShare.release.mockClear();
  NativeModules.TadaConversationShare.prepare.mockResolvedValueOnce({ ...image, id: '../../private' });
  await expect(conversationShare.prepare(document)).rejects.toMatchObject({ code: 'unavailable' });
  expect(NativeModules.TadaConversationShare.release).not.toHaveBeenCalled();
});
test('save returns generic mapped native errors without exposing provider diagnostics', async () => {
  await conversationShare.prepare(document);
  NativeModules.TadaConversationShare.save.mockRejectedValueOnce({ code: 'E_SHARE_FOREGROUND', message: 'private diagnostic fixture' });
  const failure = await conversationShare.save(id).catch(error => error);
  expect(failure).toMatchObject({ code: 'foreground' }); expect(failure.message).not.toContain('private diagnostic');
});
