First command lists credential-shaped env NAMES ONLY; it alone may run unprefixed.
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
- Execute declared tool probes in this runner before job work; save the exact
  command, output/error and exit/refusal. Refusal is a SETUP DEFECT, not a job
  failure. If not invoked, say NOT RUN; never claim an uncaptured tool error.
- Never print the environment or configuration dumps, and never open a
  credential-bearing file. Never quote a suspected secret in output; report
  only where it appeared. Do not infer that matching names finds every secret.
