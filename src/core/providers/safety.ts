export function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=');
  if (arg.startsWith('--') && eq > 0) return [arg.slice(0, eq), arg.slice(eq + 1)];
  return [arg, undefined];
}
