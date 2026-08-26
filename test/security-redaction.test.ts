import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  CredentialTooShortError,
  CredentialWhitespaceError,
  clearSecrets,
  redactSecrets,
  registerResolvedSecret,
  registerSecret,
  sanitizeError,
} from "../src/security.ts";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function resetSecrets(): void {
  clearSecrets();
}

test("registerResolvedSecret rejects undefined, null and empty values as unresolved", () => {
  resetSecrets();
  assert.equal(registerResolvedSecret(undefined), undefined);
  assert.equal(registerResolvedSecret(null), undefined);
  assert.equal(registerResolvedSecret(""), undefined);
  assert.equal(redactSecrets("secret"), "secret", "nothing registered, nothing redacted");
  resetSecrets();
});

test("whitespace-only credentials are rejected fail-closed", () => {
  resetSecrets();
  assert.throws(() => registerResolvedSecret("   "), CredentialWhitespaceError);
  resetSecrets();
});

test("1-character credentials are rejected fail-closed and never registered", () => {
  resetSecrets();
  assert.throws(() => registerResolvedSecret("a"), CredentialTooShortError);
  assert.equal(redactSecrets("a"), "a", "nothing registered, nothing redacted");
  resetSecrets();
});

test("2-character credentials are rejected fail-closed and never registered", () => {
  resetSecrets();
  assert.throws(() => registerResolvedSecret("ab"), CredentialTooShortError);
  assert.equal(redactSecrets("ab"), "ab", "short values are never globally redacted");
  resetSecrets();
});

test("3-character credentials are rejected fail-closed and never registered", () => {
  resetSecrets();
  assert.throws(() => registerResolvedSecret("abc"), CredentialTooShortError);
  assert.equal(redactSecrets("abc"), "abc", "short values are never globally redacted");
  resetSecrets();
});

test("4-character credentials register normally and redact", () => {
  resetSecrets();
  const value = registerResolvedSecret("abcd");
  assert.equal(value, "abcd");
  assert.equal(redactSecrets("abcd"), "[REDACTED]");
  resetSecrets();
});

test("too-short rejection names the credential ref but never the value", () => {
  resetSecrets();
  assert.throws(
    () => registerResolvedSecret("abc", { credentialName: "MY_API_KEY" }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(message.includes("MY_API_KEY"), "credential ref appears in the error");
      assert.ok(message.includes("too short"), "reason appears in the error");
      assert.ok(!message.includes("abc"), "the secret value must never appear");
      return true;
    },
  );
  assert.throws(() => registerResolvedSecret("abc"), /Refusing to use a credential shorter than 4 characters/);
  resetSecrets();
});

test("whitespace-padded credentials are rejected regardless of trimmed length", () => {
  resetSecrets();
  assert.throws(() => registerResolvedSecret(" abc "), CredentialWhitespaceError, "short padded value");
  assert.throws(() => registerResolvedSecret(" secretvalue "), CredentialWhitespaceError, "long padded value");
  resetSecrets();
});

test("whitespace rejection registers raw AND trimmed values before throwing (defense in depth)", () => {
  resetSecrets();
  assert.throws(() => registerResolvedSecret(" secretvalue "), CredentialWhitespaceError);
  assert.equal(redactSecrets(" secretvalue "), "[REDACTED]", "raw padded value is redactable");
  assert.equal(redactSecrets("secretvalue"), "[REDACTED]", "trimmed value is redactable even though it was never sent");
  resetSecrets();
});

test("whitespace rejection names only the credential ref, never the value", () => {
  resetSecrets();
  assert.throws(
    () => registerResolvedSecret(" secretvalue ", { credentialName: "MY_API_KEY" }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(message.includes("MY_API_KEY"), "credential ref appears in the error");
      assert.ok(message.includes("whitespace"), "reason appears in the error");
      assert.ok(!message.includes("secretvalue"), "neither the raw nor the trimmed value may appear");
      assert.ok(!message.includes(" secretvalue "), "raw value must never appear");
      return true;
    },
  );
  resetSecrets();
});

test("all whitespace variants are rejected fail-closed at the boundary", () => {
  resetSecrets();
  for (const value of [" secretvalue ", "secretvalue ", " secretvalue", "\tsecretvalue", "secretvalue\n"]) {
    assert.throws(
      () => registerResolvedSecret(value, { credentialName: "MY_API_KEY" }),
      CredentialWhitespaceError,
      `value ${JSON.stringify(value)} must be rejected`,
    );
  }
  assert.throws(() => registerResolvedSecret("\tsecretvalue\n"), CredentialWhitespaceError);
  resetSecrets();
});

