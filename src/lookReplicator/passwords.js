const { randomBytes, scrypt: scryptCb, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(scryptCb);

function b64(buf) {
  return Buffer.from(buf).toString("base64");
}

function b64ToBuf(s) {
  return Buffer.from(String(s || ""), "base64");
}

async function hashPassword(password) {
  const pwd = String(password || "");
  if (!pwd) throw new Error("PASSWORD_EMPTY");

  const salt = randomBytes(16);
  // Reasonable default for server-side auth without extra deps.
  const N = 16384;
  const r = 8;
  const p = 1;
  const keyLen = 64;

  const hash = await scrypt(pwd, salt, keyLen, { N, r, p });
  // Format: scrypt$N$r$p$saltB64$hashB64
  return `scrypt$${N}$${r}$${p}$${b64(salt)}$${b64(hash)}`;
}

async function verifyPassword(password, stored) {
  const pwd = String(password || "");
  const raw = String(stored || "");
  if (!pwd || !raw) return false;

  const parts = raw.split("$");
  if (parts.length !== 6) return false;
  const [algo, nStr, rStr, pStr, saltB64, hashB64] = parts;
  if (algo !== "scrypt") return false;

  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = b64ToBuf(saltB64);
  const expected = b64ToBuf(hashB64);
  if (!salt.length || !expected.length) return false;

  const actual = await scrypt(pwd, salt, expected.length, { N, r, p });
  try {
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
};

