// The domain error codes the create handler emits are a public ABI (hub#139): the UI paints
// the TRANSLATION from `locales/*.json` (`errors` block), the English sentence is only the
// fallback. A code without its `en`+`es` entry is an untranslated refusal — exactly what
// reservations#31/#32 came to fix, so the contract is pinned here.
//
// The source of truth is the handler itself: the codes are scanned out of
// `handler/src/lib.rs` (`DomainError::new("reservations.<code>", …)`), so a new refusal can
// never ship without its strings — forgetting the catalog breaks this test, not the user.
//
// reservations#51: the handler is not the only emitter. A SQL command's `expect_rows.error` in
// `module.json` is raised by the runtime with the same shape, and `reservations.update_rejected`
// — the most frequent refusal of the reservation editor — shipped untranslated because this scan
// only read the handler. Both sources are scanned now.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const handlerSrc = readFileSync(join(ROOT, 'handler/src/lib.rs'), 'utf8');
const en = JSON.parse(readFileSync(join(ROOT, 'locales/en.json'), 'utf8'));
const es = JSON.parse(readFileSync(join(ROOT, 'locales/es.json'), 'utf8'));

const CODE = /DomainError::new\(\s*"([a-z_.]+)"/g;
const fromHandler = [...handlerSrc.matchAll(CODE)].map((m) => m[1]);

const manifest = JSON.parse(readFileSync(join(ROOT, 'module.json'), 'utf8')) as {
  commands: Record<string, { expect_rows?: { error?: string } }>;
};
const fromManifest = Object.values(manifest.commands)
  .map((c) => c.expect_rows?.error)
  .filter((code): code is string => typeof code === 'string');

const emitted = [...new Set([...fromHandler, ...fromManifest])];

describe('every domain refusal the handler can emit is translated, en and es', () => {
  it('finds the refusals in the handler source (guard: the scan is not bit-rotted)', () => {
    expect(fromHandler.length, 'no DomainError found — the scan pattern rotted').toBeGreaterThan(0);
    expect(fromManifest, 'no expect_rows error found in module.json — the scan rotted').toContain(
      'reservations.update_rejected',
    );
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
