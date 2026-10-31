/**
 * agentctl never turns on an agent's auto-accept mode. Flags from config files are
 * checked against this list so a typo-level copy/paste cannot silently remove the
 * human from the loop. Best effort, not a security boundary.
 */

const ALWAYS_FORBIDDEN = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--full-auto',
  '--approve-for-me',
]);

const FORBIDDEN_PERMISSION_MODES = new Set(['bypassPermissions', 'acceptEdits', 'auto', 'dontAsk']);

/** Returns the first auto-accept flag found in `args`, or undefined. */
export function findAutoAcceptFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const [flag, inlineValue] = splitFlag(arg);
    const value = inlineValue ?? args[i + 1];
    if (ALWAYS_FORBIDDEN.has(flag)) return arg;
    if (flag === '--permission-mode' && value !== undefined && FORBIDDEN_PERMISSION_MODES.has(value)) {
      return `${flag} ${value}`;
    }
    if ((flag === '-a' || flag === '--ask-for-approval') && value === 'never') return `${flag} ${value}`;
    if ((flag === '-c' || flag === '--config') && value !== undefined && /^approval_policy\s*=\s*["']?never/.test(value)) {
      return `${flag} ${value}`;
    }
  }
  return undefined;
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=');
  if (arg.startsWith('--') && eq > 0) return [arg.slice(0, eq), arg.slice(eq + 1)];
  return [arg, undefined];
}
