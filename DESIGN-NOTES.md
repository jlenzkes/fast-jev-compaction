# Design notes: delivered prompts and the receipt

For a maintainer. What `hooks/` guesses about state Claude Code does not show
a plugin, what happens when a guess is wrong, and where untrusted input enters.
The rules the code keeps:

1. A guess may fail only toward a **duplicate** (a second, labelled copy),
   never toward a **loss** (something someone said disappears) or a
   **misattribution** (it reads as someone else's words). Three exceptions
   can lose words, each stated in the table with its basis: the same words
   typed twice in one window, the host's keeping what sits beside a plain
   user message (measured), and a placed put-back the host does not keep
   (measured not to happen; reported if it does).
2. Every untrusted input is checked or bounded where it enters. A bad one is
   ignored and the receipt says so; nothing throws before the built-in
   fallback can run.

## Inferences about hidden host state

| What the plugin infers | From | If wrong |
|---|---|---|
| A prompt is stored beside a message, not as one | It reached `prompt.submit` with a `turnId`, or its **accepted** origin is not the user's (idle prompts the host lists as their own message) | Put back although the host lists it: the listing then shows the same text, which counts as present (below), so at worst a **duplicate** |
| Where it sits | The newest messages `$.session.messages()` held when `prompt.submit` ran (the last tool result and fingerprints of the last 8 messages; only that tail is read, though the call answers the whole chain, which grows with each compaction). Measured in headless probes on 14 Nov 2026: `prompt.submit` runs after the tool result the prompt then sits beside is stored | **Misplaced, unlabelled**, if a host calls `prompt.submit` at Enter instead: on the real 778-message input, 14 of 36 mid-turn deliveries then land two or three messages early (none lost or split from a tool call). **Misplaced**, labelled: a point not found makes an orphan, put back after the latest earlier put-back (else at the end) with a first line saying its place is unknown and it may also appear elsewhere. A mid-turn prompt whose turn ended with no tool result goes at the end of its turn, saying so. A prompt delivered while a compaction runs (whether a host does this is not known) is anchored to the history before it; if that compaction deletes its point, it becomes such an orphan |
| The host already lists the delivery itself | A listed plain user message whose text is **exactly** the delivered text, after the delivery's point and before the next tool result, each listed message matching at most one delivery | **Loss** only if the user typed the very same words again in that window, before any tool ran; then they are one message in the history |
| The host keeps the delivery itself | Its point is a plain user message, which the plugin hands back whole with its handle. **Measured**, not guessed: over 26 plugin compactions, 159 of 159 deliveries beside such a message survived when that message did; the 12 exceptions are explained (the message itself was gone, or it was a `Compacted` line whose text recurs) | **Loss** if the host stops keeping them. If that message is itself gone, the point is not found and the delivery is put back as an orphan |
| A listed message is the plugin's own put-back or receipt | Its first line names an id the record holds, and the rest is exactly that record's delivered text (indented) or matches its SHA-256; each record matches at most one message, the first | Look-alikes and pastes are ordinary text everywhere: anchors, receipts, the goal, the debug log. A paste of a real receipt after the receipt itself is kept |
| A compaction's result was installed | The trigger is not `precompute` and the plugin's list was returned. Measured: the host keeps plugin-built messages in place, word for word, and lists them with handles next time | A put-back the next listing does not show is reported as missing in the receipt (its text is no longer held). A precompute changes no record except adding its receipt's id |
| A built-in summary preserved a delivery | Never inferred. The summary is handed the deliveries; nothing is retired for it | **Duplicate**: still-pending deliveries come back as orphans at the next plugin compaction |
| Which session a call belongs to | `$.session.id()`, checked to `[A-Za-z0-9-]`, else hashed | Two sessions sharing an id share a record: **misplaced** deliveries, labelled as orphans |
| Who sent it | The origin `next` returned (absent means the user's own, by the type reference) | The plugin gives what the host gives: an `sdk` prompt stands as the user's, as the host renders it. It cannot attest more |

## Untrusted inputs

| Input | Enters at | Checked or bounded |
|---|---|---|
| Delivered text and context | `prompt.submit` | Stored as given; every line indented under the plugin's first line when put back; one quoted line of at most 100 characters in the receipt; a record over 512 KiB serialized is dropped and reported |
| Origin fields (`kind`, `name`, `server`) | `prompt.submit` | `kind` mapped by a fixed table, unknown ones labelled as unattributed; names reduced to `[A-Za-z0-9._:@/-]`, 40 characters |
| Listed message text | `session.compact`, `$.session.messages()` | Treated as data. Only an exact match to a record makes a message the plugin's own |
| The stored record (`$.store`) | load | Schema version 2; every delivery and every list item validated on its own; bad ones dropped, deleted and counted in the receipt; a failing store switches to memory and the receipt says so |
| Store size | every write | Bounds count the serialized JSON (UTF-8 bytes): 100 deliveries and 512 KiB per session, 6 sessions; the new value is written before anything is deleted; drops and evicted sessions are counted and reported |
| Session id | `$.session.id()` | Characters checked; otherwise hashed |
| Options | `resolveHookConfig` | Numbers must be finite; `receipt` and `dropCalls` must be booleans |
| Transcript path | environment and `$.session.cwd()` | Named only if it exists; the whole receipt is cut to 4000 characters, path included |
| Debug log path | `FAST_JEV_DEBUG_LOG` | Off unless set; writes only lengths, hashes, ids, roles, counts and fixed strings |

## Removed rather than hardened

- Recognising receipts by their shape (any text starting like a receipt).
- Text equivalence beyond exact equality (a message that starts with the delivered text).
- Assuming a delivery handed to the built-in summary survived.
- A goal built from guessing who wrote a message (host notices, header spelling).
- Up to three stored copies of each put-back's text; a placed delivery keeps only its id and a hash.
- The per-compaction mark; each put-back and receipt has its own id.
