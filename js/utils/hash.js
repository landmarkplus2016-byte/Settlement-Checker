/**
 * hash.js — SHA-256 in the browser (CLAUDE.md 4.3, rule 7).
 *
 * A plain-text password never leaves this function. Auth.gs rejects anything
 * that is not a 64-character lowercase hex digest, so the two ends agree.
 */

/**
 * SHA-256 of a string, as lowercase hex.
 *
 * WebCrypto only exists in a secure context — https:// or localhost. GitHub
 * Pages is https, so this holds in production; opening index.html over file://
 * is what trips it, and the thrown reason says so.
 *
 * @param {string} text
 * @return {Promise<string>} 64 lowercase hex characters.
 * @throws {Error} 'insecure_context' when WebCrypto is unavailable.
 */
export async function sha256Hex(text) {
  if (!window.crypto || !window.crypto.subtle) {
    const err = new Error('insecure_context');
    err.code = 'insecure_context';
    throw err;
  }

  const bytes = new TextEncoder().encode(String(text));
  const digest = await window.crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map(function (b) { return b.toString(16).padStart(2, '0'); })
    .join('');
}