test("registerResolvedSecret registers and returns normal values", () => {
  resetSecrets();
  const value = registerResolvedSecret("sk-real-long-secret");
  assert.equal(value, "sk-real-long-secret");
  assert.equal(redactSecrets("sk-real-long-secret"), "[REDACTED]");
  resetSecrets();
});

test("repeated registration is deduplicated", () => {
  resetSecrets();
  registerSecret("dedupe-secret-value");
  registerSecret("dedupe-secret-value");
  assert.equal(redactSecrets("dedupe-secret-value"), "[REDACTED]");
  assert.equal(redactSecrets("dedupe-secret-value again"), "[REDACTED] again");
  resetSecrets();
});

test("multiple registered secrets are all redacted, longest first", () => {
  resetSecrets();
  registerResolvedSecret("short-secret");
  registerResolvedSecret("much-longer-secret-value");
  const text = "much-longer-secret-value contains short-secret";
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes("much-longer-secret-value"));
  assert.ok(!redacted.includes("short-secret"));
  assert.ok(redacted.includes("[REDACTED] contains [REDACTED]"));
  resetSecrets();
});

test("redactSecrets also cleans stack-shaped text and JSON-serialized detail", () => {
  resetSecrets();
  registerResolvedSecret("stack-secret-xyz");
  const stack = `Error: boom with stack-secret-xyz\n    at foo (file:///x:1:1)\n    at bar (file:///y:2:2)`;
  const redactedStack = redactSecrets(stack);
  assert.ok(!redactedStack.includes("stack-secret-xyz"));
  const json = JSON.stringify({ detail: "invalid key stack-secret-xyz" });
  assert.ok(!redactSecrets(json).includes("stack-secret-xyz"));
  resetSecrets();
});

test("sanitizeError redacts registered secrets even inside thrown errors", () => {
  resetSecrets();
  registerResolvedSecret("thrown-secret-value-999");
  const error = new Error("request failed: invalid credential thrown-secret-value-999");
  const safe = sanitizeError(error);
  assert.ok(!safe.includes("thrown-secret-value-999"));
  assert.ok(safe.includes("[REDACTED]"));
  resetSecrets();
});

// ---------- malicious endpoint: echoes the Authorization bearer back ----------

function startEchoSecretEndpoint(): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        const authorization = req.headers.authorization ?? "";
        const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: { message: `invalid credential ${bearer}` } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

const ECHO_SECRET = "arbitrary-secret-value-XYZ123456";

test("generic probe: malicious endpoint echo leaks ZERO secrets into manifest/stdout/stderr", async () => {
  const { server, port } = await startEchoSecretEndpoint();
  try {
    const home = await mkdtemp(join(tmpdir(), "probemux-sec-"));
    const manifestPath = join(home, "manifest.json");
    const env = { ...process.env, PROBEMUX_TEST_KEY: ECHO_SECRET };
    const args = [
      "src/cli.ts", "probe",
      "--base-url", `http://127.0.0.1:${port}/v1`,
      "--provider-id", "fixture",
      "--model", "model-a",
      "--api-key-env", "PROBEMUX_TEST_KEY",
      "--active",
      "--output", manifestPath,
    ];
    const result = await run(process.execPath, args, { cwd: REPO_ROOT, env });
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    assert.ok(!manifestText.includes(ECHO_SECRET), "manifest must not contain the secret");
    assert.ok(manifestText.includes("[REDACTED]"), "manifest should contain the redaction marker");
    assert.ok(!result.stdout.includes(ECHO_SECRET), "stdout must not contain the secret");
    assert.ok(!result.stderr.includes(ECHO_SECRET), "stderr must not contain the secret");
    const details = JSON.stringify(manifest.evidence);
    assert.ok(!details.includes(ECHO_SECRET), "evidence details must not contain the secret");
    assert.ok(details.includes("[REDACTED]"), "evidence details should be redacted");
  } finally {
    server.close();
  }
});

test("generic probe: stdout manifest JSON is also zero-leak when printed", async () => {
  const { server, port } = await startEchoSecretEndpoint();
  try {
    const env = { ...process.env, PROBEMUX_TEST_KEY: ECHO_SECRET };
    const result = await run(process.execPath, [
      "src/cli.ts", "probe",
      "--base-url", `http://127.0.0.1:${port}/v1`,
      "--provider-id", "fixture",
      "--model", "model-a",
      "--api-key-env", "PROBEMUX_TEST_KEY",
      "--active",
    ], { cwd: REPO_ROOT, env });
    assert.ok(!result.stdout.includes(ECHO_SECRET), "stdout JSON must not contain the secret");
    assert.ok(result.stdout.includes("[REDACTED]"), "stdout JSON should contain the redaction marker");
  } finally {
    server.close();
  }
});

