import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";

import {
  digestOwnerReceipt,
  fileExchangeError,
  signOwnerReceipt,
  verifyOwnerReceipt
} from "./contracts.js";

function fail(code, message) {
  throw fileExchangeError(code, message);
}

function text(value, maximum = 512) {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

async function secureControlDirectory(directory) {
  if (!path.isAbsolute(directory)) fail("FILE_BROKER_LOCK_INVALID", "File broker lock directory is invalid.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const status = await lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink() ||
      (process.platform !== "win32" && (status.mode & 0o077) !== 0)) {
    fail("FILE_BROKER_LOCK_INVALID", "File broker lock directory is not owner-only.");
  }
  const canonical = await realpath(directory);
  if (Buffer.byteLength(canonical, "utf8") <= 70) return canonical;
  const shortRoot = path.join("/tmp", "hco-fb");
  const shortDirectory = path.join(shortRoot, createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16));
  await mkdir(shortRoot, { recursive: true, mode: 0o700 });
  const shortRootStatus = await lstat(shortRoot);
  if (!shortRootStatus.isDirectory() || shortRootStatus.isSymbolicLink() ||
      (process.platform !== "win32" && (shortRootStatus.mode & 0o077) !== 0)) {
    fail("FILE_BROKER_LOCK_INVALID", "Short broker lock root is invalid.");
  }
  await mkdir(shortDirectory, { recursive: true, mode: 0o700 });
  await chmod(shortRoot, 0o700).catch(() => undefined);
  await chmod(shortDirectory, 0o700);
  const shortStatus = await lstat(shortDirectory);
  if (!shortStatus.isDirectory() || shortStatus.isSymbolicLink()) fail("FILE_BROKER_LOCK_INVALID", "Short broker lock directory is invalid.");
  return realpath(shortDirectory);
}

async function removeStaleSocket(identity) {
  if (process.platform === "win32") return false;
  let status;
  try {
    status = await lstat(identity);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
  if (!status.isSocket() || status.isSymbolicLink()) return false;
  await unlink(identity).catch(() => undefined);
  return true;
}

function socketIdentity(controlDirectory, workId) {
  const digest = createHash("sha256").update(workId, "utf8").digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\hco-file-broker-${digest}`;
  const socketPath = path.join(controlDirectory, `${digest}.sock`);
  if (Buffer.byteLength(socketPath, "utf8") > 100) {
    fail("FILE_BROKER_LOCK_PATH_TOO_LONG", "File broker lock path exceeds the local socket budget.");
  }
  return socketPath;
}

function listen(server, identity) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(identity);
  });
}

function probe(identity) {
  return new Promise((resolve) => {
    const socket = createConnection(identity);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function createProcessOwnerLockManager({
  controlDirectory,
  receiptKey,
  receiptKeyId = "hco-owner-lock-v1",
  now = Date.now,
  processInstanceId = `process-${randomBytes(16).toString("hex")}`
} = {}) {
  if (!path.isAbsolute(controlDirectory) ||
      (!Buffer.isBuffer(receiptKey) && typeof receiptKey !== "string") || Buffer.byteLength(receiptKey) < 32 ||
      !text(receiptKeyId, 128) || !text(processInstanceId) || typeof now !== "function") {
    fail("FILE_BROKER_LOCK_INVALID", "File broker lock manager options are invalid.");
  }
  const held = new Map();

  async function acquire(workId) {
    if (!text(workId)) fail("FILE_BROKER_LOCK_INVALID", "File broker work ID is invalid.");
    const existing = held.get(workId);
    if (existing?.active) return existing.publicLock;
    const canonicalControlDirectory = await secureControlDirectory(controlDirectory);
    const identity = socketIdentity(canonicalControlDirectory, workId);
    let server = createServer((socket) => socket.destroy());
    try {
      await listen(server, identity);
    } catch (error) {
      if (error?.code !== "EADDRINUSE" || await probe(identity)) {
        fail("FILE_BROKER_LOCK_BUSY", "Another process owns the file broker lock.");
      }
      if (!(await removeStaleSocket(identity))) {
        fail("FILE_BROKER_LOCK_BUSY", "The file broker lock path is occupied by an unknown object.");
      }
      server = createServer((socket) => socket.destroy());
      try {
        await listen(server, identity);
      } catch {
        fail("FILE_BROKER_LOCK_BUSY", "Another process acquired the file broker lock.");
      }
    }
    if (process.platform !== "win32") await chmod(identity, 0o600);
    const acquiredAt = now();
    if (!Number.isSafeInteger(acquiredAt) || acquiredAt < 0) {
      await closeServer(server).catch(() => undefined);
      fail("STORE_CLOCK_INVALID", "File broker lock clock is invalid.");
    }
    const ownerLockToken = randomBytes(32).toString("hex");
    const receipt = signOwnerReceipt({
      work_id: workId,
      lock_identity: identity,
      owner_lock_token_digest: createHash("sha256").update(ownerLockToken, "utf8").digest("hex"),
      process_instance_id: processInstanceId,
      acquired_at: acquiredAt
    }, { key: receiptKey, keyId: receiptKeyId });
    const record = { active: true, server, identity, ownerLockToken, receipt };
    server.once("close", () => { record.active = false; });
    const publicLock = Object.freeze({
      workId,
      ownerLockToken,
      receipt,
      receiptDigest: digestOwnerReceipt(receipt).digest,
      async assertHeld(fence) {
        return record.active === true && held.get(workId) === record &&
          fence?.workId === workId && fence?.ownerLockToken === ownerLockToken;
      },
      async release() {
        if (held.get(workId) !== record) return;
        held.delete(workId);
        record.active = false;
        await closeServer(server).catch(() => undefined);
      }
    });
    record.publicLock = publicLock;
    held.set(workId, record);
    return publicLock;
  }

  return Object.freeze({
    acquire,
    assertReceipt(receipt, options = {}) {
      return verifyOwnerReceipt(receipt, {
        key: receiptKey,
        expectedKeyId: receiptKeyId,
        ...options
      });
    },
    async close() {
      await Promise.all([...held.values()].map((record) => record.publicLock.release()));
    }
  });
}
