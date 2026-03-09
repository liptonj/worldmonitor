#!/usr/bin/env npx tsx
/**
 * Generates channel-keys.json from the channel registry for the gateway (CJS).
 * Run before building or starting the gateway. Output: services/gateway/channel-keys.json
 *
 * @see docs/plans/2026-03-09-frontend-refactor.md Task 1.2
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_REGISTRY, REDIS_KEY_MAP } from '../src/config/channel-registry.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = join(__dirname, '..');
const outPath = join(rootDir, 'services', 'gateway', 'channel-keys.json');

/** Derive map layer -> Redis key from registry. First channel with a given mapLayer wins. */
function deriveMapKeys(): Record<string, string> {
  const mapKeys: Record<string, string> = {};
  for (const def of Object.values(CHANNEL_REGISTRY)) {
    for (const layer of def.mapLayers ?? []) {
      if (!(layer in mapKeys)) {
        mapKeys[layer] = def.redisKey;
      }
    }
  }
  return mapKeys;
}

const channelKeys = REDIS_KEY_MAP;
const mapKeys = deriveMapKeys();

const output = {
  channelKeys,
  mapKeys,
  _generated: new Date().toISOString(),
};

writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
console.log(`Wrote ${outPath} (${Object.keys(channelKeys).length} channels, ${Object.keys(mapKeys).length} map layers)`);
