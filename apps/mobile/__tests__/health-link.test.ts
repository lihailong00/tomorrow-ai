import { healthReceiptFromLink } from '../src/domain/healthLink';

const receipt = 'a'.repeat(43);
const makeLink = (server = 'https://own.test') =>
  `tada://health/complete?provider=huawei&receipt=${receipt}&server=${encodeURIComponent(server)}`;

it('health links only prefill the chosen server and return no server override', () => {
  expect(healthReceiptFromLink(makeLink(), 'https://own.test/')).toEqual({ provider: 'huawei', receipt });
  expect(healthReceiptFromLink('tada://connect?url=other', 'https://own.test')).toBeNull();
});

it.each([
  makeLink('https://other.test'), makeLink('https://own.test.evil.test'),
  makeLink('https://own.test@evil.test'), makeLink('https://own.test/path'),
  makeLink() + '&receipt=' + receipt, makeLink() + '&unknown=1', makeLink() + '#fragment',
  makeLink().replace('provider=huawei', 'provider=other'), makeLink().replace(receipt, 'short'),
  makeLink().replace('server=', 'server=%GG'), makeLink().replace('provider=huawei', 'provider=__proto__'),
])('rejects foreign, ambiguous or malformed health receipt link %s', link => {
  expect(() => healthReceiptFromLink(link, 'https://own.test')).toThrow();
});
