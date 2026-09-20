import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  compareVersions,
  enableFunctionHooks,
  extractVersion,
  jsonContains,
  parseJsonOutput,
  pluginInstallArgs,
  promptSecret,
  saveReviewApiKey,
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

  it('parses pretty-printed multi-line Claude JSON output', () => {
    const output = `[
      {
        "id": "jev-claudecode-ssy@jev-claudecode-ssy",
        "scope": "user"
      }
    ]`;
    expect(parseJsonOutput(output)).toEqual([
      { id: 'jev-claudecode-ssy@jev-claudecode-ssy', scope: 'user' },
    ]);
  });

  it('passes the masked key through the declared sensitive plugin config', () => {
    expect(pluginInstallArgs('test-key')).toEqual([
      'plugin',
      'install',
      'jev-claudecode-ssy@jev-claudecode-ssy',
      '--scope',
      'user',
      '--config',
      'apiKey=test-key',
    ]);
  });

  it('reads an API key without echoing it', async () => {
    class FakeInput extends EventEmitter {
      isTTY = true;
      raw = false;
      setRawMode(value: boolean) { this.raw = value; }
      setEncoding() {}
      resume() {}
      pause() {}
    }
    const input = new FakeInput();
    let shown = '';
    const promise = promptSecret({
      input,
      output: { write(value: string) { shown += value; } },
    });
    input.emit('data', 'secret-value\r');

    await expect(promise).resolves.toBe('secret-value');
    expect(shown).not.toContain('secret-value');
    expect(shown).toContain('*'.repeat('secret-value'.length));
    expect(input.raw).toBe(false);
  });

  it('stores the key for the Jev review command outside the project', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'jev-setup-'));
    const keyPath = await saveReviewApiKey('review-key', home);

    expect(keyPath).toBe(path.join(home, '.jev-claudecode-ssy', 'api-key'));
    await expect(readFile(keyPath, 'utf8')).resolves.toBe('review-key\n');
  });
});
