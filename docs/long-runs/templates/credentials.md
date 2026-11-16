Before the very first command, including bootstrap reads of any brief or state,
apply {{EXACT_PREFIX_OR_NONE_WITH_REASON}} and set TMP/TEMP to {{JOB_LOCAL_TMP}}.
The launcher/invocation must supply these literal values before any read;
if missing, ask without a command. This applies to every command, not just task work.
- Apply this host-supplied removal prefix: {{EXACT_PREFIX_OR_NONE_WITH_REASON}}.
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
