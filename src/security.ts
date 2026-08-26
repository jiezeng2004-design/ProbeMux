/**
 * Runtime secret registry + redaction.
 *
 * ProbeMux resolves API keys from environment variables and credential files at
 * runtime. The raw value lives only in process memory; every output path
 * (stdout, stderr, manifests, diffs, plans, errors, filenames) must be free of
 * real secrets. Modules that resolve a secret register it here so that even a
 * bottom-layer error string that echoes the value back is redacted.
 */

const secrets = new Set<string>();

/**
 * Minimum length for a value to be registered for global redaction. Values
 * shorter than this cannot be safely redacted (they would over-redact common
 * short text everywhere), so they must never be used as credentials: the
 * fail-closed rule is "shorter than 4 -> refuse", never "use but do not
 * register".
 */
const MIN_REGISTERED_SECRET_LENGTH = 4;

/** Options accepted by registerResolvedSecret. */
export interface RegisterSecretOptions {
  /** Human-readable credential reference (env var name), printed on rejection. */
  credentialName?: string;
  /**
   * When true (default), a value shorter than MIN_REGISTERED_SECRET_LENGTH is
   * rejected with an error instead of being returned. The value is never
   * returned and never registered, so it can never reach the network or any
   * output path.
   */
  rejectUnsafeShortValue?: boolean;
}

/**
 * Thrown when a real credential is too short to be handled safely. The
 * message names the credential reference but NEVER contains the value.
 */
export class CredentialTooShortError extends Error {
  constructor(credentialName?: string) {
    super(
      credentialName
        ? `Credential '${credentialName}' is too short to handle safely (minimum 4 characters); refusing to use it because it cannot be safely redacted.`
        : "Refusing to use a credential shorter than 4 characters because it cannot be safely redacted.",
    );
    this.name = "CredentialTooShortError";
  }
}

/**
 * Thrown when a real credential has leading or trailing whitespace. The value
 * is never auto-trimmed and sent (that would change its semantics and let a
 * server echo the trimmed form past redaction); the message names the
 * credential reference but NEVER contains the value.
 */
export class CredentialWhitespaceError extends Error {
  constructor(credentialName?: string) {
    super(
      credentialName
        ? `Credential '${credentialName}' must not have leading or trailing whitespace; refusing to use it because it cannot be safely redacted.`
        : "Refusing to use a credential with leading or trailing whitespace because it cannot be safely redacted.",
    );
    this.name = "CredentialWhitespaceError";
  }
}

/** Backwards-compatible alias; prefer registerResolvedSecret at resolution boundaries. */
export function registerSecret(value: string | undefined | null): void {
  registerResolvedSecret(value);
}

/**
 * UNIFIED secret resolution boundary.
 *
 * Every real credential entering ProbeMux memory must pass through here BEFORE
 * any network use. The invariant is: resolve -> registerResolvedSecret ->
 * network. The returned value is the only way callers should keep the
 * credential; it is registered for redaction as a side effect, so no caller
 * decides on its own whether to register.
 *
 * - undefined / null -> unresolved (returns undefined, nothing registered).
 * - empty string -> invalid credential (returns undefined, nothing registered;
 *   callers may treat this as "not available").
 * - ANY leading or trailing whitespace -> FAIL. A padded credential is never
 *   auto-trimmed and sent (that would change its raw semantics and would let a
 *   server echo the trimmed form past redaction). Both the raw and the trimmed
 *   values are registered in the redaction registry first (defense in depth
 *   for error paths), then a CredentialWhitespaceError is thrown.
 * - Values shorter than MIN_REGISTERED_SECRET_LENGTH -> FAIL. By default a
 *   CredentialTooShortError is thrown, so the credential can never be used
 *   for the network and never appears in stdout/stderr/manifests. There is no
 *   "return the value but do not register it" path any more.
 * - Duplicates are deduplicated by the underlying Set.
 * - Never prints the secret and never returns debug info that could log it.
 */
export function registerResolvedSecret(
  value: string | undefined | null,
  options?: RegisterSecretOptions,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (value !== trimmed) {
    // Fail-closed BEFORE any network use. Defense in depth: register both the
    // raw value and its trimmed form so that even a low-level error echoing
    // either one is redacted. The error message names only the credential ref.
    secrets.add(value);
    if (trimmed !== "") secrets.add(trimmed);
    throw new CredentialWhitespaceError(options?.credentialName);
  }
  if (trimmed === "") return undefined;
  if (trimmed.length < MIN_REGISTERED_SECRET_LENGTH) {
    if (options?.rejectUnsafeShortValue !== false) {
      throw new CredentialTooShortError(options?.credentialName);
    }
    return undefined;
  }
  secrets.add(value);
  return value;
}

/** Forget all registered secrets (used by tests). */
export function clearSecrets(): void {
  secrets.clear();
}

/** Redact every registered secret value from a string. */
export function redactSecrets(text: string): string {
  if (secrets.size === 0 || !text) return text;
  let out = text;
  // Longest first so a secret that contains another secret redacts cleanly.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/**
 * Recursively sanitize an untrusted remote JSON value so it is safe to
 * serialize into any user-visible output: every string runs through
 * redactSecrets, arrays and plain objects are traversed depth-first, and
 * number / boolean / null pass through unchanged.
 *
 * Prototype-safe: keys are copied with Object.defineProperty, so hostile
 * remote keys such as "__proto__" or "constructor" become plain own data
 * properties and can never touch a prototype.
 */
export function sanitizeUnknownValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknownValue(item));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, {
        value: sanitizeUnknownValue((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/**
 * Normalize an error into a safe, redacted message.
 * Registered secrets are removed even if a low-level exception string carries them.
 */
export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(
    message
      .replace(/Bearer\s+[A-Za-z0-9._~+/\-]+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
      .replace(/[?&](?:api_?key|token|key)=[^\s&]+/gi, "[REDACTED]"),
  );
}