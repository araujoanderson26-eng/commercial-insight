import { randomBytes, scrypt as derive, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(derive);
function compute(value, salt) {
  return scrypt(value, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
}
export async function passwordHash(value) {
  const salt = randomBytes(16).toString("hex");
  const key = await compute(value, salt);
  return ["s1", salt, key.toString("hex")].join(":");
}
const dummy = "s1:0123456789abcdef0123456789abcdef:" + "0".repeat(64);
export async function passwordOK(value, encoded) {
  const [version, salt, key] = (encoded || dummy).split(":");
  if (version !== "s1" || !salt || key?.length !== 64) return false;
  const actual = await compute(value, salt);
  return timingSafeEqual(actual, Buffer.from(key, "hex")) && !!encoded;
}
