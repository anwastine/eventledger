// Password hashing + token vault using WebCrypto (PBKDF2 + AES-GCM).
const Crypto = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  async function deriveBits(password, salt, iter) {
    const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
    return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, 256);
  }
  async function deriveKey(password, salt, iter) {
    const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // Password record stored inside data.json so any device can verify it.
  async function makeAuth(password) {
    const salt = rand(16), iter = 150000;
    const bits = await deriveBits(password, salt, iter);
    return { salt: b64(salt), iter, hash: b64(bits) };
  }
  async function verifyAuth(password, auth) {
    if (!auth) return false;
    const bits = await deriveBits(password, unb64(auth.salt), auth.iter);
    return b64(bits) === auth.hash;
  }

  // Vault: encrypt an arbitrary string (the GitHub token) under the password.
  async function seal(password, plaintext) {
    const salt = rand(16), iv = rand(12), iter = 150000;
    const key = await deriveKey(password, salt, iter);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
    return { salt: b64(salt), iv: b64(iv), iter, ct: b64(ct) };
  }
  async function open(password, vault) {
    const key = await deriveKey(password, unb64(vault.salt), vault.iter);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.ct));
    return dec.decode(pt);
  }
  return { makeAuth, verifyAuth, seal, open };
})();
