/**
 * Storage-facing hash helpers.
 *
 * Kept separate from `@/rom/hash` so the persistence layer never depends on ROM
 * parsing, and so hashing save files is an explicit, obvious operation.
 */
import { sha256Hex } from '@/rom/hash';

/** SHA-256 of arbitrary bytes, as lowercase hex. */
export async function hashBytesHex(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

/** Convenience for text payloads (cheat lists, backup manifests). */
export async function hashTextHex(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}
