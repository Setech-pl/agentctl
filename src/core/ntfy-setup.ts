import { randomBytes } from 'node:crypto';
import type { GlobalConfig } from './config.ts';
import { DEFAULT_NTFY_SERVER } from './config.ts';
import { editConfigText } from './config-edit.ts';
import type { Runner } from './runner.ts';

/** Characters of the random part of a topic: 24 hex digits = 96 bits. */
const TOPIC_RANDOM_BYTES = 12;
export const MIN_TOPIC_LENGTH = 24;

/** `agentctl-<24 random hex digits>`: 33 characters, not guessable. */
export function generateTopic(random: (n: number) => Buffer = randomBytes): string {
  return `agentctl-${random(TOPIC_RANDOM_BYTES).toString('hex')}`;
}

/** Why a topic is a weak secret on a public server; undefined when it is fine. */
export function weakTopic(topic: string): string | undefined {
  if (topic.length < MIN_TOPIC_LENGTH) return `only ${topic.length} characters (use at least ${MIN_TOPIC_LENGTH})`;
  const rest = topic.replace(/^agentctl[-_]?/i, '');
  if (!/\d/.test(rest)) return 'it looks like words, not random characters';
  if (new Set(topic.toLowerCase()).size < 8) return 'it repeats the same few characters';
  return undefined;
}

export const isPublicServer = (server: string): boolean => /^https?:\/\/(?:www\.)?ntfy\.sh\/?$/i.test(server);

export interface NtfySetupPlan {
  file: string;
  topic: string;
  server: string;
  /** A topic was already in the config and is kept. */
  kept: boolean;
  /** The new text of config.yaml; undefined when nothing changes. */
  text?: string;
}

export interface NtfySetupOptions {
  server?: string | undefined;
  /** Make a new topic although one is set. */
  regenerate?: boolean | undefined;
  random?: ((n: number) => Buffer) | undefined;
}

/** The edit of config.yaml as text (comments and key order stay); nothing is written. */
export function planNtfySetup(config: GlobalConfig, options: NtfySetupOptions = {}): NtfySetupPlan {
  const existing = config.notify.ntfy?.topic;
  const keep = existing !== undefined && !options.regenerate;
  const topic = keep ? existing : generateTopic(options.random);
  const server = (options.server ?? config.notify.ntfy?.server ?? DEFAULT_NTFY_SERVER).replace(/\/+$/, '');
  const serverChanged = server !== (config.notify.ntfy?.server ?? DEFAULT_NTFY_SERVER);
  const plan: NtfySetupPlan = { file: config.path, topic, server, kept: keep };
  if (keep && !serverChanged) return plan;
  plan.text = editConfigText(config, (doc) => {
    doc.setIn(['notify', 'ntfy', 'topic'], topic);
    if (options.server !== undefined || config.notify.ntfy?.server) doc.setIn(['notify', 'ntfy', 'server'], server);
  });
  return plan;
}

/** `ntfy://<host>/<topic>`: the link the ntfy apps open to subscribe. */
export const subscriptionLink = (server: string, topic: string): string => `ntfy://${server.replace(/^https?:\/\//, '')}/${topic}`;

/** What to do on the phone, and the warning about the public server. */
export function setupInstructions(server: string, topic: string): string[] {
  const lines = [
    'On the phone:',
    '  1. Install the ntfy app: iOS - App Store "ntfy"; Android - Google Play or F-Droid "ntfy".',
    `  2. Open it, tap "+" (Subscribe to topic), type the topic: ${topic}`,
  ];
  if (isPublicServer(server)) lines.push('     (the default server ntfy.sh is used: leave "Use another server" off)');
  else lines.push(`  3. Switch on "Use another server" and enter ${server}; with a token set notify.ntfy.token in config.yaml.`);
  lines.push(`  ${isPublicServer(server) ? '3' : '4'}. Test it: agentctl away on && agentctl notify-test --phone`);
  lines.push(`Subscription link: ${subscriptionLink(server, topic)}   (agentctl ntfy-setup --show-qr prints it as a QR code)`);
  if (isPublicServer(server)) {
    lines.push(
      '',
      `WARNING: on the public ntfy.sh anyone who knows the topic name "${topic}" can read your notifications and send their own.`,
      'The name is the only protection: do not share it, do not commit config.yaml. That is why a message holds only the task ID,',
      'the cohort name and the first line of the verdict - never the report, a path or a file name. For more, run your own ntfy',
      'server or use an account with an access token (notify.ntfy.server, notify.ntfy.token).',
    );
  }
  return lines;
}

/** QR code of the subscription link in the terminal, made by `qrencode` (brew install qrencode) when it is installed. Undefined: no such tool. */
export async function renderQr(runner: Runner, text: string): Promise<string[] | undefined> {
  const r = await runner.exec('qrencode', ['-t', 'ANSIUTF8', '-m', '2', text], { readOnly: true });
  if (r.code !== 0 || r.stdout.trim() === '') return undefined;
  return r.stdout.replace(/\n+$/, '').split('\n');
}