// ---------- short credential: fail before network, zero leak ----------

function startEchoSecretEndpointWithCounter(): Promise<{ server: Server; port: number; requestCount: () => number }> {
  return new Promise((resolvePromise) => {
    let count = 0;
    const server = createServer((req, res) => {
      count += 1;
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        const authorization = req.headers.authorization ?? "";
        const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: { message: `invalid credential ${bearer}` } }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({ server, port, requestCount: () => count });
    });
  });
}

const SHORT_SECRET = "abc";

test("short credential: probe fails with exit != 0 and sends ZERO network requests", async () => {
  const { server, port, requestCount } = await startEchoSecretEndpointWithCounter();
  try {
    const home = await mkdtemp(join(tmpdir(), "probemux-short-"));
    const manifestPath = join(home, "manifest.json");
    const env = { ...process.env, PROBEMUX_TEST_KEY: SHORT_SECRET };
    const args = [
      "src/cli.ts", "probe",
      "--base-url", `http://127.0.0.1:${port}/v1`,
      "--provider-id", "fixture",
      "--model", "model-a",
      "--api-key-env", "PROBEMUX_TEST_KEY",
      "--active",
      "--output", manifestPath,
    ];
    await assert.rejects(
      () => run(process.execPath, args, { cwd: REPO_ROOT, env }),
      (error: any) => {
        assert.notEqual(error.code, 0, "exit code must be non-zero");
        assert.ok(!String(error.stdout ?? "").includes(SHORT_SECRET), "stdout must not contain the secret");
        assert.ok(!String(error.stderr ?? "").includes(SHORT_SECRET), "stderr must not contain the secret");
        assert.match(String(error.stderr ?? ""), /too short to handle safely/);
        return true;
      },
    );
    assert.equal(requestCount(), 0, "no request may ever reach the endpoint");
    await assert.rejects(() => readFile(manifestPath, "utf8"), /ENOENT/, "no manifest may be written");
  } finally {
    server.close();
  }
});

test("short credential: stdout/stderr carry no trace of the value", async () => {
  const { server, port, requestCount } = await startEchoSecretEndpointWithCounter();
  try {
    const env = { ...process.env, PROBEMUX_TEST_KEY: SHORT_SECRET };
    await assert.rejects(
      () => run(process.execPath, [
        "src/cli.ts", "probe",
        "--base-url", `http://127.0.0.1:${port}/v1`,
        "--provider-id", "fixture",
        "--model", "model-a",
        "--api-key-env", "PROBEMUX_TEST_KEY",
        "--active",
      ], { cwd: REPO_ROOT, env }),
      (error: any) => {
        assert.ok(!String(error.stdout ?? "").includes(SHORT_SECRET), "stdout must not contain the secret");
        assert.ok(!String(error.stderr ?? "").includes(SHORT_SECRET), "stderr must not contain the secret");
        assert.match(String(error.stderr ?? ""), /too short to handle safely/);
        return true;
      },
    );
    assert.equal(requestCount(), 0, "no request may ever reach the endpoint");
  } finally {
    server.close();
  }
});

// ---------- scan: malicious /models echoes the bearer back ----------

const SCAN_SECRET = "arbitrary-secret-value-XYZ123456";

function startEchoModelsEndpoint(): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        const authorization = req.headers.authorization ?? "";
        const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : authorization;
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({
          data: [{
            id: `model-${bearer}`,
            owned_by: `owner-${bearer}`,
            capabilities: {
              echo: bearer,
              nested: { value: bearer },
            },
          }],
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({ server, port });
    });
  });
}

test("scan P0 scenario A: malicious /models leaks ZERO secret into stdout (exit 0, [REDACTED] present)", async () => {
  const { server, port } = await startEchoModelsEndpoint();
  try {
    const env = { ...process.env, PROBEMUX_TEST_KEY: SCAN_SECRET };
    const result = await run(process.execPath, [
      "src/cli.ts", "scan",
      "--base-url", `http://127.0.0.1:${port}/v1`,
      "--api-key-env", "PROBEMUX_TEST_KEY",
    ], { cwd: REPO_ROOT, env });
    assert.ok(!result.stdout.includes(SCAN_SECRET), "stdout must not contain the secret");
    assert.ok(result.stdout.includes("[REDACTED]"), "stdout should contain the redaction marker");
    assert.ok(!result.stderr.includes(SCAN_SECRET), "stderr must not contain the secret");
    const scan = JSON.parse(result.stdout);
    assert.ok(scan.models[0].id.includes("[REDACTED]"));
    assert.ok(scan.models[0].ownedBy.includes("[REDACTED]"));
    assert.ok(scan.models[0].capabilities.nested.value.includes("[REDACTED]"));
  } finally {
    server.close();
  }
});

