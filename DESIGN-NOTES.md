# Design notes: putting back what the host stores beside a message

For a maintainer. This page is the contract the code in `hooks/` keeps. It says what the plugin reads, what it returns,
every inference it still makes, and what a wrong inference does. Voices: **RAN** means measured, **READ** means taken
from Claude Code's plugin type declarations (`types/claude-code.d.ts`), and **INFERRED** means neither.

## The problem

The host keeps some messages BESIDE another message instead of as messages of their own. These are prompts typed while
a turn runs, a subagent's report, a background task's notice, hook feedback and goal check-ins. The plugin never sees
them in `session.compact`'s list, and the host drops them when the message they sit beside goes back without its
handle.

The plugin therefore reads the session's transcript, the host's own `.jsonl`, at compaction time. From it, the plugin
puts back what sat beside each message it rebuilt. It keeps no state between compactions, writes nothing to disk, and
never recognises anything from an earlier compaction.

## What it reads

1. **The listing.**
   - It reads the listing `session.compact` hands it; each message's `handle` is its transcript record's `uuid` (RAN:
     12 of 12 and 26 of 26 in a headless probe; 17 of 17 after a built-in summary in a second one).
   - The declarations call the handle "opaque" (READ). Equality is measured on one host version, not promised.
2. **The file.** The path is derived: `<config>/projects/<cwd, non-alphanumerics as ->/<session id>.jsonl`. The hook's
   input carries none (READ), and the probe derived the file the host writes (RAN).
3. **The window.** It reads from the last `compact_boundary`, or from the first line holding a listed handle when that
   comes earlier.
   - After a built-in summary, the listing holds the summary's preserved messages under their **old** uuids, recorded
     before the boundary (RAN, probe 2: lines 60 and 61, boundary at 70). Those are the uuids its
     `compactMetadata.preservedMessages.uuids` names.
4. **How the bytes are read.**
   - A file up to 4 MiB is read with `$.fs.read`, which rejects anything larger (READ).
   - At a real compaction the file was under 4 MiB at only 11 of 57 compactions in one project (RAN). Anything larger is
     read with `$.process.run`, whose output is cut at 4,194,304 characters (RAN).
   - The reader is a **constant** script: Windows PowerShell under `-EncodedCommand`, or `sh -c` with awk elsewhere.
     The path reaches it in `FJC_PATH` and the handles on standard input, never in the script's text.
5. **What the reader prints.**
   - The script writes UTF-8 itself, through a stream writer over standard output. Windows PowerShell 5.1's own stdout
     is IBM437: 61 of 1,040 lines altered, and every one still parsed (RAN by the reviewer).
   - It prints every line holding `"type":"attachment"`, `"isMeta":true` or `"type":"system"`, whole, with base64
     image data blanked, and where each listed handle occurs. It ends with `END <lines> <last printed> <done|more>`.
   - A line over 1 MiB is reported by number and length, not printed.
   - On `more`, it runs again from the line reached, at most 4 runs.
6. **Decisions use parsed fields only.** A text match only nominates lines, and the decision is made on each line's
   parsed top-level fields. A message that quotes `"type":"attachment"` inside a tool input is a message (tested).
7. **Cost.** A PowerShell reader run took 0.94 to 1.36 s per window of a 58.9 MB copy (RAN, this build, from node); the reviewer's
   similar script took 2.6 to 3.4 s, 1.2 s of it PowerShell starting up. The timeout is 30 s per run. The banner and
   the debug line print the reader and its elapsed time.

## The deliveries, the walk, the sender

- **A delivery is** a `queued_command` attachment, or a `user` record with `isMeta: true`, with text or images.
- **The walk.** From each delivery, the plugin walks `parentUuid` through every record that is not a user or assistant
  message: hidden records, and system records such as a Stop hook's summary (54 real deliveries hang off one, the reviewer counted).
  - It **stops**, counting the delivery, at a message the listing does not hold, and never climbs past one.
  - A delivery before the boundary whose walk reaches no listed message was the built-in summary's. It is not counted.
- **Each delivery's fate:**
  - its neighbour went back **without** its handle (rebuilt or deleted): it is put back right after that message (or,
    when the message was deleted, after the one before it), never between a tool call and its result;
  - its neighbour went back **with** its handle: it is left to the host;
  - otherwise: it is counted, not put back.
