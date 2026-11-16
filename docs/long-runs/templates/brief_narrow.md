ONE NARROW READING QUESTION: {{QUESTION}}.
Read only {{TWO_INPUT_FILES}} in {{JOB_FOLDER}}. Write VERDICT.md there.
Role/lineage/model: {{ROLE_LINEAGE_MODEL}}. TMP and TEMP: {{JOB_FOLDER}}/tmp.
Allowed commands, bounds and sandbox: {{COMMANDS_BOUNDS_AND_AUTH_OR_READ_ONLY}}.

{{PASTE_FILLED_CREDENTIALS_NOTE}}

BACKGROUND: {{THREE_TO_SIX_SENTENCES_WITH_NEEDED_NAMES}}.
FILES: {{WHAT_EACH_FILE_BEGINS_WITH_AND_LINE_NUMBER_SCHEME}}.
At most four rows to answer: {{ROWS_OR_ONE_QUESTION}}.

Write VERDICT.md early; update it after every row. Quote deciding file lines.
Mark READ for tracing, RAN for executed checks. If refused, do not retry:
record NOT RUN, continue by reading. If undecidable, write CANNOT TELL and
what evidence is missing. A CANNOT TELL row is an objection, not approval.
No style, naming or design opinions outside this question. Report unrun checks.
End with exactly one verdict line and nothing after it, even a blank line:
VERDICT: APPROVE or VERDICT: OBJECT - <failed and CANNOT TELL rows>
