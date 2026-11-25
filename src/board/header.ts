import { createElement as h } from 'react';
import { Text } from 'ink';
import type { GlobalConfig } from '../core/config.ts';
import { diskLine, type DiskReport } from '../core/disk.ts';
import { activeProviders } from '../core/providers/registry.ts';

export function BoardDisk({ disk }: { disk: DiskReport }) {
  const label = `Disk: ${disk.level}`;
  const color = { critical: 'red', warn: 'yellow', ok: 'green', unknown: undefined }[disk.level];
  return h(Text, { wrap: 'truncate-end' }, h(Text, { color }, label), diskLine(disk).slice(label.length));
}

export function BoardLimits({ config }: { config: GlobalConfig }) {
  const entries = activeProviders(config).map(id => `${id} ${config.limits[id] ?? '∞'}`);
  return h(Text, { dimColor: true, wrap: 'truncate-end' }, `Limity: ${entries.join(' · ')} (L)`);
}
