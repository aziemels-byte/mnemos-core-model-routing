const RULES = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g],
  ['github_token', /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/g],
  ['bearer_token', /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/gi],
  ['credential_assignment', /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"']{8,}/gi]
];

export function filterSecrets(input, { mode = 'block' } = {}) {
  const text = String(input ?? '');
  const findings = [];
  let redacted = text;
  for (const [kind, pattern] of RULES) {
    pattern.lastIndex = 0;
    const matches = [...text.matchAll(pattern)];
    if (matches.length) findings.push({ kind, count: matches.length });
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, `[REDACTED:${kind}]`);
  }
  return { safe: findings.length === 0, action: findings.length ? mode : 'allow', findings, text: mode === 'redact' ? redacted : (findings.length ? null : text) };
}
