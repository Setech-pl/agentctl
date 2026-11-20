import type { Runner } from './runner.ts';

/** Use the OS Trash, including the mount's own Trash when the platform supports it. */
export async function moveToTrash(runner: Runner, target: string): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Trash unsupported on this platform');
  const script = 'ObjC.import("Foundation"); function run(argv) { const url = $.NSURL.fileURLWithPath(argv[0]); const error = Ref(); if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, null, error)) throw Error(ObjC.unwrap(error[0].localizedDescription)); }';
  const result = process.platform === 'darwin'
    ? await runner.exec('osascript', ['-l', 'JavaScript', '-e', script, target], { async: true, timeoutMs: 30_000 })
    : await runner.exec('gio', ['trash', '--', target], { async: true, timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`Trash unavailable: ${result.stderr.trim() || `exit ${result.code}`}`);
}
