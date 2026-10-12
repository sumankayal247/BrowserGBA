/**
 * The links feature has one job: let a user keep any address they like next to a
 * game without the app second-guessing them. These tests pin that down — including
 * the cases a "helpful" validator would normally reject — and pin the one rule that
 * does exist, which is that a pasted URL must never be able to execute code.
 */
import { describe, expect, it } from 'vitest';
import {
  isNavigableUrl,
  linkDisplayLabel,
  linkHost,
  linkScheme,
  makeLink,
  MAX_LINK_LABEL_LENGTH,
  MAX_LINKS_PER_GAME,
  MAX_LINK_URL_LENGTH,
  normalizeLinkUrl,
  normalizeLinks,
  type GameLink,
} from '@/library/links';

describe('link parsing', () => {
  it('reads the scheme without caring about case', () => {
    expect(linkScheme('HTTPS://Example.com')).toBe('https');
    expect(linkScheme('steam://run/123')).toBe('steam');
    expect(linkScheme('example.com')).toBe('');
    expect(linkScheme('/relative/path')).toBe('');
  });

  it('treats a bare domain as a web address', () => {
    expect(normalizeLinkUrl('example.com/page')).toBe('https://example.com/page');
  });

  it('leaves anything that already has a scheme exactly as typed', () => {
    // The point of the feature: unknown schemes are not "wrong".
    for (const url of [
      'http://plain-http.example',
      'https://example.com/a?b=c#d',
      'steam://run/12345',
      'ipfs://bafybeigdyrzt',
      'magnet:?xt=urn:btih:abcdef',
      'mailto:someone@example.com',
      'obsidian://open?vault=notes',
    ]) {
      expect(normalizeLinkUrl(url)).toBe(url);
    }
  });

  it('does not turn a relative path into an external link', () => {
    expect(normalizeLinkUrl('/notes/today.md')).toBe('/notes/today.md');
    expect(isNavigableUrl('/notes/today.md')).toBe(false);
  });

  it('allows navigation to any ordinary destination', () => {
    for (const url of [
      'https://example.com',
      'http://example.com',
      'ftp://files.example.com',
      'steam://run/1',
      'mailto:a@b.c',
    ]) {
      expect(isNavigableUrl(url)).toBe(true);
    }
  });

  it('never lets a pasted URL execute code', () => {
    // These are not "disallowed sites" — they are not navigations at all, and putting
    // one in an href would run code in this page.
    expect(isNavigableUrl('javascript:alert(1)')).toBe(false);
    expect(isNavigableUrl('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isNavigableUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isNavigableUrl('vbscript:msgbox(1)')).toBe(false);
    // They are still stored verbatim, so nothing the user typed is thrown away.
    expect(normalizeLinkUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('does not pretend an empty string is a link', () => {
    expect(normalizeLinkUrl('   ')).toBe('');
    expect(isNavigableUrl('')).toBe(false);
    expect(isNavigableUrl('#fragment')).toBe(false);
  });
});

describe('link objects', () => {
  it('refuses to build a link with no address', () => {
    expect(makeLink('1', 'label', '   ')).toBeNull();
    expect(makeLink('1', 'label', 'example.com')).toEqual({
      id: '1',
      label: 'label',
      url: 'https://example.com',
    });
  });

  it('falls back to the host when there is no label', () => {
    const link: GameLink = { id: '1', label: '', url: 'https://www.example.com/page' };
    expect(linkDisplayLabel(link)).toBe('example.com');
    expect(linkHost(link.url)).toBe('example.com');
  });

  it('clamps instead of rejecting over-long input', () => {
    const long = `https://example.com/${'a'.repeat(MAX_LINK_URL_LENGTH * 2)}`;
    expect(normalizeLinkUrl(long).length).toBe(MAX_LINK_URL_LENGTH);
    expect(makeLink('1', 'x'.repeat(200), 'https://example.com')?.label.length).toBe(
      MAX_LINK_LABEL_LENGTH,
    );
  });
});

describe('normalizeLinks', () => {
  it('keeps what is usable and drops what is not, preserving order', () => {
    const links = normalizeLinks([
      { id: 'a', label: 'first', url: 'example.com/one' },
      { label: 'no id' },
      'not an object',
      { url: '' },
      { id: 'b', url: 'https://example.com/two' },
      null,
    ]);
    expect(links.map((link) => link.url)).toEqual([
      'https://example.com/one',
      'https://example.com/two',
    ]);
    expect(links[1]?.id).toBe('b');
  });

  it('survives a record that predates this field', () => {
    expect(normalizeLinks(undefined)).toEqual([]);
    expect(normalizeLinks(null)).toEqual([]);
    expect(normalizeLinks('nonsense')).toEqual([]);
  });

  it('caps the list without reordering it', () => {
    const many = Array.from({ length: MAX_LINKS_PER_GAME + 10 }, (_, index) => ({
      id: `id-${index}`,
      label: '',
      url: `https://example.com/${index}`,
    }));
    const links = normalizeLinks(many);
    expect(links).toHaveLength(MAX_LINKS_PER_GAME);
    expect(links[0]?.url).toBe('https://example.com/0');
  });
});
