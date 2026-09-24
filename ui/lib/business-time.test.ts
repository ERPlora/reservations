// reservations#45 — the day the book opens on is the RESTAURANT's day, never the device's.
//
// The zone comes from the core (`erplora.timezone`, hub#731/hub#1022), the same single authority
// `appointments` reads (appointments#12). Every test runs with the DEVICE in `Pacific/Auckland`
// (UTC+12) while the restaurant is in `Europe/Madrid`: an answer taken from the device clock is
// off by 10-11 hours and cannot pass by accident.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDaysISO, businessTimezone, nowWallTime, todayISO } from './business-time';

const MADRID = 'Europe/Madrid';
const previousTZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = 'Pacific/Auckland';
});
afterAll(() => {
  process.env.TZ = previousTZ;
  delete (globalThis as Record<string, unknown>).erplora;
});

describe('businessTimezone', () => {
  it('reads the zone the core publishes', () => {
    (globalThis as Record<string, unknown>).erplora = { timezone: MADRID };
    expect(businessTimezone()).toBe(MADRID);
  });

  it('degrades to UTC, never to the device, when the core says nothing', () => {
    (globalThis as Record<string, unknown>).erplora = {};
    expect(businessTimezone()).toBe('UTC');
  });
});

describe('todayISO', () => {
  it('at 00:30 in Madrid it is already the new day (UTC is still on the previous one)', () => {
    expect(todayISO(MADRID, new Date('2026-09-24T22:30:00Z'))).toBe('2026-09-25');
  });

  it('at 23:30 in Madrid it is still the old day (the device in Auckland ticked over)', () => {
    expect(todayISO(MADRID, new Date('2026-09-25T21:30:00Z'))).toBe('2026-09-25');
  });
});

describe('nowWallTime', () => {
  it('is the restaurant wall clock as HH:MM:SS — the shape `start_time`/`end_time` are stored in', () => {
    expect(nowWallTime(MADRID, new Date('2026-09-25T18:05:09Z'))).toBe('20:05:09');
  });

  it('midnight reads 00, not 24', () => {
    expect(nowWallTime(MADRID, new Date('2026-09-24T22:00:00Z'))).toBe('00:00:00');
  });
});

describe('addDaysISO', () => {
  it('steps by CALENDAR day, also across the autumn clock change (a 25-hour day)', () => {
    expect(addDaysISO('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDaysISO('2026-10-26', -1)).toBe('2026-10-25');
  });

  it('crosses month and year boundaries', () => {
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('leaves a day it cannot read untouched instead of inventing one', () => {
    expect(addDaysISO('', 1)).toBe('');
    expect(addDaysISO('25/09/2026', 1)).toBe('25/09/2026');
  });
});
