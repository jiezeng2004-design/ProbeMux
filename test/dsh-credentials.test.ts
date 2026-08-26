import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDotenv, resolveCredential } from "../src/integrations/dsh/credentials.ts";
import { clearSecrets, redactSecrets, registerSecret, sanitizeError } from "../src/security.ts";

test("parseDotenv handles quotes and comments", () => {
  const parsed = parseDotenv("# comment\nKEY=value\nQUOTED=\"double\"\nSINGLE='single'\nEMPTY=\n");
  assert.equal(parsed.KEY, "value");
  assert.equal(parsed.QUOTED, "double");
  assert.equal(parsed.SINGLE, "single");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed["# comment"], undefined);
});

test("credential precedence: process env wins over credential files", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "TEST_PRECEDENCE_KEY: from-yaml\n");
  process.env.TEST_PRECEDENCE_KEY = "from-process";
  try {
    const result = await resolveCredential({ apiKeyEnv: "TEST_PRECEDENCE_KEY", dshHome: home });
    assert.equal(result.value, "from-process");
    assert.equal(result.source, "process-env");
  } finally {
    delete process.env.TEST_PRECEDENCE_KEY;
  }
});

test("credential from .credentials.yaml when process env is absent", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: sk-yaml-only-secret\n");
  const result = await resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home });
  assert.equal(result.value, "sk-yaml-only-secret");
  assert.equal(result.source, "credentials-yaml");
});

test("credential from cwd/.env before DSH_HOME/.env", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".env"), "TEST_ENV_KEY=home-value\n");
  await writeFile(join(cwd, ".env"), "TEST_ENV_KEY=cwd-value\n");
  const result = await resolveCredential({ apiKeyEnv: "TEST_ENV_KEY", dshHome: home, cwd });
  assert.equal(result.value, "cwd-value");
  assert.equal(result.source, "cwd-dotenv");
});

test("credential from DSH_HOME/.env as the last resort", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".env"), "TEST_ENV_KEY=home-value\n");
  const result = await resolveCredential({ apiKeyEnv: "TEST_ENV_KEY", dshHome: home, cwd });
  assert.equal(result.value, "home-value");
  assert.equal(result.source, "dsh-home-dotenv");
});

test("missing key resolves to unresolved", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const result = await resolveCredential({ apiKeyEnv: "NO_SUCH_KEY_ANYWHERE", dshHome: home });
  assert.equal(result.value, undefined);
  assert.equal(result.source, "unresolved");
});

test("registered secrets are redacted from errors and arbitrary strings", () => {
  clearSecrets();
  const secret = "sk-super-secret-abcdefghij";
  registerSecret(secret);
  const error = new Error(`request failed with ${secret} in the body`);
  const message = sanitizeError(error);
  assert.ok(!message.includes(secret));
  assert.ok(message.includes("[REDACTED]"));
  // direct redaction of arbitrary output
  const redacted = redactSecrets(`header ${secret} tail`);
  assert.ok(!redacted.includes(secret));
  assert.ok(redacted.includes("[REDACTED]"));
  clearSecrets();
});

test("resolved credential value never appears in any output-shaped string", async () => {
  clearSecrets();
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const secret = "sk-never-printed-987654321";
  await writeFile(join(home, ".credentials.yaml"), `SECRET_KEY: ${secret}\n`);
  const result = await resolveCredential({ apiKeyEnv: "SECRET_KEY", dshHome: home });
  assert.equal(result.value, secret); // in memory only
  const fakeOutput = JSON.stringify({
    apiKeyEnv: "SECRET_KEY",
    source: ".credentials.yaml",
    status: "available",
  });
  assert.ok(!fakeOutput.includes(secret));
  assert.ok(!redactSecrets(fakeOutput).includes(secret));
  // even an error carrying the secret is redacted
  const safe = sanitizeError(new Error(`boom ${secret}`));
  assert.ok(!safe.includes(secret));
  clearSecrets();
});

// ---------- short credentials fail-closed from every source ----------

