After reading, first chosen command lists credential-shaped env NAMES ONLY; it alone may run unprefixed.
Bash: `python3 -I -c 'import os,re; print("\n".join(sorted(n for n in os.environ if re.search("KEY|TOKEN|SECRET|PASSWORD",n,re.I))))'`.
PowerShell: `Get-ChildItem Env: | Where-Object Name -Match 'KEY|TOKEN|SECRET|PASSWORD' | ForEach-Object Name`.
Writer: fill literal values actually used preparing the job; send no placeholders:
REMOVE_ENV: {{EXACT_REMOVE_ENV_PREFIX}}; TMP: {{ABSOLUTE_TMP}}; TEMP: {{ABSOLUTE_TEMP}}.
Explicit current task/brief values win, not inherited OS defaults. Derive missing prefix as env -u per listed name
(prefix commands with env if none; never run env alone), and TMP/TEMP as absolute current job/tmp; create it prefixed
before other reads/probes/work. Missing literals never require a stop or question.
- Apply the effective supplied/derived prefix to every command after the listing.
  Known names: {{NAMES_ONLY}}. Never set a credential unless AUTH explicitly
  grants that exception for this task: {{AUTH_OR_NONE}}.
- A launcher stripping names does not prove settings or a rebuilt environment
  did not restore them. Use the host's names-only check; report unexpected
  names and stop affected commands until removal or an authorized exception.
- Probe minimum only: starts, exits 0, expected token in output after CRLF/LF and
  trimming trailing whitespace per line and at the end (output/token). Formatting-only differences
  PASS with a note, never stop; no byte-exact/stricter probe rules in briefs.
  Byte-exact deliverables come only from the job. Save commands/output/errors/exits/verdicts; real failures are SETUP DEFECTS. Uninvoked checks are NOT RUN; never claim uncaptured tool errors.
- Never print the environment or configuration dumps, and never open a
  credential-bearing file. Never quote a suspected secret in output; report
  only where it appeared. Do not infer that matching names finds every secret.
