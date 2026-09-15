# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Remendra, please report it privately:

1. **Do not open a public issue.**
2. Email **dev.ungheni@gmail.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Impact assessment

You should receive a response within 48 hours. Critical vulnerabilities will be patched and released as soon as possible.

## Scope

Remendra processes conversation text and stores structured claims in a local SQLite database. Security concerns include:

- **Secret leakage**: Remendra redacts known secret patterns (API keys, tokens, private keys, database URIs) before storing source text. If you find a pattern that should be redacted but isn't, report it.
- **Injection**: The observer model extracts claims from untrusted session text. Observer output is validated before storage. If you find a way to inject claims that bypass validation, report it.
- **Data exposure**: All data stays local. If you find a code path that sends data to an external service without explicit user configuration, report it.

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.0.x   | ✅        |
| < 2.0   | ❌        |
