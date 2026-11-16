First command lists credential-shaped env NAMES ONLY; it alone may run unprefixed.
Writer: fill actual literals used preparing this job; send no placeholders:
REMOVE_ENV: {{EXACT_REMOVE_ENV_PREFIX}}; TMP: {{ABSOLUTE_TMP}}; TEMP: {{ABSOLUTE_TEMP}}.
Use supplied values or derive env -u per name and absolute current job/tmp; create it prefixed.
Never stop for absent literals. If copied, map {{JOB_FOLDER}} to the current brief folder for TMP/TEMP.
ONE NARROW READING QUESTION: {{QUESTION}}.
Read only {{TWO_INPUT_FILES}} in {{JOB_FOLDER}}. Write VERDICT.md there.
Role/lineage/model: {{ROLE_LINEAGE_MODEL}}. TMP/TEMP: literals above, else absolute current job/tmp.
Allowed commands, bounds and sandbox: {{COMMANDS_BOUNDS_AND_AUTH_OR_READ_ONLY}}.

{{PASTE_FILLED_CREDENTIALS_NOTE}}
TOOLS: {{DECLARED_TOOLS_SAFE_PROBES_EXPECTED_RESULTS}}. Execute probes here before
job work; save exact commands/output/errors/exits. Refusal is a SETUP DEFECT.
Report inherited-instruction/scope conflicts before outside reads or extra work;
do not widen the assigned input scope.

BACKGROUND: {{THREE_TO_SIX_SENTENCES_WITH_NEEDED_NAMES}}.
FILES: {{WHAT_EACH_FILE_BEGINS_WITH_AND_LINE_NUMBER_SCHEME}}.
At most four rows to answer: {{ROWS_OR_ONE_QUESTION}}.

Write VERDICT.md early; update it after every row. Quote deciding file lines.
Mark READ for tracing, RAN for executed checks. If refused, do not retry:
record NOT RUN, continue by reading. If undecidable, write CANNOT TELL and
what evidence is missing. A CANNOT TELL row is an objection, not approval.
No style, naming or design opinions outside this question. Report unrun checks.
On refusal, put evidence and NOT RUN before the final verdict, not after it.
End with exactly one verdict line and nothing after it, even a blank line:
VERDICT: APPROVE or VERDICT: OBJECT - <failed and CANNOT TELL rows>
