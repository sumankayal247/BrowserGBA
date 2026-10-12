/**
 * Portability guard: BrowserGBA targets Chromium *and* Firefox.
 *
 * The repository has no Firefox binary in the environment where it is built, so the
 * Firefox claim cannot rest on a browser run. What can be checked mechanically is the
 * thing that would actually break Firefox: reaching for an API that only Chromium
 * implements, or a CSS feature that is too new for Firefox's ESR baseline. This test
 * scans the source (and the stylesheet) and fails when one of those appears, so the
 * "works in both engines" promise cannot rot silently between browser runs.
 *
 * Both lists are deliberately short and specific: these are APIs whose absence
 * removes a *feature*, not merely a nicety, and which have a portable equivalent we
 * are supposed to use instead (a plain `<a download>`, a plain `<input type=file>`,
 * a click handler, engine-neutral feature detection).
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(repoRoot, 'src');

/** APIs Chromium implements and Firefox does not, with what to use instead. */
const CHROMIUM_ONLY: Array<[RegExp, string]> = [
  [/showOpenFilePicker/, 'a plain <input type="file">'],
  [/showSaveFilePicker/, 'an <a download> link'],
  [/showDirectoryPicker/, 'a plain directory input'],
  [/navigator\.userAgentData/, 'feature detection, or navigator.userAgent for a label only'],
  [/window\.chrome|globalThis\.chrome\b/, 'feature detection'],
  [/beforeinstallprompt/, 'the manifest alone'],
  [/startViewTransition/, 'a plain re-render'],
  [/webkitSpeechRecognition/, 'nothing — the app has no speech feature'],
  [/scheduler\.postTask|scheduler\.yield/, 'setTimeout / requestIdleCallback'],
];

/** CSS constructs newer than the Firefox ESR baseline the app claims. */
const TOO_NEW_CSS: Array<[RegExp, string]> = [[/:has\(/, 'a plain descendant or sibling selector']];

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, out);
    else if (/\.(ts|js|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('browser portability', () => {
  it('never reaches for an API only Chromium implements', async () => {
    const files = await sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(20);

    const offences: string[] = [];
    for (const file of files) {
      const code = await readFile(file, 'utf8');
      for (const [pattern, alternative] of CHROMIUM_ONLY) {
        if (pattern.test(code)) {
          offences.push(`${path.relative(repoRoot, file)}: ${pattern.source} — use ${alternative}`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it('keeps the stylesheet inside the Firefox baseline', async () => {
    const css = await readFile(path.join(SRC, 'styles.css'), 'utf8');
    const offences = TOO_NEW_CSS.filter(([pattern]) => pattern.test(css)).map(
      ([pattern, alternative]) => `${pattern.source} — use ${alternative}`,
    );
    expect(offences).toEqual([]);
  });

  it('keeps a Chromium-prefixed rule paired with a portable one', async () => {
    const css = await readFile(path.join(SRC, 'styles.css'), 'utf8');
    // `::-webkit-scrollbar` is fine as an extra, but the standard property has to be
    // there too or Firefox gets a visible scrollbar the design did not plan for.
    if (css.includes('::-webkit-scrollbar')) {
      expect(css).toMatch(/scrollbar-width:\s*none/);
    }
    expect(css).not.toMatch(/-moz-only-something/);
  });
});