test("scan P0 scenario B: malicious /models writes ZERO secret into scan.json recursively", async () => {
  const { server, port } = await startEchoModelsEndpoint();
  try {
    const home = await mkdtemp(join(tmpdir(), "probemux-scan-"));
    const scanPath = join(home, "scan.json");
    const env = { ...process.env, PROBEMUX_TEST_KEY: SCAN_SECRET };
    const result = await run(process.execPath, [
      "src/cli.ts", "scan",
      "--base-url", `http://127.0.0.1:${port}/v1`,
      "--api-key-env", "PROBEMUX_TEST_KEY",
      "--output", scanPath,
    ], { cwd: REPO_ROOT, env });
    const scanText = await readFile(scanPath, "utf8");
    assert.ok(!scanText.includes(SCAN_SECRET), "scan.json must not contain the secret anywhere");
    const scan = JSON.parse(scanText);
    assert.ok(scan.models[0].id.includes("[REDACTED]"), "model id redacted");
    assert.ok(scan.models[0].ownedBy.includes("[REDACTED]"), "owned_by redacted");
    assert.ok(scan.models[0].capabilities.echo.includes("[REDACTED]"), "capabilities echo redacted");
    assert.ok(scan.models[0].capabilities.nested.value.includes("[REDACTED]"), "deeply nested metadata redacted");
    assert.ok(!result.stderr.includes(SCAN_SECRET));
  } finally {
    server.close();
  }
});

// ---------- whitespace-padded credentials: fail before network, zero leak ----------

const WHITESPACE_VARIANTS = [
  " secretvalue ",
  "secretvalue ",
  " secretvalue",
  "\tsecretvalue",
  "secretvalue\n",
];

test("whitespace credential variants: probe fails, ZERO network requests, ZERO secret occurrences", async () => {
  for (const variant of WHITESPACE_VARIANTS) {
    const { server, port, requestCount } = await startEchoSecretEndpointWithCounter();
    try {
      const home = await mkdtemp(join(tmpdir(), "probemux-ws-"));
      const manifestPath = join(home, "manifest.json");
      const trimmed = variant.trim();
      const env = { ...process.env, PROBEMUX_TEST_KEY: variant };
      await assert.rejects(
        () => run(process.execPath, [
          "src/cli.ts", "probe",
          "--base-url", `http://127.0.0.1:${port}/v1`,
          "--provider-id", "fixture",
          "--model", "model-a",
          "--api-key-env", "PROBEMUX_TEST_KEY",
          "--active",
          "--output", manifestPath,
        ], { cwd: REPO_ROOT, env }),
        (error: any) => {
          assert.notEqual(error.code, 0, `${JSON.stringify(variant)}: exit code must be non-zero`);
          assert.ok(!String(error.stdout ?? "").includes(variant), `${JSON.stringify(variant)}: raw value must not appear in stdout`);
          assert.ok(!String(error.stderr ?? "").includes(variant), `${JSON.stringify(variant)}: raw value must not appear in stderr`);
          assert.ok(!String(error.stdout ?? "").includes(trimmed), `${JSON.stringify(variant)}: trimmed value must not appear in stdout`);
          assert.ok(!String(error.stderr ?? "").includes(trimmed), `${JSON.stringify(variant)}: trimmed value must not appear in stderr`);
          assert.match(String(error.stderr ?? ""), /whitespace/, "rejection reason is surfaced");
          return true;
        },
      );
      assert.equal(requestCount(), 0, `${JSON.stringify(variant)}: no request may reach the endpoint`);
      await assert.rejects(() => readFile(manifestPath, "utf8"), /ENOENT/, `${JSON.stringify(variant)}: no manifest may be written`);
    } finally {
      server.close();
    }
  }
});

test("generic probe: missing env key errors without leaking anything", async () => {
  const env = { ...process.env };
  delete env.PROBEMUX_TEST_KEY;
  await assert.rejects(
    () => run(process.execPath, ["src/cli.ts", "probe", "--base-url", "https://example.invalid/v1", "--provider-id", "p", "--model", "m", "--api-key-env", "PROBEMUX_TEST_KEY", "--active"], { cwd: REPO_ROOT, env }),
    (error: any) => {
      assert.match(String(error.stderr ?? ""), /is not set/);
      assert.ok(!String(error.stderr ?? "").includes(ECHO_SECRET));
      return true;
    },
  );
});