import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  composeProjectLocalPrompt,
  prepareProjectLocalExchange,
  updateProjectLocalExchangeStatus
} from "../hco/project-local-exchange.js";

function digest(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sourceManifest(inputPath, inputText) {
  return {
    input: [{
      artifactId: "request",
      path: inputPath,
      kind: "document",
      mimeType: "text/markdown",
      maxBytes: 4096,
      sha256: digest(inputText)
    }],
    output: [
      {
        artifactId: "result",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 4096,
        required: true
      },
      {
        artifactId: "evidence",
        kind: "evidence",
        mimeType: "application/json",
        maxBytes: 4096,
        required: false
      }
    ]
  };
}

test("project-local exchange uses a unique HCO directory and hides caller-selected paths from Codex", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-"));
  mkdirSync(path.join(root, "docs"));
  const inputText = "# Request\nUse the generated exchange.\n";
  writeFileSync(path.join(root, "docs", "request.md"), inputText);

  const exchange = prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha.project",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: sourceManifest("docs/request.md", inputText),
    contextText: "Instruction:\nImplement the requested change.",
    taskContract: { instruction: "Implement the requested change.", acceptanceCriteria: ["Tests pass."] },
    now: () => 1_700_000_000_000
  });

  assert.equal(exchange.relativeRoot, ".hco/exchanges/v1/work-001/exchange-001");
  assert.deepEqual(exchange.artifacts.output.map((entry) => entry.path), [
    ".hco/exchanges/v1/work-001/exchange-001/output/result.md",
    ".hco/exchanges/v1/work-001/exchange-001/output/evidence.json"
  ]);
  const context = readFileSync(path.join(exchange.absoluteRoot, "input", "context.md"), "utf8");
  const contract = readFileSync(path.join(exchange.absoluteRoot, "input", "task-contract.json"), "utf8");
  const prompt = composeProjectLocalPrompt(exchange);
  assert.match(context, /Use the generated exchange\./u);
  assert.doesNotMatch(context, /docs\/request\.md/u);
  assert.doesNotMatch(contract, /caller\/chosen/u);
  assert.doesNotMatch(prompt, /caller\/chosen/u);
  assert.match(prompt, /output\/result\.md/u);
  assert.equal(JSON.parse(readFileSync(path.join(exchange.absoluteRoot, "status.json"), "utf8")).state, "READY");
  assert.equal(updateProjectLocalExchangeStatus([
    { baseDir: root, path: exchange.artifacts.output[0].path }
  ], { state: "AVAILABLE", now: () => 1_700_000_000_001 }), true);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(exchange.absoluteRoot, "status.json"), "utf8")),
    {
      schemaVersion: 1,
      exchangeMode: "project_local/v1",
      workId: "work-001",
      exchangeId: "exchange-001",
      projectId: "alpha.project",
      state: "AVAILABLE",
      updatedAtMs: 1_700_000_000_001
    }
  );
});

test("project-local retries allocate a fresh directory and never overwrite an existing exchange", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-retry-"));
  const manifest = { input: [], output: [] };
  const common = {
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    sourceManifest: manifest,
    contextText: "Instruction:\nInspect the project.",
    taskContract: { instruction: "Inspect the project." },
    now: () => 1_700_000_000_000
  };
  const first = prepareProjectLocalExchange({ ...common, exchangeIdFactory: () => "exchange-001" });
  const ids = ["exchange-001", "exchange-002"];
  const second = prepareProjectLocalExchange({ ...common, exchangeIdFactory: () => ids.shift() });

  assert.equal(second.exchangeId, "exchange-002");
  assert.notEqual(first.absoluteRoot, second.absoluteRoot);
  assert.equal(JSON.parse(readFileSync(path.join(first.absoluteRoot, "status.json"), "utf8")).exchangeId, "exchange-001");
});

test("project-local exchange rejects a symlinked control directory", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-link-"));
  const outside = mkdtempSync(path.join(tmpdir(), "hco-project-local-outside-"));
  try {
    symlinkSync(outside, path.join(root, ".hco"), "dir");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("directory symlinks are unavailable on this host");
      return;
    }
    throw error;
  }

  assert.throws(() => prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: { input: [], output: [] },
    contextText: "Instruction:\nInspect the project.",
    taskContract: { instruction: "Inspect the project." },
    now: () => 1_700_000_000_000
  }), { code: "PROJECT_LOCAL_EXCHANGE_UNAVAILABLE" });
  assert.equal(existsSync(path.join(outside, "exchanges")), false);
});

