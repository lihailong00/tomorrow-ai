import { chineseDayLabel, readableDate } from '../src/domain/types';

describe('Chinese dates independent of device locale', () => {
  it('uses the account time zone when the local calendar date crosses midnight', () => {
    const instant = new Date('2026-10-25T18:30:00Z');
    expect(chineseDayLabel(instant, 'Asia/Shanghai')).toBe('10月26日 · 星期一');
    expect(chineseDayLabel(instant, 'America/Los_Angeles')).toBe(
      '10月25日 · 星期日',
    );
    expect(readableDate(instant.toISOString(), 'Asia/Shanghai')).toBe(
      '10月26日 02:30',
    );
  });
  it('preserves IANA daylight-saving offsets and a stable 24-hour display', () => {
    expect(readableDate('2026-03-08T09:30:00Z', 'America/Los_Angeles')).toBe(
      '3月8日 01:30',
    );
    expect(readableDate('2026-03-08T10:30:00Z', 'America/Los_Angeles')).toBe(
      '3月8日 03:30',
    );
    expect(readableDate('2026-10-25T16:00:00Z', 'Asia/Shanghai')).toBe(
      '10月26日 00:00',
    );
  });
  it('returns a safe display value for invalid dates or zones', () => {
    expect(readableDate('not-a-date', 'Asia/Shanghai')).toBe('not-a-date');
    expect(chineseDayLabel(new Date(), 'not-a-zone')).toBe('今天');
  });
});
