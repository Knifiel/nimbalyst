// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createPersonalSyncWriteGate, describePersonalSyncWriteGate } from '../personalSyncWriteGate';

describe('personal-sync write gate', () => {
  it('opens after a complete read with skipped rows and bounds the reported count', () => {
    const gate = createPersonalSyncWriteGate();
    const seen = vi.fn();
    gate.onChange(seen);
    expect(gate.canWrite()).toBe(false);
    gate.markVerified(2);
    expect(gate.canWrite()).toBe(true);
    expect(gate.snapshot()).toMatchObject({ state: 'verified', skippedRowCount: 2 });
    expect(describePersonalSyncWriteGate(gate.snapshot())).toBeNull();
    gate.markVerified(2);
    expect(seen).toHaveBeenCalledTimes(1);
    gate.markVerified(1e12);
    gate.setSkippedRowCount(1e12);
    expect(gate.snapshot().skippedRowCount).toBe(999_999);
    gate.markVerified();
    expect(gate.snapshot().skippedRowCount).toBe(0);
  });

  it('keeps an update requirement in place across clean reads and bounds the detail', () => {
    const gate = createPersonalSyncWriteGate();
    gate.markVerified();
    gate.markBlocked('update-required', 'x'.repeat(1000));
    gate.markVerified();
    expect(gate.snapshot().state).toBe('blocked');
    expect(gate.snapshot().detail).toHaveLength(300);
    expect(describePersonalSyncWriteGate(gate.snapshot())).toMatch(/^Update Nimbalyst/);
    expect(describePersonalSyncWriteGate({ state: 'verified', reason: null, detail: null })).toBeNull();
  });
});