test("project-local exchange rejects unsupported document MIME types before starting Codex", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-mime-"));
  writeFileSync(path.join(root, "input.bin"), Buffer.from([0, 1, 2]));
  assert.throws(() => prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: {
      input: [{
        artifactId: "binary",
        path: "input.bin",
        kind: "document",
        mimeType: "application/octet-stream",
        maxBytes: 16
      }],
      output: []
    },
    contextText: "Instruction:\nInspect the document.",
    taskContract: { instruction: "Inspect the document." },
    now: () => 1_700_000_000_000
  }), { code: "PROJECT_LOCAL_INPUT_INVALID" });
});

test("project-local exchange adds only a repository-local Git ignore rule", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-git-"));
  try {
    execFileSync("git", ["init", "--quiet", root], { stdio: "ignore", timeout: 2_000 });
  } catch {
    t.skip("Git is unavailable on this host");
    return;
  }
  prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: { input: [], output: [] },
    contextText: "Instruction:\nInspect the project.",
    taskContract: { instruction: "Inspect the project." },
    now: () => 1_700_000_000_000
  });

  assert.match(readFileSync(path.join(root, ".git", "info", "exclude"), "utf8"), /^\/\.hco\/exchanges\/$/mu);
  assert.equal(existsSync(path.join(root, ".gitignore")), false);
});

test("project-local output names are generated by HCO and ignore deprecated caller paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-output-names-"));
  const exchange = prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: {
      input: [],
      output: [
        {
          artifactId: "summary",
          path: "caller/chosen-summary.md",
          kind: "document",
          mimeType: "text/markdown",
          maxBytes: 1024,
          required: true
        },
        {
          artifactId: "details",
          path: "caller/chosen-details.md",
          kind: "document",
          mimeType: "text/markdown",
          maxBytes: 1024,
          required: false
        },
        {
          artifactId: "evidence",
          path: "caller/chosen-evidence.json",
          kind: "evidence",
          mimeType: "application/json",
          maxBytes: 1024,
          required: true
        },
        {
          artifactId: "metadata",
          path: "caller/chosen-metadata.json",
          kind: "metadata",
          mimeType: "application/json",
          maxBytes: 1024,
          required: false
        }
      ]
    },
    contextText: "Instruction:\nWrite the declared outputs.",
    taskContract: { instruction: "Write the declared outputs." },
    now: () => 1_700_000_000_000
  });

  assert.deepEqual(exchange.artifacts.output.map((entry) => entry.path), [
    ".hco/exchanges/v1/work-001/exchange-001/output/result.md",
    ".hco/exchanges/v1/work-001/exchange-001/output/result-002.md",
    ".hco/exchanges/v1/work-001/exchange-001/output/evidence.json",
    ".hco/exchanges/v1/work-001/exchange-001/output/evidence-002.json"
  ]);
  const contract = JSON.parse(readFileSync(
    path.join(exchange.absoluteRoot, "input", "task-contract.json"),
    "utf8"
  ));
  assert.deepEqual(contract.outputs.map((entry) => entry.fileName), [
    "result.md",
    "result-002.md",
    "evidence.json",
    "evidence-002.json"
  ]);
  assert.doesNotMatch(JSON.stringify(contract), /caller\/chosen/u);
  assert.doesNotMatch(composeProjectLocalPrompt(exchange), /caller\/chosen/u);
});

test("project-local exchange rejects output declarations beyond the fixed file budget before allocation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-file-limit-"));
  const output = Array.from({ length: 7 }, (_, index) => ({
    artifactId: `result-${index + 1}`,
    kind: "document",
    mimeType: "text/markdown",
    maxBytes: 1024,
    required: true
  }));

  assert.throws(() => prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: { input: [], output },
    contextText: "Instruction:\nToo many outputs.",
    taskContract: { instruction: "Too many outputs." },
    now: () => 1_700_000_000_000
  }), { code: "PROJECT_LOCAL_OUTPUT_INVALID" });
  assert.equal(existsSync(path.join(root, ".hco")), false);
});

test("project-local exchange rejects declared output budgets above the total exchange limit", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-byte-limit-"));
  const output = Array.from({ length: 6 }, (_, index) => ({
    artifactId: `result-${index + 1}`,
    kind: "document",
    mimeType: "text/markdown",
    maxBytes: 11 * 1024 * 1024,
    required: true
  }));

  assert.throws(() => prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: { input: [], output },
    contextText: "Instruction:\nThe declared budget is too large.",
    taskContract: { instruction: "The declared budget is too large." },
    now: () => 1_700_000_000_000
  }), { code: "PROJECT_LOCAL_INPUT_INVALID" });
  assert.equal(existsSync(path.join(root, ".hco")), false);
});

