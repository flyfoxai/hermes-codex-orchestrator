import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

const MAX_TOKEN_BYTES = 4096;
const OWNED_ERRORS = new WeakSet();

export function bridgeError(code, message) {
  const error = new Error(message);
  error.code = code;
  OWNED_ERRORS.add(error);
  return error;
}

export function isBridgeError(error) {
  return error !== null && (typeof error === "object" || typeof error === "function") && OWNED_ERRORS.has(error);
}

function invalidTokenFile() {
  return bridgeError("BRIDGE_TOKEN_INVALID", "Bridge token file is invalid.");
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function createBearerAuthenticatorFromToken(token) {
  if (!(Buffer.isBuffer(token) || token instanceof Uint8Array)) throw invalidTokenFile();
  const tokenBytes = Buffer.from(token);
  if (
    tokenBytes.length < 1 ||
    tokenBytes.length > MAX_TOKEN_BYTES ||
    !/^[\x21-\x7e]+$/u.test(tokenBytes.toString("latin1"))
  ) {
    throw invalidTokenFile();
  }

  const expectedDigest = digest(`Bearer ${tokenBytes.toString("ascii")}`);
  return Object.freeze({
    authenticate(authorization) {
      const candidate = typeof authorization === "string" ? authorization : "";
      return timingSafeEqual(expectedDigest, digest(candidate));
    }
  });
}

export function createBearerAuthenticator(tokenPath) {
  let descriptor;
  let status;
  let tokenBytes;
  try {
    descriptor = openSync(tokenPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    status = fstatSync(descriptor);
    if (!status.isFile() || (status.mode & 0o077) !== 0 || status.size < 1 || status.size > MAX_TOKEN_BYTES) {
      throw invalidTokenFile();
    }
    tokenBytes = readFileSync(descriptor);
  } catch (error) {
    if (isBridgeError(error)) throw error;
    throw invalidTokenFile();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }

  return createBearerAuthenticatorFromToken(tokenBytes);
}
