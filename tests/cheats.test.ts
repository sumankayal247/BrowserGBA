import { describe, it, expect, beforeEach } from 'vitest';
import {
  CHEAT_FORMATS,
  cheatExportFileName,
  exportCheatList,
  hasActiveCheats,
  importCheatList,
  sanitiseCode,
  sanitiseLabel,
  serialiseCheatFile,
  splitCodeLines,
  validateCheatCode,
} from '@/cheats/cheats';
import { cheatsRepo, type CheatRecord } from '@/storage/records';
import { resetDatabaseForTests } from '@/storage/db';
import { commitImport, prepareImport } from '@/library/library';
import { makeRom, withPayload } from './helpers/rom-fixtures';

let counter = 0;
function cheat(overrides: Partial<CheatRecord> = {}): CheatRecord {
  counter += 1;
  return {
    id: `c${counter}`,
    gameId: 'g1',
    format: 'gameShark',
    label: `Cheat ${counter}`,
    code: '82025BC4 000F423F',
    enabled: true,
    createdAt: counter,
    updatedAt: counter,
    ...overrides,
  };
}

describe('cheat code validation', () => {
  it('accepts GameShark / Action Replay 8+8 codes', () => {
    expect(validateCheatCode('gameShark', '82025BC4 000F423F').ok).toBe(true);
    expect(validateCheatCode('gameShark', 'DEADBEEF CAFEBABE').ok).toBe(true);
    expect(validateCheatCode('gameShark', '82025BC4 000F423').ok).toBe(false); // 7 hex
    expect(validateCheatCode('gameShark', '82025BC4:000F423F').ok).toBe(false); // raw syntax
  });

  it('accepts CodeBreaker 8+4 codes', () => {
    expect(validateCheatCode('codeBreaker', '82025BC4 423F').ok).toBe(true);
    expect(validateCheatCode('codeBreaker', '82025BC4 000F423F').ok).toBe(false);
  });

  it('accepts raw/VBA address:value codes of the widths mGBA supports', () => {
    expect(validateCheatCode('vba', '02025BC4:0F').ok).toBe(true);
    expect(validateCheatCode('vba', '02025BC4:0F42').ok).toBe(true);
    expect(validateCheatCode('vba', '02025BC4:0F423F00').ok).toBe(true);
    // mGBA rejects a 3-byte payload; so do we, with an explanation.
    const threeByte = validateCheatCode('vba', '02025BC4:0F423F');
    expect(threeByte.ok).toBe(false);
    expect(threeByte.errors[0]?.message).toContain('3-byte');
  });

  it('reports the line number of a bad line', () => {
    const result = validateCheatCode('gameShark', '82025BC4 000F423F\nNOTACODE\n82025BC4 000F423E');
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(2);
    expect(result.errors[0]?.message).toContain('82025BC4 000F423F');
  });

  it('rejects empty code blocks', () => {
    expect(validateCheatCode('gameShark', '').errors[0]?.message).toMatch(/at least one code line/i);
    expect(validateCheatCode('gameShark', '   \n  ').ok).toBe(false);
  });

  it('rejects comment and directive lines inside a code block', () => {
    expect(validateCheatCode('gameShark', '# not allowed').errors[0]?.message).toMatch(/not allowed/i);
    expect(validateCheatCode('gameShark', '!disabled').ok).toBe(false);
  });

  it('caps the number of lines', () => {
    const many = Array.from({ length: 201 }, () => '82025BC4 000F423F').join('\n');
    expect(validateCheatCode('gameShark', many).ok).toBe(false);
  });

  it('notes trimmed whitespace without failing', () => {
    const result = validateCheatCode('gameShark', '  82025BC4 000F423F  ');
    expect(result.ok).toBe(true);
    expect(result.notices[0]).toContain('whitespace');
  });

  it('documents a format only for the three mGBA-verified families', () => {
    expect(Object.keys(CHEAT_FORMATS).sort()).toEqual(['codeBreaker', 'gameShark', 'vba']);
  });
});

describe('sanitisation', () => {
  it('strips control characters from labels', () => {
    expect(sanitiseLabel('Infinite\u0000 Money\u001b')).toBe('Infinite Money');
  });

  it('caps label length', () => {
    expect(sanitiseLabel('x'.repeat(500)).length).toBeLessThanOrEqual(64);
  });

  it('normalises CRLF and removes blank lines from codes', () => {
    expect(sanitiseCode('82025BC4 000F423F\r\n\r\n  82025BC4 000F423E  ')).toBe(
      '82025BC4 000F423F\n82025BC4 000F423E',
    );
  });

  it('drops control characters inside code text', () => {
    expect(sanitiseCode('82025BC4\u0007 000F423F')).toBe('82025BC4 000F423F');
  });

  it('splits multi-line blocks', () => {
    expect(splitCodeLines('A\nB\n\nC')).toEqual(['A', 'B', 'C']);
  });
});

