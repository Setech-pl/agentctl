/** Provider errors only: never classify an ordinary user/tool mention of a quota. */
const QUOTA = /\b429\b|\bquota\b|rate[_ -]?limit|insufficient (?:balance|funds)|usage[_ -]?limit|limit (?:reached|exhausted)|you.ve hit your .{0,60}limit|out of extra usage|enforced_spend_limit_reached/i;
const ERROR_LINE = /^\s*(?:[●■⎿]\s*)?(?:API Error:|Error:|HTTP(?:\/\d(?:\.\d)?)?\s+429\b|Request rejected\s*\(429\)|Usage limit reached|You.ve hit your|You.re out of extra usage|Quota (?:exceeded|exhausted)|Insufficient balance|Rate limit)/i;
export const PROVIDER_QUOTA_PATTERN = `^(?=[^\\n]*(?:${QUOTA.source}))${ERROR_LINE.source.slice(1)}`;
export function quotaError(text: string, structured = false): string | undefined {
  if (structured) return QUOTA.test(text) ? text : undefined;
  return text.split('\n').find(line => ERROR_LINE.test(line) && QUOTA.test(line));
}
/** Explicit provider reset/Retry-After only; never infer a reset from the duration of a usage window. */
export function quotaReset(text: string, now: number): number | undefined {
  const iso = /(?:reset(?:s|s_at|_at)?(?:\s+(?:at|on))?|retry[-_ ]?after)["'\s:=`]+(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)/i.exec(text)?.[1];
  if (iso && Date.parse(iso) > now) return Date.parse(iso);
  const seconds = /retry[-_ ]?after["'\s:=]+(\d+(?:\.\d+)?)\b/i.exec(text)?.[1];
  if (seconds && Number(seconds) > 0) return now + Number(seconds) * 1000;
  const duration = /(?:reset(?:s)?|retry)\s+in\s+(\d+)\s*(seconds?|minutes?|hours?|[smh])\b/i.exec(text);
  if (duration) return now + Number(duration[1]) * (/^h/i.test(duration[2]!) ? 3600000 : /^m/i.test(duration[2]!) ? 60000 : 1000);
  const clock = /reset(?:s)?(?:\s+at)?\s+[`"']?(\d{1,2})(?::(\d\d))?\s*(am|pm)?\b/i.exec(text);
  if (clock && (clock[2] || clock[3])) {
    let hour = Number(clock[1]); const minute = Number(clock[2] ?? 0);
    if (clock[3]) hour = hour % 12 + (clock[3].toLowerCase() === 'pm' ? 12 : 0);
    if (hour > 23 || minute > 59) return undefined;
    const date = new Date(now); date.setHours(hour, minute, 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  return undefined;
}
