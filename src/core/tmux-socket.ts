import type { GlobalConfig } from './config.ts';
import type { Runner } from './runner.ts';
import { shellLine } from './util.ts';

const originals = new WeakMap<Runner, Runner>();
/** Scope even legacy direct tmux calls; leave every other runner operation bound to its original instance. */
export function socketRunner(runner: Runner, socket: () => string | undefined): Runner {
  const original = originals.get(runner) ?? runner;
  const scoped = new Proxy(original, {
    get(target, key) {
      if (key === 'exec') return (cmd: string, args: string[], opts?: Parameters<Runner['exec']>[2]) => {
        const name = socket();
        return target.exec(cmd, cmd === 'tmux' && name ? ['-L', name, ...args] : args, opts);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  originals.set(scoped, original);
  return scoped;
}

export function tmuxCommand(config: Pick<GlobalConfig, 'tmux'>, args: string[]): string {
  return shellLine('tmux', [...(config.tmux?.socket ? ['-L', config.tmux.socket] : []), ...args]);
}

export function attachHint(config: Pick<GlobalConfig, 'session' | 'tmux'>): string {
  return tmuxCommand(config, ['attach', '-t', `=${config.session}`]);
}
