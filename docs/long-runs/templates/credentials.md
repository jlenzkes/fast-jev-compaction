Credential and environment rules for every command:
- Apply this host-supplied removal prefix: {{EXACT_PREFIX_OR_NONE_WITH_REASON}}.
  Known names: {{NAMES_ONLY}}. Never set a credential unless AUTH explicitly
  grants that exception for this task: {{AUTH_OR_NONE}}.
- A launcher stripping names does not prove settings or a rebuilt environment
  did not restore them. Use the host's names-only check; report unexpected
  names and stop affected commands until removal or an authorized exception.
- Never print the environment or configuration dumps, and never open a
  credential-bearing file. Never quote a suspected secret in output; report
  only where it appeared. Do not infer that matching names finds every secret.
