import { describe, expect, test } from 'bun:test';
import { getCreditUsage } from './src/lib/credit-usage';

describe('getCreditUsage', () => {
  test('calculates free-user signup usage', () => {
    expect(getCreditUsage({ totalCredits: 1, usedCredits: 0.25, remainingCredits: 0.75, paid: false })).toMatchObject({
      percentage: 25,
      remainingCredits: 0.75,
      paid: false,
    });
  });

  test('clamps zero totals and usage above total', () => {
    expect(getCreditUsage({ totalCredits: 0, usedCredits: 2, remainingCredits: 0, paid: false }).percentage).toBe(0);
    expect(getCreditUsage({ totalCredits: 1, usedCredits: 2, remainingCredits: 0, paid: true }).percentage).toBe(100);
  });

  test('preserves paid status and zero remaining balance', () => {
    expect(getCreditUsage({ totalCredits: 5, usedCredits: 5, remainingCredits: 0, paid: true })).toMatchObject({
      percentage: 100,
      remainingCredits: 0,
      paid: true,
    });
  });
});
