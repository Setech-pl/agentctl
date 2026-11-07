export function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=');
  if (arg.startsWith('--') && eq > 0) return [arg.slice(0, eq), arg.slice(eq + 1)];
  return [arg, undefined];
}

/** Frozen 0.17.4 policy, owned separately by each original adapter. */
export const legacySafety = {
  forbiddenFlags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--approve-for-me'],
  check(args: string[]): string | undefined {
    const [arg, next] = args;
    if (!arg) return undefined;
    const [flag, inline] = splitFlag(arg), value = inline ?? next;
    if (flag === '--permission-mode' && value !== undefined && ['bypassPermissions', 'acceptEdits', 'auto', 'dontAsk'].includes(value)) return `${flag} ${value}`;
    if ((flag === '-a' || flag === '--ask-for-approval') && value === 'never') return `${flag} ${value}`;
    if ((flag === '-c' || flag === '--config') && value !== undefined && /^approval_policy\s*=\s*["']?never/.test(value)) return `${flag} ${value}`;
    return undefined;
  },
};
