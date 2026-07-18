import { describe, expect, test } from "vitest";
import { scanForSecrets, hasRejectFinding, type SecretFinding } from "./scanner.js";

function patterns(fs: SecretFinding[]): string[] {
  return fs.map((f) => f.pattern);
}

describe("scanForSecrets — reject patterns", () => {
  test("scanForSecrets_flags_openai_key", () => {
    const fs = scanForSecrets("token is sk-abcdef0123456789ABCD here");
    expect(patterns(fs)).toContain("openai-key");
    expect(fs.every((f) => f.severity === "reject" || f.severity === "warn")).toBe(true);
  });

  test("scanForSecrets_flags_github_token_and_pat", () => {
    expect(patterns(scanForSecrets("ghp_" + "a".repeat(36)))).toContain("github-token");
    expect(patterns(scanForSecrets("gho_" + "a".repeat(36)))).toContain("github-token");
    expect(patterns(scanForSecrets("github_pat_" + "A1".repeat(15)))).toContain("github-pat");
  });

  test("scanForSecrets_flags_aws_access_key", () => {
    expect(patterns(scanForSecrets("AKIAIOSFODNN7EXAMPLE"))).toContain("aws-access-key");
  });

  test("scanForSecrets_flags_slack_token", () => {
    expect(patterns(scanForSecrets("xoxb-123456789012-abcdefABCDEF"))).toContain("slack-token");
  });

  test("scanForSecrets_flags_jwt", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4";
    expect(patterns(scanForSecrets(jwt))).toContain("jwt");
  });

  test("scanForSecrets_flags_pem_private_key_header", () => {
    expect(patterns(scanForSecrets("-----BEGIN RSA PRIVATE KEY-----"))).toContain("private-key");
  });

  test("scanForSecrets_flags_assignment_forms", () => {
    expect(patterns(scanForSecrets("password = hunter2xyz"))).toContain("assignment:password");
    expect(patterns(scanForSecrets("api_key: abc123def456"))).toContain("assignment:api_key");
    expect(patterns(scanForSecrets("SECRET=topsecretvalue"))).toContain("assignment:secret");
  });

  test("scanForSecrets_reports_1_based_line_number", () => {
    const fs = scanForSecrets("clean line\nAKIAIOSFODNN7EXAMPLE\n");
    const aws = fs.find((f) => f.pattern === "aws-access-key");
    expect(aws?.line).toBe(2);
  });

  test("scanForSecrets_masks_and_never_reveals_full_secret", () => {
    const secret = "sk-abcdefghijklmnop0123";
    const fs = scanForSecrets(secret);
    const finding = fs.find((f) => f.pattern === "openai-key");
    expect(finding).toBeDefined();
    expect(finding!.masked).not.toContain(secret);
    expect(finding!.masked).toBe("sk-a…****");
    // assignment value masked, key can stay visible but full value must not leak
    const pw = scanForSecrets("password=hunter2").find((f) => f.pattern === "assignment:password");
    expect(pw!.masked).toBe("****"); // value length <= 8
    expect(pw!.masked).not.toContain("hunter2");
    // long assignment value must fully mask, never reveal first chars
    const longPw = scanForSecrets("password = MyRealP@ssw0rd").find((f) => f.pattern === "assignment:password");
    expect(longPw!.masked).toBe("****");
    expect(longPw!.masked).not.toContain("MyRe");
  });

  test("hasRejectFinding_true_when_any_reject", () => {
    expect(hasRejectFinding(scanForSecrets("AKIAIOSFODNN7EXAMPLE"))).toBe(true);
  });

  test("hasRejectFinding_false_on_clean_text", () => {
    const fs = scanForSecrets("just a normal sentence with words");
    expect(hasRejectFinding(fs)).toBe(false);
  });
});

describe("scanForSecrets — warn-level entropy", () => {
  test("scanForSecrets_warns_on_long_high_entropy_blob_without_rejecting", () => {
    const blob = "Zx9Kq2Lm7Pw4Rt1Vb8Nc5Hj0Fd3Gs6Ay+/QwErTyUiOp"; // 45 chars, mixed
    const fs = scanForSecrets(`value=` + blob);
    // assignment rule will also fire (reject) — filter to entropy finding
    const entropy = fs.find((f) => f.pattern === "high-entropy");
    expect(entropy).toBeDefined();
    expect(entropy!.severity).toBe("warn");
    expect(entropy!.masked).toBe("****");
  });

  test("scanForSecrets_does_not_reject_a_ulid", () => {
    const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"; // 26 chars
    const fs = scanForSecrets(`id ${ulid} recorded`);
    expect(hasRejectFinding(fs)).toBe(false);
  });

  test("scanForSecrets_does_not_reject_a_sha256_hash", () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const fs = scanForSecrets(`hash: ${sha}`);
    // may warn (legitimately high-entropy) but MUST NOT reject
    expect(hasRejectFinding(fs)).toBe(false);
  });

  test("scanForSecrets_does_not_flag_normal_prose", () => {
    const fs = scanForSecrets("the quick brown fox jumps over the lazy dog again and again");
    expect(fs).toEqual([]);
  });
});
