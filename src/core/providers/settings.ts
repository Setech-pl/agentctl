import type { AgentSettings } from '../config.ts';
import type { ProviderId } from './types.ts';

/** The mark that opens the line an agent prints for an error: bullets, tree corners, warning signs. */
const LINE_MARK = '^[\\s⎿●•■⚠!*>-]*';

const BACKGROUND_CLAUDE = '[·⏵].*\\b\\d+ (?:shells?|monitors?)\\b(?: still running)?';

const SETTINGS: Record<ProviderId, AgentSettings> = {
  claude: {
    acceptsBusyPrompt: true,
    flags: [],
    effortArgs: ['--effort', '{effort}'],
    // Claude Code 2.1.309 idle screen: the input box line "❯ Try ...". The trust dialog also uses "❯", but with "1. Yes".
    readyPattern: '^\\s*❯\\s(?!\\d+\\.)',
    readyTimeout: 60,
    trustTimeout: 600,
    trustPattern: 'Quick safety check|Yes, I trust this folder',
    workingPattern: 'esc to interrupt|^\\s*(?:⏺\\s+)?Running(?:\\s|…|\\.\\.\\.)|^\\s*[✶✻✽✢·*]\\s+[^\\n]+(?:…|\\.\\.\\.)\\s*\\([^\\n]*(?:\\d+(?:\\.\\d+)?s\\s*·|thinking|tokens)[^\\n]*\\)',
    deliveryPattern: '^\\s*⏺|● got:',
    interruptKey: 'Escape',
    footerPatterns: [
      '\\? for shortcuts',
      '^\\s*(⏵⏵|⏸)',
      'shift\\+tab to cycle',
      '^\\s*[❯>]\\s*(Try ".*")?$',
    ],
    // AskUserQuestion dialog footer, and the footer of a permission dialog ("Esc to cancel · Tab to amend").
    questionPattern: 'Enter to select\\b.*Esc to cancel|Esc to cancel · Tab to amend',
    // Strings of the 2.1.309 binary: "You've hit your session limit" / "weekly limit" / "<model> limit" / "monthly spend limit" (+ " · resets …"),
    // "Usage limit reached", "You're out of extra usage". The 429 line is also printed for a passing capacity problem (lower confidence).
    limitPatterns: [
      `${LINE_MARK}You.ve hit your .{0,60}limit`,
      `${LINE_MARK}Usage limit reached`,
      `${LINE_MARK}You.re out of extra usage`,
      `${LINE_MARK}(?:API Error: )?Request rejected \\(429\\)`,
    ],
    // Claude Code 2.1.309 footer "⏵⏵ auto mode on · 1 shell, 6 monitors" and the lines "… · 1 shell, 6 monitors still running". A "·" or "⏵⏵" on the same
    // line keeps a sentence of the conversation ("ran 2 shells") from counting.
    overloadPatterns: ['^\\s*⎿\\s*API Error:\\s*529(?:\\s|$)', '^\\s*⎿\\s*(?:API Error:\\s*)?Overloaded(?:[.:]|$)'],
    backgroundPatterns: ['^\\s*\\d+ (?:monitors?|shells?)(?:, \\d+ (?:monitors?|shells?))? still running\\b', BACKGROUND_CLAUDE, '[·⏵].*\\b\\d+ background\\b'],
  },
  codex: {
    acceptsBusyPrompt: true,
    flags: [],
    effortArgs: ['-c', 'model_reasoning_effort={effort}'],
    // Codex 0.166.0 idle screen: "› Ask Codex to do anything" and the footer "? for shortcuts".
    readyPattern: '^›\\s(?!\\d+\\.)|\\? for shortcuts',
    readyTimeout: 60,
    trustTimeout: 600,
    trustPattern: 'Trust this folder\\?|Folder settings can run code automatically',
    workingPattern: 'esc to interrupt',
    deliveryPattern: '^\\s*[•■]|● got:',
    interruptKey: 'Escape',
    // Codex 0.166.0 footer: "GPT-6.1-Sol low · <dir> · <title>" and "? for shortcuts … ⚠ 1 warning · f2 to view".
    footerPatterns: [
      '\\? for shortcuts',
      '⚠ \\d+ warnings?',
      'f2 to view',
      '^\\s*[\\w.-]+ (low|medium|high|xhigh|minimal|none) · ',
      '^\\s*›\\s*(Ask Codex to do anything)?\\s*$',
      'Queued follow-up inputs|⇧.? (edit last queued message|to answer)',
    ],
    // A pending request_user_input question: "? Which color…" with options, then "• Waiting for your answer."; and the footer of an
    // approval dialog ("Would you like to run the following command?" … "Press enter to confirm or esc to cancel").
    questionPattern: 'Waiting for your answer|^\\s*\\?\\s+\\d+ questions?\\b|to answer\\s*$|Press enter to confirm or esc to cancel',
    // Strings of the 0.166.0 binary (the apostrophe there is U+2019): "You've hit your usage limit. …", "Usage limit reached",
    // "You're out of credits", "Your workspace is out of credits", "You hit your spend cap …".
    limitPatterns: [
      `${LINE_MARK}You.ve hit your usage limit`,
      `${LINE_MARK}Usage limit reached`,
      `${LINE_MARK}You.re out of credits`,
      `${LINE_MARK}Your workspace is out of credits`,
      `${LINE_MARK}You hit your spend cap`,
    ],
    // Codex 0.166.0 has "background terminals" (/ps lists them, /stop ends them, "Waiting for background terminal"). The exact footer text with a
    // count was not seen on a screen: this pattern is a best guess, see the README.
    overloadPatterns: ['^\\s*■\\s*Selected model is at capacity(?:\\.|$)'],
    backgroundPatterns: ['\\b\\d+ background terminals?\\b'],
  },
};


export function defaultSettings(id: ProviderId): AgentSettings { return structuredClone(SETTINGS[id]); }
