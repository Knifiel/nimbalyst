import { validSessionPayloadPart, type SessionPayloadPart } from '@nimbalyst/collab-protocol';

/** Bounded encrypted staging; parsing never sees a partial logical message. */
export class SessionPayloadInbox {
  private readonly transfers = new Map<string, Map<number, SessionPayloadPart>>();
  private bytes = 0;

  add(part: SessionPayloadPart): void {
    if (!validSessionPayloadPart(part)) throw new Error('Invalid transcript payload part');
    const transfer = this.transfers.get(part.transferId) ?? new Map<number, SessionPayloadPart>();
    const existing = transfer.get(part.index);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(part)) throw new Error('Conflicting transcript payload part');
      return;
    }
    if (this.bytes + part.encryptedContent.length > 25 * 1024 * 1024) throw new Error('Transcript payload receive budget exceeded');
    transfer.set(part.index, part);
    this.transfers.set(part.transferId, transfer);
    this.bytes += part.encryptedContent.length;
  }

  parts(transferId: string | undefined): SessionPayloadPart[] {
    return transferId ? [...(this.transfers.get(transferId)?.values() ?? [])] : [];
  }

  remove(transferId: string | undefined): void {
    if (!transferId) return;
    for (const part of this.parts(transferId)) this.bytes -= part.encryptedContent.length;
    this.transfers.delete(transferId);
  }

  clear(): void { this.transfers.clear(); this.bytes = 0; }
}
