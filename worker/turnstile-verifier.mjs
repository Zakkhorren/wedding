/** Server-side Turnstile building block; intentionally not wired to the old relay. */
export class TurnstileError extends Error {
  constructor(code) { super(code); this.name = 'TurnstileError'; this.code = code; }
}
export async function verifyTurnstile({token, secret, hostname, action='rsvp', remoteIp, verificationId=crypto.randomUUID(), fetcher=fetch}) {
  if (!secret || !hostname) throw new TurnstileError('TURNSTILE_NOT_CONFIGURED');
  if (typeof token !== 'string' || !token || token.length > 2048) throw new TurnstileError('TURNSTILE_RETRY');
  if (!/^[0-9a-f-]{36}$/i.test(verificationId)) throw new TurnstileError('TURNSTILE_NOT_CONFIGURED');
  const body = new URLSearchParams({secret,response:token,idempotency_key:verificationId});
  if (remoteIp) body.set('remoteip',remoteIp);
  let response, result;
  try {
    response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {method:'POST',body,signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch { throw new TurnstileError('TURNSTILE_UNAVAILABLE'); }
  if (result.success !== true || result.hostname !== hostname || result.action !== action) throw new TurnstileError('TURNSTILE_RETRY');
  return true;
}