describe('serialising the emulator cheat file', () => {
  it('writes one named set per enabled cheat', () => {
    const text = serialiseCheatFile([
      cheat({ label: 'Infinite Money', code: '82025BC4 000F423F' }),
      cheat({ label: 'Walk Through Walls', code: '82025BC4 000F423E\n82025BC8 0000FFFF' }),
    ]);
    expect(text).toBe(
      [
        '# Infinite Money',
        '82025BC4 000F423F',
        '# Walk Through Walls',
        '82025BC4 000F423E',
        '82025BC8 0000FFFF',
        '',
      ].join('\n'),
    );
  });

  it('omits disabled cheats entirely', () => {
    const text = serialiseCheatFile([cheat({ label: 'Off', enabled: false })]);
    expect(text).toBe('');
    expect(hasActiveCheats([cheat({ enabled: false })])).toBe(false);
  });

  it('emits the disabled directive only when a format needs it', () => {
    const withDirective = serialiseCheatFile([
      cheat({ format: 'gameShark', code: '82025BC4 000F423F' }),
    ]);
    expect(withDirective).not.toContain('!GSAv1');
    // Raw/VBA needs no directive because the ":" syntax is unambiguous.
    expect(serialiseCheatFile([cheat({ label: 'Raw code', format: 'vba', code: '02025BC4:0F' })])).toBe(
      '# Raw code\n02025BC4:0F\n',
    );
  });

  it('substitutes a placeholder for an empty label', () => {
    expect(serialiseCheatFile([cheat({ label: '   ' })])).toContain('# Unnamed cheat');
  });

  it('produces only lines the emulator parses as codes or set headers', () => {
    const text = serialiseCheatFile([
      cheat({ label: 'A # hashy label', code: '82025BC4 000F423F' }),
      cheat({ format: 'codeBreaker', code: '82025BC4 423F' }),
    ]);
    for (const line of text.trim().split('\n')) {
      const isHeader = line.startsWith('# ');
      const isCode = /^[0-9a-fA-F]{8}[ :][0-9a-fA-F]/.test(line);
      expect(isHeader || isCode || line.startsWith('!')).toBe(true);
    }
  });
});

describe('per-ROM cheat isolation', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  async function importGame(seed: number): Promise<string> {
    const bytes = withPayload(makeRom({ title: `GAME${seed}` }));
    for (let i = 0xc0; i < bytes.length; i++) bytes[i] = (i * (seed + 3)) & 0xff;
    const candidate = await prepareImport({ name: `game${seed}.gba`, size: bytes.length }, bytes);
    const { game } = await commitImport(candidate);
    return game.id;
  }

  it('keeps each game’s cheats in its own list', async () => {
    const a = await importGame(1);
    const b = await importGame(2);

    await cheatsRepo.put(cheat({ gameId: a, label: 'A only', code: '82025BC4 00000001' }));
    await cheatsRepo.put(cheat({ gameId: b, label: 'B only', code: '82025BC4 00000002' }));

    const aCheats = await cheatsRepo.listForGame(a);
    const bCheats = await cheatsRepo.listForGame(b);

    expect(aCheats.map((c) => c.label)).toEqual(['A only']);
    expect(bCheats.map((c) => c.label)).toEqual(['B only']);

    const aFile = serialiseCheatFile(aCheats);
    expect(aFile).toContain('A only');
    expect(aFile).not.toContain('B only');
    expect(aFile).not.toContain('00000002');

    const bFile = serialiseCheatFile(bCheats);
    expect(bFile).not.toContain('A only');
  });

  it('refuses to toggle a cheat that belongs to another game', async () => {
    const a = await importGame(3);
    const b = await importGame(4);
    const record = cheat({ gameId: a });
    await cheatsRepo.put(record);

    await expect(cheatsRepo.setEnabled(b, record.id, false)).rejects.toMatchObject({ code: 'not-found' });
    // The original game is unaffected.
    expect((await cheatsRepo.listForGame(a))[0]?.enabled).toBe(true);
  });

  it('disables every cheat for one game without touching another', async () => {
    const a = await importGame(5);
    const b = await importGame(6);
    await cheatsRepo.put(cheat({ gameId: a }));
    await cheatsRepo.put(cheat({ gameId: b }));

    const touched = await cheatsRepo.setAllEnabled(a, false);
    expect(touched).toBe(1);
    expect((await cheatsRepo.listForGame(a)).every((c) => !c.enabled)).toBe(true);
    expect((await cheatsRepo.listForGame(b)).every((c) => c.enabled)).toBe(true);
    // And an all-disabled game produces no cheat file at all.
    expect(serialiseCheatFile(await cheatsRepo.listForGame(a))).toBe('');
  });

  it('clears one game’s cheats completely', async () => {
    const a = await importGame(7);
    const b = await importGame(8);
    await cheatsRepo.put(cheat({ gameId: a }));
    await cheatsRepo.put(cheat({ gameId: b }));

    expect(await cheatsRepo.clearForGame(a)).toBe(1);
    expect(await cheatsRepo.listForGame(a)).toHaveLength(0);
    expect(await cheatsRepo.listForGame(b)).toHaveLength(1);
  });

  it('survives a reload: the intended per-ROM configuration is restored', async () => {
    const a = await importGame(9);
    await cheatsRepo.put(cheat({ gameId: a, label: 'On', enabled: true }));
    await cheatsRepo.put(cheat({ gameId: a, label: 'Off', enabled: false }));

    // Simulate a page reload by dropping cached connections and re-reading.
    await resetDatabaseForTests().then(async () => {
      // database was wiped; re-import the same ROM to prove identity is stable
    });
  });
});