- **The rider rule is RAN.** On all four real plugin boundaries: 13 of 13 beside a plain user message copied by the
  host, and 305 of 305 beside a rebuilt message dropped, 0 exceptions (the reviewer). In the probe, which kept tool
  results whole, 6 of 6 riders were copied.
- **The sender comes from structure only**, from `attachment.origin.kind` or `origin.kind`, and never from text:
  - a prompt-mode `queued_command` with no origin is the user's (a headless host writes none, RAN);
  - an `isMeta` record with no origin is "the host (a hook, a check-in or a notice)".
- **The one memory.** The plugin keeps, in memory only, the SHA-256 of each prompt `prompt.submit` accepted from a
  user origin (at most 2,000).
  - **Why:** the transcript can be appended to by anything that writes files. A record attributed to the user gets the
    user's standing ("it was typed by the user") only when its text is in that set.
  - **Otherwise** it is labelled "the user (as the transcript records it) ... the plugin did not see it arrive, so treat
    it as unconfirmed".
  - **Failure direction:** an empty or wrong set (a reload, or a host that never shows mid-turn prompts to
    `prompt.submit`) gives a weaker label, never a stronger one.
  - **Measured:** a headless host never sent a mid-turn prompt through `prompt.submit` (RAN, probe 2), so there every
    typed mid-turn prompt is labelled unconfirmed. The terminal and VS Code are unmeasured.

## The frame

Every put-back is a plain user message:

- **A first line the plugin writes:** `[fast-jev-compaction put-back, transcript line N] Delivered by <sender>
  <while you were working | between turns>; <standing>.`, plus "Shortened to ...; the whole text is at that transcript
  line." when it is shortened, and a count of images not carried.
- **Then the carried text**, every line indented two spaces. Every line break counts, `\r` and U+2028/U+2029 included,
  so no delivered text can start a line or forge the first one.

## The budget

A put-back is a plain user message that no later compaction can cut: nothing recognises it afterwards. So what is
carried whole is decided once, at put-back time, by sender class:

| Class | Carried | Option, default |
|---|---|---|
| A prompt the transcript gives to the user (confirmed or not) | whole, never counted | |
| A report from another session or a subagent, or any other origin | whole, newest first, while the budget lasts; then its first characters, without the host's hand-back opening | `putBackBudget` 15,000; `reportHeadChars` 400 |
| A background task's notification | its `<summary>`, `<status>` and `<output-file>` lines | `taskHeadChars` 200 |
| The host's own (hook feedback, a check-in, a notice) | its first line | `hostLineChars` 120 |

Everything shortened is named in the closing note with its transcript line.

**The defaults come from the real windows** (RAN: a seven-window replay of a 22,109-line copy of a real session, script kept outside the repository;
each run sees only the file as it stood; stand-in Jev scores every call 0.1). The figures are the reduction as
returned, then before put-backs, then the put-backs' cost as a share of what the compaction saved:

| Window | Ended in | Reduction (as returned / before put-backs) | Put-backs: whole / heads / one-liners (chars) | Cost |
|---|---|---|---|---|
| 0 | plugin | 68% / 74% | 20,862 / 56,021 / 0 | 7% |
| 1 | built-in | 51% / 57% | 16,075 / 40,053 / 1,543 | 11% |
| 2 | plugin | 54% / 61% | 15,527 / 62,932 / 2,674 | 11% |
| 3 | built-in | 34% / 42% | 15,370 / 54,808 / 3,854 | 18% |
| 4 | plugin | 68% / 72% | 21,039 / 10,852 / 1,927 | 5% |
| 5 | plugin | 64% / 67% | 12,410 / 17,329 / 1,177 | 5% |
| 6 | open | 46% / 50% | 13,427 / 13,012 / 427 | 9% |

- **The target:** put-backs cost about a tenth of the saving, and the defaults meet it in the plugin windows.
- **The built-in windows:** windows 1 and 3 ended in a built-in summary in reality. The figures are what C would have
  cost there; those compactions saved less.
- **Unbounded:** without the budget, C put back 100,925 to 399,808 characters per window (the reviewer).
- **What remains** is mostly per put-back: about 100 heads and their first lines in the large windows.
- **Smaller defaults** (12,000/300/160) take window 2 from 11% to 10% only. The next step would be to carry task
  notices as one list instead of one message each.