test("project-local exchange rejects invalid UTF-8 source documents before starting Codex", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-utf8-"));
  const inputPath = path.join(root, "request.md");
  const invalidBytes = Buffer.from([0xc3, 0x28]);
  writeFileSync(inputPath, invalidBytes);

  assert.throws(() => prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: {
      input: [{
        artifactId: "request",
        path: "request.md",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 1024,
        sha256: digest(invalidBytes)
      }],
      output: []
    },
    contextText: "Instruction:\nRead the request.",
    taskContract: { instruction: "Read the request." },
    now: () => 1_700_000_000_000
  }), { code: "PROJECT_LOCAL_INPUT_INVALID" });
  assert.equal(existsSync(path.join(root, ".hco")), false);
});

test("project-local exchange rejects source symlinks even when the target stays inside the project", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-input-link-"));
  const targetPath = path.join(root, "real-request.md");
  const linkPath = path.join(root, "request.md");
  const inputText = "trusted request\n";
  writeFileSync(targetPath, inputText);
  try {
    symlinkSync(targetPath, linkPath, "file");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      t.skip("file symlinks are unavailable on this host");
      return;
    }
    throw error;
  }

  assert.throws(() => prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: {
      input: [{
        artifactId: "request",
        path: "request.md",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 1024,
        sha256: digest(inputText)
      }],
      output: []
    },
    contextText: "Instruction:\nRead the request.",
    taskContract: { instruction: "Read the request." },
    now: () => 1_700_000_000_000
  }), { code: "ARTIFACT_INPUT_INVALID" });
});

test("project-local exchange collision exhaustion preserves the existing exchange", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-collision-"));
  const common = {
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    sourceManifest: { input: [], output: [] },
    contextText: "Instruction:\nKeep the first exchange.",
    taskContract: { instruction: "Keep the first exchange." },
    now: () => 1_700_000_000_000
  };
  const first = prepareProjectLocalExchange({ ...common, exchangeIdFactory: () => "exchange-001" });

  assert.throws(() => prepareProjectLocalExchange({
    ...common,
    exchangeIdFactory: () => "exchange-001"
  }), { code: "PROJECT_LOCAL_EXCHANGE_UNAVAILABLE" });
  assert.equal(
    JSON.parse(readFileSync(path.join(first.absoluteRoot, "status.json"), "utf8")).exchangeId,
    "exchange-001"
  );
  assert.equal(existsSync(path.join(first.absoluteRoot, "input", "context.md")), true);
});

test("project-local status updates are atomic, reject tampered identity, and clear stale errors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hco-project-local-status-"));
  const exchange = prepareProjectLocalExchange({
    canonicalRoot: root,
    projectId: "alpha",
    workId: "work-001",
    exchangeIdFactory: () => "exchange-001",
    sourceManifest: {
      input: [],
      output: [{
        artifactId: "result",
        kind: "document",
        mimeType: "text/markdown",
        maxBytes: 1024,
        required: true
      }]
    },
    contextText: "Instruction:\nUpdate status.",
    taskContract: { instruction: "Update status." },
    now: () => 1_700_000_000_000
  });
  const statusPath = path.join(exchange.absoluteRoot, "status.json");
  const row = { baseDir: root, path: exchange.artifacts.output[0].path };

  assert.equal(updateProjectLocalExchangeStatus([row], {
    state: "ERROR",
    errorCode: "PROJECT_LOCAL_OUTPUT_MISSING",
    now: () => 1_700_000_000_001
  }), true);
  assert.deepEqual(JSON.parse(readFileSync(statusPath, "utf8")), {
    schemaVersion: 1,
    exchangeMode: "project_local/v1",
    workId: "work-001",
    exchangeId: "exchange-001",
    projectId: "alpha",
    state: "ERROR",
    updatedAtMs: 1_700_000_000_001,
    errorCode: "PROJECT_LOCAL_OUTPUT_MISSING"
  });

  assert.equal(updateProjectLocalExchangeStatus([row], {
    state: "AVAILABLE",
    now: () => 1_700_000_000_002
  }), true);
  const available = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(available.state, "AVAILABLE");
  assert.equal(Object.hasOwn(available, "errorCode"), false);

  writeFileSync(statusPath, JSON.stringify({
    schemaVersion: 1,
    exchangeMode: "project_local/v1",
    workId: "work-001",
    exchangeId: "other-exchange",
    projectId: "alpha",
    state: "AVAILABLE",
    updatedAtMs: 1_700_000_000_002
  }));
  assert.equal(updateProjectLocalExchangeStatus([row], {
    state: "ERROR",
    errorCode: "PROJECT_LOCAL_OUTPUT_INVALID",
    now: () => 1_700_000_000_003
  }), false);
  assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).exchangeId, "other-exchange");
});
