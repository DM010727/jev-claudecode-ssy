import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  enableFunctionHooks,
  extractVersion,
  jsonContains,
} from '../bin/setup.mjs';

describe('one-command installer helpers', () => {
  it('extracts and compares Claude Code versions', () => {
    expect(extractVersion('Claude Code 2.1.274')).toBe('2.1.274');
    expect(compareVersions('2.1.274', '2.1.274')).toBe(0);
    expect(compareVersions('2.2.0', '2.1.274')).toBe(1);
    expect(compareVersions('2.1.263', '2.1.274')).toBe(-1);
  });

  it('merges the function-hook flag without losing user settings', () => {
    expect(enableFunctionHooks({ theme: 'dark', env: { EXISTING: 'yes' } })).toEqual({
      theme: 'dark',
      env: {
        EXISTING: 'yes',
        CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
      },
    });
  });

  it('finds marketplace and plugin identifiers in changing JSON shapes', () => {
    const value = [{ source: { repo: 'DM010727/jev-claudecode-ssy' } }];
    expect(jsonContains(value, 'dm010727/JEV-CLAUDECODE-SSY')).toBe(true);
    expect(jsonContains(value, 'other/plugin')).toBe(false);
  });
});
