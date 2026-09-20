import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Claude Code function-hook packaging', () => {
  it('declares the hook module in the conventional hooks manifest', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'),
    ) as { modules?: string[] };

    expect(manifest.modules).toEqual(['./fast-jev.ts']);
  });

  it('calls process.run directly so Claude Code security scanning accepts the hook', () => {
    const source = readFileSync(path.join(root, 'hooks', 'fast-jev.ts'), 'utf8');

    expect(source).toContain('processResult = await $.process.run(');
    expect(source).not.toContain('curlFetch($.process.run');
  });

  it('uses strict plugin validation instead of validating only the marketplace wrapper', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['validate:plugin']).toBe(
      'claude plugin validate .claude-plugin/plugin.json --strict',
    );
  });
});
