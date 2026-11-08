import type { AgentSettings } from '../config.ts';

/** Kimi Code 2.5.0 screenshots; auth/limit/overload/background remain synthetic hypotheses. */
export function kimiSettings(): AgentSettings {
  return {
    idleRequiresInput: true, flags: [], effortArgs: [], acceptsBusyPrompt: false,
    readyPattern: '^\\s*│\\s*>', readyTimeout: 60, trustTimeout: 600,
    trustPattern: 'Trust this folder\\?|Trust and continue|OAuth login expired|Run /login or /provider|^\\s*(?:Update available|Install update\\?)',
    workingPattern: '^\\s*(?:🌑|🌒|🌓|🌔|🌕|🌖|🌗|🌘)(?:\\s*[·•].*)?$|^\\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\\s+Working…|^\\s*Retrying \\(\\d+/\\d+\\)',
    deliveryPattern: '^\\s*●\\s', interruptKey: 'Escape',
    approvalPattern: 'Run this command\\?|Write this file\\?|Apply these edits\\?|Stop this task\\?|Approve once|Approve for this session|Reject with feedback|↑/↓ select · 1/2/3/4 choose · ↵ confirm',
    questionPattern: '^\\s*question\\b|\\[1\\].*\\[4\\].*Other|Waiting for your input|Review your answer before submit|Ready to submit your answers\\?|\\[1\\] Submit \\[2\\] Cancel',
    limitPatterns: ['^\\s*(?:[■●]\\s*)?Error: \\[provider\\.(?:rate_limit|api_error)\\]'],
    overloadPatterns: ['^\\s*(?:[■●]\\s*)?Error: \\[provider\\.overloaded\\]'],
    backgroundPatterns: ['^\\s*\\[\\d+ tasks? running\\]'],
    footerPatterns: ['context: \\d+% \\(', 'ctrl\\+o expand', 'tmux extended-keys is off', '^\\s*│\\s*>', 'Kimi Code updated to v\\d+\\.\\d+\\.\\d+'],
  };
}
