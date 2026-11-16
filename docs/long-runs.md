# Long runs: work that outlives one context
EXPERIMENTAL. First-use trials passed: none. Three Codex trials failed; corrections await re-trial.

Harness/operator standing instructions may impose actions before you read this procedure/brief.
Record known actions, paths and imposing source (unknown if unobserved) as environment facts in STATE.md or report/final message, outside fixed-format artifacts.
They are not violations or grounds to object/stop. Choices after reading obey this procedure/brief.

Bootstrap on first use and every resume; never stop because literals are absent:
1. The first chosen command after reading lists credential-shaped env NAMES ONLY, never values.
   Only this listing may run unprefixed and before TMP/TEMP are set; use a supplied
   prefix if available. No other unprefixed command, including reads or tool lookups.
   Bash: `python3 -I -c 'import os,re; print("\n".join(sorted(n for n in os.environ if re.search("KEY|TOKEN|SECRET|PASSWORD",n,re.I))))'`.
   PowerShell: `Get-ChildItem Env: | Where-Object Name -Match 'KEY|TOKEN|SECRET|PASSWORD' | ForEach-Object Name`.
   An empty list is valid. Never dump environment values or open credential files.
2. Use the supplied REMOVE_ENV prefix if present; otherwise construct `env -u 'NAME'`
   for every listed name, quoting each exact name; if none match, prefix commands with `env`, never run it alone.