test("short credential: process env FAILS and never falls back to .credentials.yaml", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "SHORT_KEY: sk-long-backup-from-yaml\n");
  process.env.SHORT_KEY = "abc";
  try {
    await assert.rejects(
      () => resolveCredential({ apiKeyEnv: "SHORT_KEY", dshHome: home }),
      /too short to handle safely/,
    );
  } finally {
    delete process.env.SHORT_KEY;
  }
});

test("short credential: .credentials.yaml FAILS", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: abc\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    /too short to handle safely/,
  );
});

test("short credential: cwd/.env FAILS and never falls back to DSH_HOME/.env", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".env"), "SHORT_KEY=sk-long-home-env\n");
  await writeFile(join(cwd, ".env"), "SHORT_KEY=abc\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "SHORT_KEY", dshHome: home, cwd }),
    /too short to handle safely/,
  );
});

test("short credential: DSH_HOME/.env FAILS", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".env"), "MY_API_KEY=abc\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    /too short to handle safely/,
  );
});

test("short credential: rejection never leaks the value in the error", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: abc\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    (error: any) => {
      const message = String(error.message ?? "");
      assert.match(message, /Credential 'MY_API_KEY'/);
      assert.ok(!message.includes("abc"), "the value must never appear in the error");
      return true;
    },
  );
});

test("short credential: rejection never leaks the value after sanitizeError", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: abc\n");
  try {
    await resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home });
    assert.fail("expected rejection");
  } catch (error) {
    const safe = sanitizeError(error);
    assert.ok(!safe.includes("abc"), "sanitized error must not contain the value");
  }
});

// ---------- whitespace-padded credentials fail-closed from every source ----------

test("whitespace credential: process env FAILS and never falls back to .credentials.yaml", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "WS_KEY: sk-long-backup-from-yaml\n");
  process.env.WS_KEY = " secretvalue ";
  try {
    await assert.rejects(
      () => resolveCredential({ apiKeyEnv: "WS_KEY", dshHome: home }),
      /whitespace/,
    );
  } finally {
    delete process.env.WS_KEY;
  }
});

test("whitespace credential: .credentials.yaml FAILS", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: \" secretvalue \"\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    /whitespace/,
  );
});

test("whitespace credential: cwd/.env FAILS and never falls back to DSH_HOME/.env", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".env"), "WS_KEY=sk-long-home-env\n");
  await writeFile(join(cwd, ".env"), "WS_KEY=secretvalue \n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "WS_KEY", dshHome: home, cwd }),
    /whitespace/,
  );
});

test("whitespace credential: DSH_HOME/.env FAILS", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".env"), "MY_API_KEY= secretvalue\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    /whitespace/,
  );
});

test("whitespace credential: rejection never leaks raw or trimmed value", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: \" secretvalue \"\n");
  try {
    await resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home });
    assert.fail("expected rejection");
  } catch (error) {
    const message = String((error as Error).message ?? "");
    assert.match(message, /Credential 'MY_API_KEY'/);
    assert.ok(!message.includes("secretvalue"), "trimmed value must never appear");
    assert.ok(!message.includes(" secretvalue "), "raw value must never appear");
    const safe = sanitizeError(error);
    assert.ok(!safe.includes("secretvalue"));
  }
});

// ---------- fail-closed .credentials.yaml semantics ----------

test("fail-closed case 1: credentials file absent -> cwd/.env succeeds", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(cwd, ".env"), "FC_KEY=from-cwd-env\n");
  const result = await resolveCredential({ apiKeyEnv: "FC_KEY", dshHome: home, cwd });
  assert.equal(result.value, "from-cwd-env");
  assert.equal(result.source, "cwd-dotenv");
});

test("fail-closed case 2: credentials file valid but key absent -> cwd/.env succeeds", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".credentials.yaml"), "OTHER_KEY: something\n");
  await writeFile(join(cwd, ".env"), "FC_KEY2=from-cwd-env\n");
  const result = await resolveCredential({ apiKeyEnv: "FC_KEY2", dshHome: home, cwd });
  assert.equal(result.value, "from-cwd-env");
  assert.equal(result.source, "cwd-dotenv");
});

