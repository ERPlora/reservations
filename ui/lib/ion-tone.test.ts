// ionTone: the inline custom properties that replace `color=` on an ion-* (ERPlora/pm#392).
import { describe, expect, it } from 'vitest';
import { ionTone } from './ion-tone';

describe('ionTone: the inline custom properties, read from the theme token', () => {
  it('a solid badge paints its background, its states and its text from the danger token', () => {
    const s = ionTone('solid', 'danger');
    expect(s).toContain('--background: var(--ion-color-danger, #c5000f)');
    expect(s).toContain('--background-activated: var(--ion-color-danger-shade, #ad000d)');
    expect(s).toContain('--background-focused: var(--ion-color-danger-shade, #ad000d)');
    expect(s).toContain('--background-hover: var(--ion-color-danger-tint, #cb1a27)');
    expect(s).toContain('--color: var(--ion-color-danger-contrast, #fff)');
  });
});
