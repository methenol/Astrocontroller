/**
 * The Seestar handshake (firmware 7.18+): the scope hands out a challenge string, the client signs
 * it with the private key the official app carries (RSA-SHA1, PKCS#1 v1.5) and the scope checks the
 * signature. Without a valid signature every other request is refused.
 *
 *   get_verify_str('verify')  → { result: { str } }   (code 103, or an empty str: no handshake wanted)
 *   verify_client({ sign, data })
 *   pi_is_verified('verify')  → non-zero codes are tolerated: the scope answers requests either way
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export type Send = (method: string, params: unknown, timeoutMs: number) => Promise<RpcResponse>;

export interface RpcResponse {
  id?: number;
  method?: string;
  code?: number;
  result?: unknown;
  error?: unknown;
  [k: string]: unknown;
}

const STEP_TIMEOUT_MS = 10_000;
const NO_HANDSHAKE_CODE = 103;

export function signChallenge(pem: string, challenge: string): string {
  return crypto.sign('sha1', Buffer.from(challenge), { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
}

/** The handshake key from disk; a clear error when it is missing or not a PEM private key. */
export function readKey(path: string): string {
  if (!path) throw new Error('SEESTAR_KEY_PATH is not set: the Seestar refuses every request until the app key signs its challenge');
  let pem: string;
  try {
    pem = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`SEESTAR_KEY_PATH (${path}) cannot be read: ${(err as Error).message}`);
  }
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) throw new Error(`SEESTAR_KEY_PATH (${path}) is not a PEM private key`);
  return pem;
}

export interface HandshakeResult {
  required: boolean;
  verified: boolean;
}

/** Run the handshake on a fresh connection. Throws when the scope rejects the signature or the key is unusable. */
export async function handshake(send: Send, loadKey: () => string): Promise<HandshakeResult> {
  const challenge = await send('get_verify_str', 'verify', STEP_TIMEOUT_MS);
  const str = (challenge.result as { str?: unknown } | undefined)?.str;
  if (challenge.code === NO_HANDSHAKE_CODE || typeof str !== 'string' || !str) return { required: false, verified: false };
  const pem = loadKey();
  const reply = await send('verify_client', { sign: signChallenge(pem, str), data: str }, STEP_TIMEOUT_MS);
  if (reply.code && reply.code !== 0) throw new Error(`the Seestar rejected the handshake (verify_client code ${reply.code}): SEESTAR_KEY_PATH holds the wrong key`);
  await send('pi_is_verified', 'verify', STEP_TIMEOUT_MS).catch(() => undefined);
  return { required: true, verified: true };
}
