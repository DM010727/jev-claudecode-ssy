import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { decide, loadApiKey, validatePayload } from '../bin/jev-decide.mjs';

describe('Jev parallel decision helper', () => {
  it('normalizes a valid batch and rejects empty questions', () => {
    expect(validatePayload({ state: { findings: [] }, questions: { check: { type: 'noul' } } }))
      .toEqual({ model: 'jev-latest', state: { findings: [] }, questions: { check: { type: 'noul' } } });
    expect(() => validatePayload({ state: {}, questions: {} })).toThrow('questions 不能为空');
  });

  it('prefers the installer-managed key over a stale environment key', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'jev-key-'));
    const keyPath = path.join(directory, 'api-key');
    await writeFile(keyPath, 'saved-key\n', 'utf8');
    const previous = process.env.SSY_API_KEY;
    process.env.SSY_API_KEY = 'stale-key';
    try {
      await expect(loadApiKey(keyPath)).resolves.toBe('saved-key');
    } finally {
      if (previous === undefined) delete process.env.SSY_API_KEY;
      else process.env.SSY_API_KEY = previous;
    }
  });

  it('sends all questions in one request and saves the response', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'jev-decide-'));
    const inputPath = path.join(directory, 'request.json');
    const outputPath = path.join(directory, 'response.json');
    const keyPath = path.join(directory, 'api-key');
    await writeFile(keyPath, 'test-key\n');
    await writeFile(inputPath, JSON.stringify({
      state: { findings: [{ id: 'F1' }, { id: 'F2' }] },
      questions: {
        valid_F1: { type: 'noul', instructions: 'one' },
        valid_F2: { type: 'noul', instructions: 'two' },
      },
    }));

    let sent: any;
    const fetchFn = async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ answers: {
          valid_F1: { noul: 0.9 },
          valid_F2: { noul: 0.2 },
        } }),
      };
    };

    await decide({ inputPath, outputPath, fetchFn, keyPath });

    expect(Object.keys(sent.questions)).toHaveLength(2);
    expect(JSON.parse(await readFile(outputPath, 'utf8')).answers.valid_F1.noul).toBe(0.9);
  });
});
