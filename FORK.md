# This fork

A fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), kept so that the changes below survive plugin updates. It installs as the same plugin, `fast-jev-compaction@fast-jev-compaction`, from this repository's marketplace.

Based on upstream `e3f262a7` (main as of 18 Sep 2026). Upstream's history is untouched; the fork's changes are the commits on top of it.

## What it changes, and why

**1. A reopened session keeps its compaction.** A message the compaction rebuilt kept the stored handle of the message it came from, and a reopen (`--resume`, or a reloaded VS Code window) followed that handle back to the full transcript, so the compaction was lost. Only a plain user message now keeps its handle. Taken from the `keepsHandle` condition in [myjunior/fast-jev-compaction@3625879](https://github.com/myjunior/fast-jev-compaction/commit/3625879). Measured on 9 Nov 2026: 168 of 168 kept messages present after compaction, 179 of 179 after a reopen.

**2. A dropped call leaves a stub.** Upstream [PR #83](https://github.com/tamaratran/fast-jev-compaction/pull/83) by its author, cherry-picked with authorship kept: when Jev rates a call as no longer needed, the call keeps its tool name and the head of its input, and its result becomes a truncation note, instead of the call and result being deleted.

**3. Stubs are the default.** PR #83 keeps deleting by default; this fork defaults `dropCalls` to `false`. A compaction that deletes calls leaves the model's own earlier reports with nothing behind them, and a session then repeats claims whose evidence is gone. An explicit `dropCalls` option still wins.

**4. A stub lasts one compaction.** A call an earlier compaction already cut to a stub - its result is this plugin's truncation note, and its input is already cut or short - is deleted when Jev still rates it as no longer needed (decision `stub_dropped`). Stubbing it again would cut nothing, so without this, stubs pile up: each compaction of a long session has less it can cut, until it falls under `minReductionRatio` and hands over to the built-in summary, and the session loses its verbatim history. Seen on 11 Nov 2026 in one session's fifth compaction, the second with stubs on: 411 calls stubbed, a 25% reduction against the 25% minimum, four Jev requests thrown away, then an 89-second built-in summary in place of the sub-second compactions before it. Jev is still asked about every stub, and a stub it rates as still needed stays.

**5. Where the host cannot compact, the plugin nudges instead of failing every turn.** VS Code and the desktop app run Claude Code as an SDK session, which refuses the `turn.complete` hook's `$.session.compact()` (upstream issue #150, open). Upstream logs `auto-compact skipped (...)` on every turn above `compactAtPercent`. The fork remembers the refusal and toasts `context at N%: type /compact at a natural stopping point` once on crossing the threshold, then again each further 10 points; a compaction, or context falling below the threshold, starts the count again. The threshold stays 60: in the session that prompted this, the operator's own `/compact`s landed between 57% and 67% of a 1M window, and the nudge only advises, so an early first nudge costs one line. Hosts that can compact behave as upstream does. Its tests are in `tests/hook.test.ts`.

The plugin's tests were brought in line with changes 1 and 3, which upstream's tests still assert against.

## Install

See [Install in Claude Code](README.md#install-in-claude-code) in the README, including how to switch from the upstream plugin and how to update.

## Deliberately not taken

- **ibernato's [1390ce1a](https://github.com/ibernato/fast-jev-compaction/commit/1390ce1a)** answers the same refusal by submitting `/compact` as a prompt when the session is idle. Not taken: it compacts at a moment nobody chose, possibly mid-task with background work running, and under change 4 each compaction deletes the stubs the previous one left, so compacting early costs history. Untested in VS Code whether a submitted `/compact` runs as a command.

- **Upstream PR #139** gives rebuilt messages their handles back, which undoes change 1.
- **Upstream PR #98** drops every handle, which also loses hidden reasoning and images kept on user messages.

## Taking upstream changes

```bash
git fetch upstream
git merge upstream/main
```

Then check that `keepsHandle`, the `dropCalls` default of `false` and `alreadyStubbed` survived the merge, in `hooks/fast-jev.ts`, `.claude-plugin/plugin.json` and `src/compact.ts`, and run `npm test`. Bump the version in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together, or `claude plugin update` will not see the change.
