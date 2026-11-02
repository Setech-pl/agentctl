import fs from 'node:fs';
import path from 'node:path';

// Loaded before test modules, in each test process. Even a plain `npm test`
// must never read user configuration or connect to the user's tmux server.
const cache = process.env.AGENTCTL_TEST_TMP ?? process.env.AGENTCTL_TEST_CACHE ?? path.resolve(import.meta.dirname, '../.cache');
fs.mkdirSync(cache, { recursive: true });
const root = fs.mkdtempSync(path.join(cache, 'isolated-'));
for (const [key, name] of Object.entries({ HOME: 'home', AGENTCTL_HOME: 'agentctl', CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude', TMUX_TMPDIR: 'tmux', TMPDIR: 'tmp' })) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  process.env[key] = dir;
}
delete process.env.TMUX;
delete process.env.TMUX_PANE;
delete process.env.AGENTCTL_STABLE_DIR;
delete process.env.AGENTCTL_REPO;
process.env.XDG_CONFIG_HOME = path.join(root, 'home/.config');
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(process.execPath, path.join(bin, 'node'));
for (const name of ['tmux', 'claude', 'codex', 'pbcopy', 'pbpaste', 'terminal-notifier', 'osascript', 'notify-send', 'wl-copy', 'wl-paste', 'xclip']) {
  fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
}
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
