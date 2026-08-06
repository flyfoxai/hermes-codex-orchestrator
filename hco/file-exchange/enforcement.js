import {
  UNSUPPORTED_FILE_EXCHANGE_CAPABILITY,
  fileExchangeError,
  normalizeFileExchangeCapability,
  requireManagedFileExchangeCapability,
  signSealReceipt,
  verifySealReceipt
} from "./contracts.js";

const METHODS = Object.freeze([
  "getCapability",
  "prepareFileAttempt",
  "sealFileAttempt",
  "revokeFileAttempt",
  "verifyFileAttemptSealReceipt",
  "getSealedUploadDirectory",
  "openSealedUploadFile"
]);

export function createUnsupportedFileExchangeEnforcement() {
  function unsupported() {
    throw fileExchangeError(
      "FILE_EXCHANGE_UNSUPPORTED",
      "Execution transport does not enforce managed file exchange."
    );
  }
  return Object.freeze({
    getCapability: () => UNSUPPORTED_FILE_EXCHANGE_CAPABILITY,
    prepareFileAttempt: unsupported,
    sealFileAttempt: unsupported,
    revokeFileAttempt: unsupported,
    verifyFileAttemptSealReceipt: unsupported,
    getSealedUploadDirectory: unsupported,
    openSealedUploadFile: unsupported
  });
}

export function createSealReceiptAuthority({ key, keyId = "hco-file-seal-v1" } = {}) {
  if ((!Buffer.isBuffer(key) && typeof key !== "string") || Buffer.byteLength(key) < 32 ||
      typeof keyId !== "string" || keyId.length === 0 || Buffer.byteLength(keyId, "utf8") > 128) {
    throw fileExchangeError("FILE_EXCHANGE_ENFORCEMENT_INVALID", "Seal receipt authority is invalid.");
  }
  return Object.freeze({
    sign(fields) {
      return signSealReceipt(fields, { key, keyId });
    },
    verify(receipt, { sealCommandId } = {}) {
      return verifySealReceipt(receipt, { key, expectedKeyId: keyId, sealCommandId });
    }
  });
}

export function validateFileExchangeEnforcement(adapter) {
  if (adapter === null || typeof adapter !== "object" ||
      METHODS.some((method) => typeof adapter[method] !== "function")) {
    throw fileExchangeError("FILE_EXCHANGE_ENFORCEMENT_INVALID", "File exchange enforcement adapter is invalid.");
  }
  requireManagedFileExchangeCapability(adapter.getCapability());
  return adapter;
}

export function fileExchangeCapabilityOf(adapter) {
  if (adapter === undefined || adapter === null) return UNSUPPORTED_FILE_EXCHANGE_CAPABILITY;
  if (typeof adapter.getCapability !== "function") {
    throw fileExchangeError("FILE_EXCHANGE_ENFORCEMENT_INVALID", "File exchange enforcement adapter is invalid.");
  }
  return normalizeFileExchangeCapability(adapter.getCapability());
}

export async function confirmManagedFileAttemptSeal({
  store,
  enforcement,
  sealCommandId,
  fileAttemptId,
  receipt,
  epoch,
  ownerLockToken
} = {}) {
  const adapter = validateFileExchangeEnforcement(enforcement);
  if (!store || typeof store.readFileAttemptBinding !== "function" ||
      typeof store.confirmVerifiedFileAttemptSeal !== "function") {
    throw fileExchangeError("FILE_EXCHANGE_STORE_INVALID", "Managed file exchange store is invalid.");
  }
  const binding = store.readFileAttemptBinding(fileAttemptId);
  if (!binding) throw fileExchangeError("FILE_ATTEMPT_NOT_FOUND", "File attempt does not exist.");
  const verifiedReceipt = await adapter.verifyFileAttemptSealReceipt({
    sealCommandId,
    binding,
    receipt
  });
  return store.confirmVerifiedFileAttemptSeal({
    sealCommandId,
    receipt: verifiedReceipt,
    epoch,
    ownerLockToken
  });
}