3. With that prefix, resolve the invocation's run path against the starting working
   directory (a worker uses its brief's folder), create its own absolute `tmp/`,
   then set TMP and TEMP to that directory before reads, probes or job work.
   Explicit current task/brief values win (not inherited OS defaults); derive missing
   values and create directories first. New runs do the prefixed outside-checkout
   check below before creating directories. All later commands carry REMOVE_ENV.
Record effective literals/origin in the first state/recovery update; a one-line prompt needs only the run path.

For Claude Code, Codex CLI or Gemini CLI sessions launching/resuming subagents, builders or readers.
Read whole before work/after context loss; nothing needed to resume lives only in conversation.

## Three rules to keep before reading further

1. Write state changes to disk before reporting them; record every worker's
   result the moment it arrives, before replying or doing other work.
2. Give every worker a file brief and job folder; record its handle and
   expected output in STATE.md when launching it.
3. After compaction, restart or handover, read and verify the run on disk
   before acting. Look for completed results before relaunching anything.

## Terms and host slots

The *orchestrator* is the session owning the run. A *coordinator* manages a
builder for it; without one, the orchestrator owes those duties itself.
*Lineage* means Claude, GPT through Codex, or Gemini.
`<repo>` is the host checkout; `<run>` is a persistent folder outside every
checkout; `<procedure>` is the absolute path to this file in the plugin install
or a local copy. `<base>` is the host's integration branch, not a fixed name.
Resolve paths to absolute paths and quote them in runnable commands.

Before work, fill STATE.md's slots. Examples give shapes, not plugin-supplied commands or permissions.

| Slot | What the host supplies | Example |
| --- | --- | --- |
| REPO, BASE, RULES | checkout, integration ref, instruction files | checkout path, `main`, `AGENTS.md` |
| REVIEW | required readers, re-review policy, exception authority, evidence format | two readers approve the exact tip; changes return to affected readers |
| CHECKS | exact commands, expected outcomes, resource limits | `npm test`, exit zero; one suite at a time |
| INTEGRATE | authorized integrator, exact local command, success witness | maintainer merges a reviewed branch; record resulting commit |
| FINDING_HOMES | durable destinations for defects, tasks, ideas, human actions | issue tracker, backlog file, decision log |
| REMOVE_ENV | supplied prefix or bootstrap-derived names and prefix | `env -u EXAMPLE_TOKEN` in a POSIX shell |
| AUTH | any credential exception, network and sandbox grants by task | none; offline worker with writes only in its job folder |
| LAUNCH | installed CLI paths, models, start/resume commands, environment controls | host-checked command per lineage, with output and exit-status files |
| TOOLS | every declared executable, actual runner, safe probe and expected result | `git --version`; an interpreter's harmless print snippet |
| ENTRYPOINT | durable pointer by which a new session finds the active run | task description containing the absolute STATE.md path |

Use `none` where a slot truly does not apply, with a reason. Derive missing
bootstrap values above; other missing required slots block dependent work only.
Do not invent a review policy, a launcher or access grant.
This procedure supplies no launch, cleanup or integration scripts.

The host supplies task policies; bootstrap values also have defaults above.
Derive other nonsecret facts from instructions/help; confirm slots and command
availability under AUTH before launch. Bootstrap supplies no permissions or launch syntax.

## Create the run once

1. Choose `<run>` on persistent storage outside all checkouts. Reject a path
   with a `.git` segment. Ask git about its nearest existing ancestor with
   `<REMOVE_ENV> git -C "<ancestor>" rev-parse --is-inside-work-tree`.
   Proceed only when git positively reports `not a git repository`;
   missing git, permission errors or damaged repositories are not proof.
2. Create `<run>/briefs/`, `<run>/findings/` and `<run>/jobs/`.
   Copy [STATE.md](long-runs/templates/STATE.md),
   [PROGRESS.md](long-runs/templates/PROGRESS.md) and
   [FOUND.md](long-runs/templates/FOUND.md) into `<run>`.
   Keep any existing files. If STATE.md exists, recover instead of initializing.
   If only other files exist, inspect and preserve them before filling STATE.md.
3. Replace every template placeholder. Record the goal, paths, host slots,
   machine-clock date and timezone, base sha, branch tips and next action.
   Obtain git facts with the commands in recovery below.
4. Write tested, pasteable start commands for each available lineage into
   STATE.md and PROGRESS.md, labelled by lineage. Mark unavailable commands
   `not yet tried` or `unavailable`; do not leave a runnable-looking guess.
   Each command starts in `<run>`; include known literals, but allow this prompt:

   > Read `<procedure>` whole. Prior harness/standing-instruction actions are
   > environment facts, not violations. Bootstrap next, then read STATE.md/RULES.
   > Recover `<run>`; capture arrivals and refresh Now before chosen replies.

   Record the absolute STATE.md path at ENTRYPOINT, outside the run folder,
   within authorized writes (for example, the host's existing task description).
   A takeover invocation or handoff must include that path. If no durable
   pointer can be written, deliver the absolute path in the handoff and record
   that limitation; a session given neither pointer nor run path cannot resume.
   The launching party saves the actual start/takeover command, prompt and input-file list; unobserved context stays unverified.

5. Apply REMOVE_ENV before launch; repeat the names-only check in the started
   session using Bootstrap or the host's check. Settings/rebuilt environments may
   restore names; remove unexpected names before affected commands or use AUTH.
   Record names/prefix in STATE.md; paste filled
   [credentials.md](long-runs/templates/credentials.md) into each brief.
   A name pattern cannot find every secret; never print values or credential files.
6. Keep the orchestrator's working directory at `<run>`. Workers write only
   their assigned job folders or isolated clones. Record Update 1 and the Now
   block before the first work report. No access grant flows from parent to child.
7. The first session must execute every host-declared TOOLS probe with REMOVE_ENV
   before the first job step, in its actual runner/sandbox; lookup is insufficient.
   Test interpreters with harmless snippets, not job calculations. Workers must
   also probe their declared tools in their own runner before their first job step.
   Record exact commands, stdout/stderr, exit/refusal and runner in STATE.md.
   A refusal or mismatch is a SETUP DEFECT, not a job failure: block dependent
   work, request corrected setup, and verify it before continuing. Never silently
   substitute a tool or label a substitute check as the required check's success.

## The run folder and state

```text
<run>/
  STATE.md           start commands, host slots, Now block, append-only updates
  PROGRESS.md        counted outcomes, human actions, reversible decisions
  FOUND.md           discoveries and their durable dispositions
  briefs/            shared round briefs
  findings/          one file per review round
  jobs/<job>/        PROMPT.md, input copies, isolated clone if needed, outputs, tmp/
```

Rewrite Now at every update: clock date/time/zone, base ref/sha, branch tips;
worktrees/owners, heavy-run grants, next action and rows including coordinators/integration.
Each row: kind, actual handle (pending until returned), lineage/model, folder, ONE governing brief,
output, start time, coordinator. Never invent handles or select a brief from history.
A row leaves Now only after its result is recorded in an update.

Current: STATE.md's Host slots/start commands/Now; PROGRESS.md's count/rule/start commands/Human actions.
Rewrite those on resume to observed paths/state. History: STATE's creation header/Updates
and PROGRESS's Integrated or handed back/Decisions you can reverse.
Never rewrite history (old roots, evidence paths, decisions/handoffs); other event narratives stay history unless labelled current.
Append corrections/reversals. For a copied run, record the old-to-new root mapping
in a new update; translate paths for current access only, never global-replace files.

Append an update, newest last, whenever work launches, returns or stops;
a branch tip moves (including a fetch); a decision or human ruling arrives;
or context loss is approaching. Include evidence paths and quote rulings.
Write the update before the reply announcing the change. Update PROGRESS.md
when a counted outcome or human obligation changes. Record discoveries in
FOUND.md immediately, with the clock time, witness and proposed home.

Before expected context loss, write conditions on disk, not stale orders:
"if the output has a success witness and git confirms the commit, record it;
if the process is alive, wait within the recorded bound; otherwise inspect
the partial log and record STOPPED before deciding whether to restart."
Record process ids and the host's liveness check when processes are involved.

## Recovering after a lost context

Do this after built-in compaction, Jev compaction, a restart or a new lineage
taking over. Memory and a compaction summary are pointers, not current state.

1. Bootstrap also applies on resume: re-derive missing values, never stop for them.
   Re-derivation and prefixed temp creation are recovery setup, before task writes.
   Read this procedure whole, then STATE.md's slots, start commands, Now block
   and latest updates; PROGRESS.md; FOUND.md; and the findings for open rounds.
   Follow references into older updates when needed to explain a decision.
   Use the invocation's current root; retain the last saved update number/time
   before adding any update.
2. Verify recorded facts against git and disk, substituting filled paths/refs:

   ```sh
   <REMOVE_ENV> git -C "<repo>" rev-parse "<base>"
   <REMOVE_ENV> git -C "<repo>" worktree list
   <REMOVE_ENV> git -C "<worktree>" status --porcelain
   <REMOVE_ENV> git -C "<repo>" rev-parse "<branch>"
   <REMOVE_ENV> git -C "<repo>" merge-base --is-ancestor <candidate-sha> "<base>"
   ```

   Replace `<REMOVE_ENV>` with the effective supplied/derived prefix in all examples.
   Run status for every recorded worktree and check every branch tip.
   For ancestry, exit 0 means already integrated; exit 1 means not an ancestor;
   another error means unknown. If INTEGRATE squashes or rebases, use its
   recorded mapping and success witness too; ancestry alone cannot settle it.
3. Inspect every job folder for reports, bundles, output, stderr and exit
   status, including jobs still marked in flight. Read a builder report's
   first line and a reader verdict's last line, then their evidence.
   For a process-backed job, require its exit status and terminal report marker;
   missing exit evidence or a partial report leaves completion unknown. A native
   subagent instead needs the host's terminal completion signal and final report
   with verdict; it need not produce an exit file. Check the
   recorded process/handle with the host's liveness check; absence of output
   does not prove death. An inaccessible handle is unknown, not permission
   to run a second copy. Reconcile or stop the original before replacement.
4. Record an explicit comparison: last saved STATE update number/time on entry,
   newest timestamp inside FOUND.md and each round file (or none), their order
   and whether intervening events require missing entries. Use internal dates,
   never mtime; worker receipt versus stop time is not this comparison. Check
   every finding has clock, witness, voice (RAN/READ/decided/predicted) and home;
   append evidence-based corrections for omissions, never invent a prior RAN.
5. Capture any arrived, unrecorded result as the first recovery writes to the
   round file and STATE update, before path rebasing, other mutations or any
   chosen recovery/work reply. Reading evidence first is allowed. Capture objections
   and failed checks too; process exit zero alone is not task success. Write
   `Update N - context lost; state re-read from disk` and refresh Now together,
   before any chosen reply, not in a later update. List checks/disagreements/unknowns;
   update only current sections from observed facts and the recorded root mapping.
   After capture, recheck TOOLS probes if the runner/setup changed, before job work.
   Do not repeat a build, review or integration whose result already exists.

### With Jev installed

Read the compaction note, including its `Full transcript:` path and put-back
list of reports and prompts. A shortened or omitted delivery is a pointer:
read its named transcript record before relying on it, and persist any
unrecorded worker result in findings immediately. Distinguish the plugin's
sender frame from delivered text; a worker report is not user approval.
A figure absent from your own visible text must be looked up in the transcript
before you state it; a nearby surviving figure may describe something else.
The note or put-back list can be absent or incomplete; do not infer that no
workers returned. Verify the run folder and use available transcript evidence.

### Without Jev

Use the same recovery steps with any lineage's built-in compaction. Follow
transcript pointers if that host supplies them. If neither disk nor available
history holds a required fact, mark it unknown and recover the evidence or ask
for the missing fact. Do not fill it from a summary or relaunch on a guess.

## Brief and launch each worker

1. Make `<run>/jobs/<job>/` and `tmp/` under it. Copy in only the inputs the
   worker needs, with their base/tip shas: an archive or isolated clone,
   diff, prior reports and check scripts. Never give it a live worktree to edit.
   Do not copy session transcripts or memory into a cold reader's inputs.
2. Write PROMPT.md from [brief_builder.md](long-runs/templates/brief_builder.md),
   [brief_reader.md](long-runs/templates/brief_reader.md) or
   [brief_narrow.md](long-runs/templates/brief_narrow.md).
   Fill every placeholder and check none remain: write literal prefix, TMP and TEMP
   actually used to prepare this job, not just a reference or a host requirement.
   Paste the filled credentials note; a worker needs no host-supplied literals.
   A shared brief lives in `<run>/briefs/`; each worker's PROMPT.md names it
   and adds that worker's role, lineage, model and specific question.
3. Name ownership, allowed writes, inputs, exact outputs, checks, resource
   authorization and stop rules. Create/use the job's `tmp/` as TMP/TEMP while
   preparing it, and put those exact absolute values in its brief. On transport,
   map the recorded job root to the current brief folder; preserve original text.
   Keep a relative stop rule relative, with the measurements it compares.
   A predicted budget is not a hard ceiling unless the brief explicitly says so.
   Imposed pre-read actions are environment facts, not scope violations or blockers.
   After reading, choices obey the brief; report prospective scope conflicts first.
4. Before launch, write/map the Now row's ONE governing brief path and pending handle.
   Whoever launches, including an external party, reads that row and launches exactly
   its named file; never default to PROMPT.md or choose a filename from history.
   Send "Bootstrap, then read `<row's brief>` whole and follow it." Known literals are a convenience; probe TOOLS. Launcher restrictions may be appended.
   Save actual command, returned handle/model, start time, output paths and terminal
   marker immediately; launch intent remains discoverable if no handle was returned.
5. Save prior content as history. Revise the named file in place or write PROMPT_R2.md
   and update the row before handoff/launch; record the revision.
   Tell an existing worker to read that selected file; require its file/revision
   acknowledgement on return. Resume its thread; record replacement if it cannot resume.
6. A builder writes BUILD_REPORT.md starting `BUILT (<n> commits, tip <sha>)`
   or `STOPPED - <one clause>` and returns a git bundle. A reader writes its
   assigned report ending `VERDICT: APPROVE` or `VERDICT: OBJECT - <findings>`.
   CANNOT TELL is an objection with missing evidence stated. Require a subagent
   to return its report in its final message too, since file writes may fail.
7. On arrival, copy a subagent's verdict, each finding with witness, and checks
   not run into the round file *before any other work*. A headless report is
   already on disk: immediately record its path, terminal marker and facts in
   the round file/state update. Keep the job in Now until that recording is done.

## Running a builder and reviewing the result

The coordinator gets its own job row before launching a builder; the builder's
row names it. The coordinator (or orchestrator acting in that role) must:

1. Measure the target before editing when the job exists to make a failing
   operation succeed. If it fails for an unrelated reason, stop that dependent
   work. Passing newly written checks is not the target passing.
2. Name each commit, files, scope exclusions, hard ceilings, predictions and
   stop clauses in the brief. Remove host-specific clauses that do not apply;
   supply relevant host clauses verbatim. Keep independent commits moving past
   a stop only when the brief permits that and dependencies remain valid.
3. On return, verify the bundle and tip in isolation, read the entire diff
   against the exclusions, and rerun CHECKS outside the builder's sandbox.
   Run any checks deferred to TO_RUN_OUTSIDE.md within AUTH, or record them owed.
   Compare predictions with observations; quote output and who actually ran it.
4. Treat a reader's statement as a claim. Re-derive dependencies, figures and
   negative searches before building a fix. Label claims RAN, READ or NOT CHECKED.
5. Use [review_round.md](long-runs/templates/review_round.md) for each round.
   Spread readers across lineages when available; a builder should have a
   reader from another lineage. Record unavailable coverage. Batch fixes by
   the property that closes findings; each reader rechecks its own findings.
6. Apply REVIEW to the exact integration tip. Wait for every required reader;
   an exception needs the host's authorized ruling quoted, with readers still
   absent or objecting named in the integration evidence. Disclosure alone
   does not authorize skipping review. If this lineage cannot run the host's
   integration workflow, record READY FOR INTEGRATION with branch, tip,
   checks and message file, and hand it to the named integrator.

Fetch worker bundles only in the host-authorized integration location. Record
every ref movement and the INTEGRATE success witness; confirm git afterwards.
No worker writes the main checkout or integrates on its own authority.

## Claude Code

The source used background subagents with an explicit model and recorded id.
Its id could resume only inside the launching session; a fresh session used
the saved job inputs. Explore and Plan readers there did not load CLAUDE.md;
repeat required rules in the brief, and disclose inherited context before
calling a read cold. An actual cold read needs host isolation, not a role name.
Check a subagent's actual model in its transcript's assistant `model` fields;
the orchestrator model in metadata was not evidence of the worker's model.
Model aliases and their suitability belong in LAUNCH, not in this procedure.

The source starter used `<REMOVE_ENV> claude "<start-prompt>" --add-dir "<repo>"` from the
run folder with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` to load added
instructions. Project settings did not load from that added directory, while
session settings could restore environment values. Do not assume added-directory
instructions imply hooks or permissions. Other Claude launch arrangements:
not yet tried here. This generic procedure's first-use trial: not yet tried.

## Codex CLI (GPT lineage)

The source starter used `<REMOVE_ENV> codex --cd "<run>" --sandbox workspace-write "<start-prompt>"`.
Its Windows sandbox was reported to block worker network access. That is an
environment observation, not a universal Codex rule or a reason to escalate.
It also offered `--sandbox danger-full-access` under a separate human grant;
never pre-fill that grant in saved start commands or infer a child grant from it.
Codex did not load CLAUDE.md there; the start prompt explicitly requested RULES.

The source prescribed a host-local wrapper in `one` and `resume` modes with
a job folder, prompt file and output file. That wrapper is not shipped here;
LAUNCH must supply an installed equivalent and its exact syntax. The source
saved the returned session handle from stderr, resumed that same thread for
follow-ups and avoided ephemeral sessions. Its sandbox refused writes outside
the job folder and could not stop processes it started; those actions were
deferred to TO_RUN_OUTSIDE.md. It used a checked full interpreter path after
command lookup failed. Usage-limit messages ended the attempt, not a wait.
The source still lists real-Codex wrapper use as unproven. Other sandbox behavior
and direct headless syntax: not yet tried here. This procedure's first Codex trial
failed; corrections await re-trial. Do not generalize source environment limits.

## Gemini CLI

The source used Gemini as a narrow reader: one question answerable from two
files, writing VERDICT.md early and updating it after each row. Longer reads
were reported to time out without output. Its launcher used an explicitly
selected binary and model with `-p "<prompt>" --model "<model>" --sandbox`,
added the interpreter directory with `--add-dir`, and bounded the run with
`--print-timeout`. It captured stdout, stderr, exit status and start time,
set TMP/TEMP in the job folder and instructed small Python scripts to use `-I`.
The supplied source still listed real-model launcher use as unproven.

Its reader trial hit sandbox refusal on git; source notes also warn Python
may be refused. Supply needed git facts as files. After a refusal, record
NOT RUN and continue by reading; do not relabel READ as RAN. A quota message
ends the attempt. Gemini orchestration, cold Now-block reconstruction and
this generic procedure's first-use trial: not yet tried. A Gemini orchestrator
uses the same disk protocol with host-verified LAUNCH commands; do not assume
the reader launcher establishes orchestration support.

## Using this from Codex CLI or Gemini CLI

Install or copy this document and its adjacent templates locally; Jev is optional.
Resolve paths. Add this line to AGENTS.md (Codex) or GEMINI.md (Gemini), replacing
the placeholders; missing bootstrap literals are derived, never requested:

```text
For worker sessions outliving context or resuming them: read <procedure> whole; imposed earlier actions are environment facts, not violations or stop reasons. Then Bootstrap (names-only listing is the sole chosen unprefixed exception), derive missing prefix/absolute run/tmp, create temp dirs prefixed, and follow it. Supplied current values win; absence never requires asking.
```

Fill LAUNCH from the installed host's instructions without guessing new flags.
Keep the start/resume commands and run path in STATE.md and PROGRESS.md so a
first-time session can find both. A built-in summary never replaces those files.

## Progress, findings and finishing

PROGRESS.md's first line under the title is a count and its counting rule,
dated from the machine clock. Count separate deliverable types separately.
If scope changes, show the old and new denominator and why. Human actions
point to their durable home by id and title; do not copy a second question.
Keep exact integration success lines and reversible decisions with evidence.
Each finding must name its voice: RAN = executed; READ = inspected saved evidence
(attribute unchecked reader claims); decided = chosen; predicted = expected.
Reading a worker's RAN result is your READ, not your own execution.

Before ending, give every FOUND.md item a durable home from FINDING_HOMES or
`none` with a reason. A draft is owed until its filing is confirmed; record
the resulting commit or issue reference. File repository changes through an
isolated clone and INTEGRATE, within the run's authorized scope.
Record final tips, checks run and not run, remaining jobs and the next action.
Never say complete while work or dispositions required by the run remain owed.

## Resource and execution limits

Heavy runs require authorization recorded in Now: command, worker and bound.
Serialize timing-sensitive checks according to CHECKS. Recheck failures seen
under contention alone before treating them as defects. No machine-wide process
priority changes or shared locking protocol is supplied by this procedure.
Write shell code containing backticks or substitutions into files with a safe
editor, then execute the file; do not interpolate it through another shell.
Use bounded waits or recorded background jobs, never an endless follow command.
Stop only processes you started, by recorded id; delete only your own exact paths.
If AUTH allows broader access for a named task, record base/branch tips,
worktrees and statuses before and after; report changes outside the job first.
Never print environments, settings/configuration dumps or credential values.
If output contains a suspected secret, report its location without quoting it.

## Not yet proven by use

- First-use completion and cold recovery of this generic version in any lineage.
- Real host launch/resume commands, credential controls and settings inheritance.
- Cross-lineage takeover, review and integration under a new host's policies.

This is a disk protocol followed by the sessions, not automatic enforcement.
The templates do not launch workers, capture reports, strip credentials or
verify git. Host controls enforce only what the host actually implements;
state updates, immediate report capture and recovery checks remain on the sessions.