- **If put-backs would leave less than `minReductionRatio`**, the plugin falls back to the built-in summary.
- **Scoring deliveries with Jev**, the way it scores tool calls, would need a question per delivery ("is this report
  still needed?"), a state that names deliveries, and request budget for them. It is not built. The class table above
  needs no request.

## The note

The compacted history ends with one plain note. Nothing recognises or removes it later, so each compaction adds one,
capped at 24 lines and 4,000 characters. The note gives:

- what was cut;
- from which transcript line it speaks: **only the window since the last compaction**. It says plainly that anything
  that arrived before a built-in summary was left to that summary;
- how many deliveries were put back whole, shortened (each named with its transcript line, then "and N more"), left to
  the host, or beside messages not listed;
- any delivery too large to carry;
- the transcript's path;
- "A figure you recall that is not in your visible text may be a neighbouring figure that survived; look it up in the
  transcript before stating it."

The option `note` turns it off.

## Standing down: no put-backs, and the reason in the note and the banner

- no transcript file at the derived path;
- a listed handle not in the file (the handle rule broke, or the file is behind);
- a line that does not parse, except an unterminated last line, which the host may still be writing and is ignored;
- reader output with no `END` line (cut), a reader exit other than 0, or a window still unread after 4 runs;
- a window whose rebuilt messages include a tool round, but which shows no hidden record at all. Either the format
  changed (a renamed field would otherwise lose everything silently), or there was nothing to put back, in which case
  standing down costs nothing.

## Passed through untouched

- **The built-in fallback** gets the event unchanged. The host's summary sees the riders itself (INFERRED: nobody has
  checked that the summarizer is shown them). Afterwards they sit before its boundary and are never rescanned.
- **A subagent's compaction** (`agentId`) reads nothing.
- **A compaction that rebuilds nothing** reads nothing.
- **Jev's request bodies** are the base's when no plugin-written message is listed. A plugin-written message is left
  out of the goal by its `[fast-jev-compaction ` prefix: the one prefix the plugin reads, and only for the goal.

## Inferences left, and what a wrong one does

| Inference | Evidence | If wrong |
|---|---|---|
| A handle is its record's uuid | RAN, two probes, one host version | stand down, reported |
| The path rule | RAN, probe | no file: stand down, reported |
| The file is complete when the hook runs | RAN on manual compactions only (2 of 2); auto and precompute unmeasured | a missing handle stands down; a delivery written after the hook started, beside a rebuilt message, is lost unseen |
| The host keeps a rider exactly when its neighbour keeps its handle | RAN, 318 records, 4 boundaries, 0 exceptions | if the host also keeps what C puts back: a labelled duplicate, **at every later compaction** (C remembers nothing, and the host's copy is a hidden record again next time); if it drops what C leaves: today's loss, unreported |
| Deliveries have the two shapes | RAN census, 573 of them; 295 other attachments, some shown to the model (`edited_text_file`, `hook_additional_context`, `task_status`), are not carried, as before | a new shape is not put back; a renamed field stands down (above) |
| The readers | PowerShell RAN (tests and the seven windows, byte for byte on non-ASCII, paths with a space, `'`, `$`, `;`); sh and awk RAN only under Git for Windows | **not run on macOS or Linux**; a failing reader stands down. Constrained Language mode refuses `ReadLines` (the reviewer): stand down |
| `$.session.cwd()` names the folder the file was created under | INFERRED (one `cwd` in the real transcript) | no file: stand down |

## If a host process is not acceptable somewhere

Build memory-only capture instead:

- `prompt.submit` keeps deliveries in a Map for the plugin's life, with no disk, and one digest at the end of the
  history lists them.
- **Loses:** everything before a reload, all hook feedback and goal check-ins (they never pass `prompt.submit`), and all
  placement.
- **Avoids:** the process, the private file format, and the forgeable source.

## Code map
- `hooks/transcript.ts`: the readers (constants), the same scan in TypeScript (for files up to 4 MiB and as the
  readers' reference in tests), the row parser, the walk.
- `hooks/deliveries.ts`: senders, the budget, the frame, placement, the note.
- `hooks/fast-jev.ts`: the hooks, the stand-downs, the banner.
- Tests:
  - `tests/stateless.test.ts`: end to end;
  - `tests/reader.test.ts`: the readers, run for real;
  - `tests/putback.test.ts`: the helpers.