test("fail-closed case 3: malformed credentials file FAILS even with a valid cwd/.env", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: [unclosed\n");
  await writeFile(join(cwd, ".env"), "MY_API_KEY=from-cwd-env\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home, cwd }),
    /Failed to parse DSH credential file/,
  );
});

test("fail-closed case 4: credentials file with wrong top-level type FAILS", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".credentials.yaml"), "- foo\n- bar\n");
  await writeFile(join(cwd, ".env"), "MY_API_KEY=from-cwd-env\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home, cwd }),
    /must contain a key-value mapping/,
  );
});

test("fail-closed case 5: credentials key with null value FAILS", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY:\n");
  await writeFile(join(cwd, ".env"), "MY_API_KEY=from-cwd-env\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home, cwd }),
    /not a valid non-empty string/,
  );
});

test("fail-closed case 6: credentials key with empty string FAILS", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: \"\"\n");
  await writeFile(join(cwd, ".env"), "MY_API_KEY=from-cwd-env\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home, cwd }),
    /not a valid non-empty string/,
  );
});

test("fail-closed case 7: valid credentials key is used", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: sk-valid-file-secret\n");
  const result = await resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home });
  assert.equal(result.value, "sk-valid-file-secret");
  assert.equal(result.source, "credentials-yaml");
});

test("fail-closed case 8: process env wins over a malformed credentials file", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "FC_KEY8: [unclosed\n");
  process.env.FC_KEY8 = "from-process";
  try {
    const result = await resolveCredential({ apiKeyEnv: "FC_KEY8", dshHome: home });
    assert.equal(result.value, "from-process");
    assert.equal(result.source, "process-env");
  } finally {
    delete process.env.FC_KEY8;
  }
});

test("fail-closed: credentials key with a non-string scalar FAILS", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: 12345\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    /not a valid non-empty string/,
  );
});

test("fail-closed: parse errors include the path but never the file contents", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const malformed = "MY_API_KEY: [unclosed\nSOME_OTHER_LINE: sk-should-never-appear-42\n";
  await writeFile(join(home, ".credentials.yaml"), malformed);
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    (error: any) => {
      const message = String(error.message ?? "");
      assert.match(message, /Failed to parse DSH credential file/);
      assert.ok(!message.includes("sk-should-never-appear-42"), "must never dump parser input");
      assert.ok(!message.includes("[unclosed"), "must never dump YAML document content");
      return true;
    },
  );
});
// ---------- versioned refs schema (real DSH .credentials.yaml shape) ----------

const REAL_DSH_REFS = `version: 1
refs:
  DEEPSEEK_API_KEY: sk-real-deepseek-123456789
  OPENROUTER_LATEST_API_KEY: sk-real-openrouter-123456789
  OPENCODE_API_KEY: sk-real-opencode-123456789
  NUBE_API_KEY: sk-real-nube-123456789
  OPENCODE_LATEST_API_KEY: sk-real-opencode-latest-123
`;

test("versioned refs schema: every real DSH provider key resolves from refs", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), REAL_DSH_REFS);
  for (const key of [
    "DEEPSEEK_API_KEY",
    "OPENROUTER_LATEST_API_KEY",
    "OPENCODE_API_KEY",
    "NUBE_API_KEY",
    "OPENCODE_LATEST_API_KEY",
  ]) {
    const result = await resolveCredential({ apiKeyEnv: key, dshHome: home });
    assert.equal(result.source, "credentials-yaml", key);
    assert.ok(result.value && result.value.startsWith("sk-"), key);
  }
});

test("versioned refs schema: process env still wins", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), REAL_DSH_REFS);
  process.env.DEEPSEEK_API_KEY = "sk-from-process-123456789";
  try {
    const result = await resolveCredential({ apiKeyEnv: "DEEPSEEK_API_KEY", dshHome: home });
    assert.equal(result.value, "sk-from-process-123456789");
    assert.equal(result.source, "process-env");
  } finally {
    delete process.env.DEEPSEEK_API_KEY;
  }
});

