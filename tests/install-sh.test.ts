import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerPath = path.join(root, 'install.sh');
const installer = readFileSync(installerPath, 'utf8');
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';

function shellPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

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

  it('braces shell variables when non-ASCII punctuation follows them', () => {
    expect(installer).not.toMatch(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/);
  });

  it('executes completion under nounset even when version is unset', () => {
    const completion = installer.slice(installer.indexOf('unset API_KEY'));
    const result = spawnSync(bash, ['-eu'], {
      input: `unset PLUGIN_VERSION\n${completion}`,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Jev Claude Code 胜算云适配器已安装完成。');
    expect(result.stdout).toContain('Jev 并行审查工具也已配置完成。');
  });

  it('ships Unix line endings for execution by macOS Bash', () => {
    expect(installer).not.toContain('\r');
  });

  it.each([false, true])('runs the piped installer through completion or install failure (failure=%s)', (failInstall) => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'jev installer '));
    try {
      const keyFile = path.join(fixture, 'input-key');
      writeFileSync(keyFile, 'fixture-key\n');
      // Replace only terminal I/O and the review credential location. All shell
      // control flow, paths, flags and completion messages execute unchanged.
      const script = installer
        .replace(/> \/dev\/tty/g, '>&2')
        .replace(/< \/dev\/tty/g, '< "$TEST_KEY_FILE"')
        .replace('"$HOME/.jev-claudecode-ssy"', '"$TEST_REVIEW_DIR"');
      const stubs = `
uname() { printf 'Darwin\\n'; }
function /usr/bin/osascript() {
  while IFS= read -r line; do :; done
}
claude() {
  local unexpected
  if IFS= read -r unexpected; then
    printf 'Claude consumed installer stdin\\n' >&2
    return 91
  fi
  if [[ "$1 \${2:-}" == "plugin install" ]]; then
    if [[ "$*" != *"apiKey=fixture-key"* ]]; then return 92; fi
    if [[ "$TEST_FAIL_INSTALL" == 1 ]]; then return 42; fi
  fi
}
`;
      const result = spawnSync(bash, [], {
        input: `${stubs}\n${script}`,
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: shellPath(path.join(fixture, 'claude config')),
          TEST_KEY_FILE: shellPath(keyFile),
          TEST_REVIEW_DIR: shellPath(path.join(fixture, 'review config')),
          TEST_FAIL_INSTALL: failInstall ? '1' : '0',
        },
      });
      expect(result.status, result.stderr).toBe(failInstall ? 42 : 0);
      const savedKey = path.join(fixture, 'review config', 'api-key');
      if (failInstall) {
        expect(result.stdout).not.toContain('适配器已安装完成');
        expect(existsSync(savedKey)).toBe(false);
      } else {
        expect(result.stdout).toContain('适配器已安装完成');
        expect(readFileSync(savedKey, 'utf8')).toBe('fixture-key\n');
      }
      expect(result.stdout + result.stderr).not.toContain('fixture-key');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
