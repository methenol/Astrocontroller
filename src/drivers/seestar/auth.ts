/**
 * The firmware 7.18+ handshake on the control port, run right after the TCP connect:
 *
 *   get_verify_str ("verify")             → {result: {str: challenge}}   (code 103 on older firmware: no handshake)
 *   verify_client {sign, data: challenge} → code 0                       sign = base64(RSA-SHA1 PKCS#1 v1.5 of the challenge)
 *   pi_is_verified ("verify")             → code 0                       (a non-zero code is tolerated, as the official app does)
 *
 * The key is the official app's own, the same for every scope. It is not shipped here: point
 * SEESTAR_KEY_PATH at the PEM you extracted from your copy of the app (see seestarpy's extract_pem).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { logger } from '../../log.js';
import type { RpcResponse } from './rpc.js';

const log = logger('seestar');

const STEP_TIMEOUT_MS = 10_000;
/** "method not found": firmware before 7.18 */
const NO_SUCH_METHOD = 103;

export interface HandshakeResult {
  /** the scope asked for it (firmware 7.18+) */
  required: boolean;
  verified: boolean;
}

export type Send = (method: string, params: unknown, timeoutMs: number) => Promise<RpcResponse>;

export function signChallenge(pem: string, challenge: string): string {
  return crypto.sign('sha1', Buffer.from(challenge, 'utf8'), { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
}

/** The PEM at `path`, or null when no path is configured; a configured path that cannot be read throws. */
export function readKey(path: string): string | null {
  if (!path) return null;
  const pem = fs.readFileSync(path, 'utf8');
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) throw new Error(`${path} holds no PEM private key`);
  return pem;
}

export async function handshake(send: Send, loadKey: () => string | null): Promise<HandshakeResult> {
  const challengeReply = await send('get_verify_str', 'verify', STEP_TIMEOUT_MS);
  if (challengeReply.code === NO_SUCH_METHOD) return { required: false, verified: false };
  const result = challengeReply.result;
  const challenge = result && typeof result === 'object' ? (result as { str?: unknown }).str : result;
  if (challengeReply.code !== 0 || typeof challenge !== 'string' || challenge === '') {
    // no challenge to sign: a firmware that does not ask for it
    log.debug(`get_verify_str answered code ${challengeReply.code} without a challenge: no handshake`);
    return { required: false, verified: false };
  }

  const key = loadKey();
  if (!key) {
    throw new Error('this Seestar firmware (7.18+) requires the client handshake: set SEESTAR_KEY_PATH to the PEM key extracted from the official Seestar app');
  }
  const verify = await send('verify_client', { sign: signChallenge(key, challenge), data: challenge }, STEP_TIMEOUT_MS);
  if (verify.code !== 0) {
    throw new Error(`the Seestar rejected the handshake signature (verify_client code ${verify.code}${verify.error ? `: ${String(verify.error)}` : ''}): the key in SEESTAR_KEY_PATH does not match this firmware`);
  }
  const confirmed = await send('pi_is_verified', 'verify', STEP_TIMEOUT_MS);
  if (confirmed.code !== 0) log.warn(`pi_is_verified answered code ${confirmed.code}: carrying on, as the official app does`);
  return { required: true, verified: true };
}