test("versioned refs schema: key absent from refs falls back to cwd/.env", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".credentials.yaml"), REAL_DSH_REFS);
  await writeFile(join(cwd, ".env"), "SOME_OTHER_KEY=from-cwd-env-123456789\n");
  const result = await resolveCredential({ apiKeyEnv: "SOME_OTHER_KEY", dshHome: home, cwd });
  assert.equal(result.value, "from-cwd-env-123456789");
  assert.equal(result.source, "cwd-dotenv");
});

test("versioned refs schema: key absent from refs and nowhere else -> unresolved", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), REAL_DSH_REFS);
  const result = await resolveCredential({ apiKeyEnv: "NO_SUCH_REF", dshHome: home });
  assert.equal(result.value, undefined);
  assert.equal(result.source, "unresolved");
});

test("versioned refs schema: refs value null FAILS and never falls back", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  MY_API_KEY:\n");
  await writeFile(join(cwd, ".env"), "MY_API_KEY=from-cwd-env-123456789\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home, cwd }),
    /not a valid non-empty string/,
  );
});

test("versioned refs schema: refs value empty string FAILS", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  MY_API_KEY: \"\"\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    /not a valid non-empty string/,
  );
});

test("versioned refs schema: refs value too short FAILS with no leak", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  MY_API_KEY: abc\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    (error: any) => {
      const message = String(error.message ?? "");
      assert.match(message, /too short to handle safely/);
      assert.ok(!message.includes("abc"), "the value must never appear in the error");
      return true;
    },
  );
});

test("versioned refs schema: refs not a mapping FAILS closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".credentials.yaml"), "version: 1\nrefs:\n  - broken\n");
  await writeFile(join(cwd, ".env"), "MY_API_KEY=from-cwd-env-123456789\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home, cwd }),
    /'refs' section that is not a key-value mapping/,
  );
});

test("versioned refs schema: refs as a scalar FAILS closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "version: 1\nrefs: oops\n");
  await assert.rejects(
    () => resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home }),
    /'refs' section that is not a key-value mapping/,
  );
});

test("versioned refs schema: version-only file (no refs) resolves nothing, falls back", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const cwd = await mkdtemp(join(tmpdir(), "probemux-cwd-"));
  await writeFile(join(home, ".credentials.yaml"), "version: 1\n");
  await writeFile(join(cwd, ".env"), "MY_API_KEY=from-cwd-env-123456789\n");
  const result = await resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home, cwd });
  assert.equal(result.value, "from-cwd-env-123456789");
  assert.equal(result.source, "cwd-dotenv");
});

test("versioned refs schema: resolved secret is redacted from any output-shaped string", async () => {
  clearSecrets();
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  const secret = "sk-refs-never-printed-987654321";
  await writeFile(join(home, ".credentials.yaml"), `version: 1\nrefs:\n  SECRET_KEY: ${secret}\n`);
  const result = await resolveCredential({ apiKeyEnv: "SECRET_KEY", dshHome: home });
  assert.equal(result.value, secret);
  const safe = sanitizeError(new Error(`boom ${secret}`));
  assert.ok(!safe.includes(secret));
  assert.ok(!redactSecrets(`header ${secret} tail`).includes(secret));
  clearSecrets();
});

test("flat schema still resolves when the file also carries unrelated keys", async () => {
  const home = await mkdtemp(join(tmpdir(), "probemux-cred-"));
  await writeFile(join(home, ".credentials.yaml"), "MY_API_KEY: sk-flat-still-works-123456\nother: 1\n");
  const result = await resolveCredential({ apiKeyEnv: "MY_API_KEY", dshHome: home });
  assert.equal(result.value, "sk-flat-still-works-123456");
  assert.equal(result.source, "credentials-yaml");
});