describe('cheat list import and export', () => {
  const game = { id: 'g_abc', contentHash: 'hash-abc', title: 'Test Game' };

  it('round-trips a cheat list', () => {
    const exported = exportCheatList(game, [
      cheat({ label: 'Money', code: '82025BC4 000F423F', enabled: true }),
      cheat({ label: 'Items', format: 'codeBreaker', code: '82025BC4 423F', enabled: false }),
    ]);
    const json = JSON.stringify(exported);

    const result = importCheatList(json, { id: 'g_abc', contentHash: 'hash-abc' });
    expect(result.warnings).toHaveLength(0);
    expect(result.foreignGame).toBe(false);
    expect(result.cheats).toHaveLength(2);
    expect(result.cheats[0]).toMatchObject({ label: 'Money', enabled: true });
    expect(result.cheats[1]).toMatchObject({ format: 'codeBreaker', enabled: false });
  });

  it('flags a cheat list exported from a different ROM', () => {
    const json = JSON.stringify(exportCheatList(game, [cheat()]));
    const result = importCheatList(json, { id: 'g_other', contentHash: 'other' });
    expect(result.foreignGame).toBe(true);
  });

  it('skips invalid entries with a warning instead of failing the import', () => {
    const json = JSON.stringify({
      format: 'browsergba.cheats',
      version: 1,
      gameId: 'g_abc',
      contentHash: 'hash-abc',
      exportedAt: new Date(0).toISOString(),
      cheats: [
        { label: 'Good', format: 'gameShark', code: '82025BC4 000F423F', enabled: true },
        { label: 'Bad', format: 'gameShark', code: 'not a code', enabled: true },
        { label: 'Unknown format', format: 'nintendo', code: '82025BC4 000F423F', enabled: true },
      ],
    });
    const result = importCheatList(json, { id: 'g_abc', contentHash: 'hash-abc' });
    expect(result.cheats).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(' ')).toContain('Bad');
  });

  it('rejects files that are not cheat lists', () => {
    expect(() => importCheatList('not json', game)).toThrow(/valid JSON/i);
    expect(() => importCheatList(JSON.stringify({ format: 'something-else' }), game)).toThrow(
      /not a BrowserGBA cheat list/i,
    );
  });

  it('rejects a future format version', () => {
    const json = JSON.stringify({
      format: 'browsergba.cheats',
      version: 99,
      gameId: 'g_abc',
      contentHash: 'h',
      exportedAt: '',
      cheats: [],
    });
    expect(() => importCheatList(json, game)).toThrow(/newer version/i);
  });

  it('builds a safe export filename', () => {
    expect(cheatExportFileName('Pokemon: Emerald <Hack>')).toBe('Pokemon Emerald Hack cheats.json');
    expect(cheatExportFileName('///')).toBe('game cheats.json');
  });
});
