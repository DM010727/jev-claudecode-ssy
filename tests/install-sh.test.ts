import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerPath = path.join(root, 'install.sh');
const installer = readFileSync(installerPath, 'utf8');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';

describe('macOS installer', () => {
  it('has valid Bash syntax', () => {
    const result = spawnSync(bash, ['-n', installerPath], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('uses the built-in JXA JSON parser instead of plutil', () => {
    expect(installer).toContain("/usr/bin/osascript -l JavaScript - \"$SETTINGS_FILE\"");
    expect(installer).toContain("settings = JSON.parse(raw || '{}')");
    expect(installer).toContain("settings.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1'");
    expect(installer).not.toContain('/usr/bin/plutil');
  });

  it('embeds syntactically valid JavaScript for osascript', () => {
    const match = installer.match(/<<'JXA'\n([\s\S]*?)\nJXA/);
    expect(match?.[1]).toBeTruthy();
    expect(() => new Function(match?.[1] ?? '')).not.toThrow();
  });

  it('assigns the settings path before every use and preserves a backup', () => {
    const assignment = installer.indexOf('SETTINGS_FILE="$CONFIG_DIR/settings.json"');
    const firstUse = installer.indexOf('$SETTINGS_FILE');
    expect(assignment).toBeGreaterThanOrEqual(0);
    expect(firstUse).toBeGreaterThan(assignment);
    expect(installer).toContain('cp "$SETTINGS_FILE" "$SETTINGS_FILE.jev-ssy-');
  });
});
