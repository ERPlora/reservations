// The domain error codes the create handler emits are a public ABI (hub#139): the UI paints
// the TRANSLATION from `locales/*.json` (`errors` block), the English sentence is only the
// fallback. A code without its `en`+`es` entry is an untranslated refusal — exactly what
// reservations#31/#32 came to fix, so the contract is pinned here.
//
// The source of truth is the handler itself: the codes are scanned out of
// `handler/src/lib.rs` (`DomainError::new("reservations.<code>", …)`), so a new refusal can
// never ship without its strings — forgetting the catalog breaks this test, not the user.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const handlerSrc = readFileSync(join(ROOT, 'handler/src/lib.rs'), 'utf8');
const en = JSON.parse(readFileSync(join(ROOT, 'locales/en.json'), 'utf8'));
const es = JSON.parse(readFileSync(join(ROOT, 'locales/es.json'), 'utf8'));

const CODE = /DomainError::new\(\s*"([a-z_.]+)"/g;
const emitted = [...handlerSrc.matchAll(CODE)].map((m) => m[1]);

describe('every domain refusal the handler can emit is translated, en and es', () => {
  it('finds the refusals in the handler source (guard: the scan is not bit-rotted)', () => {
    expect(emitted.length, 'no DomainError found — the scan pattern rotted').toBeGreaterThan(0);
    expect(emitted).toContain('reservations.no_capacity');
    expect(emitted).toContain('reservations.phone_required');
  });

  it.each(emitted)('%s has an en + es entry', (code) => {
    expect(en.errors?.[code], `missing en entry for ${code}`).toBeTruthy();
    expect(es.errors?.[code], `missing es entry for ${code}`).toBeTruthy();
  });

  it('every code is namespaced to this module (the host refuses foreign namespaces)', () => {
    for (const code of emitted) {
      expect(code.startsWith('reservations.'), `${code} is not in the reservations namespace`).toBe(true);
    }
  });
});
