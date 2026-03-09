/**
 * Panel channel API tests (Task 5.1).
 * Verifies Panel base class has channels property and onChannelReady/onChannelError hooks.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const panelSrc = readFileSync(resolve(root, 'src/components/Panel.ts'), 'utf-8');

describe('Panel channel API (Task 5.1)', () => {
  it('Panel has channelKeys property', () => {
    assert.ok(
      /readonly\s+channelKeys\s*:\s*string\[\]/.test(panelSrc) ||
        /channelKeys\s*:\s*string\[\]\s*=?\s*\[\]/.test(panelSrc),
      'Panel must have channelKeys: string[] property'
    );
  });

  it('Panel has onChannelReady protected method', () => {
    assert.ok(
      panelSrc.includes('onChannelReady') && panelSrc.includes('protected'),
      'Panel must have protected onChannelReady method'
    );
  });

  it('Panel has onChannelError protected method', () => {
    assert.ok(
      panelSrc.includes('onChannelError') && panelSrc.includes('protected'),
      'Panel must have protected onChannelError method'
    );
  });

  it('onChannelError calls showError by default', () => {
    assert.ok(
      panelSrc.includes('this.showError(error)'),
      'onChannelError default implementation must call showError'
    );
  });
});
