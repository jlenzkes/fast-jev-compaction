# This fork

A fork of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), kept so that the changes below survive plugin updates. It installs as the same plugin, `fast-jev-compaction@fast-jev-compaction`, from this repository's marketplace.

Based on upstream `e3f262a7` (main as of 18 Sep 2026). Upstream's history is untouched; the fork's changes are the commits on top of it.

## What it changes, and why

**1. A reopened session keeps its compaction.** A message the compaction rebuilt kept the stored handle of the message it came from, and a reopen (`--resume`, or a reloaded VS Code window) followed that handle back to the full transcript, so the compaction was lost. Only a plain user message now keeps its handle. Taken from the `keepsHandle` condition in [myjunior/fast-jev-compaction@3625879](https://github.com/myjunior/fast-jev-compaction/commit/3625879). Measured on 9 Nov 2026: 168 of 168 kept messages present after compaction, 179 of 179 after a reopen.

**2. A dropped call leaves a stub.** Upstream [PR #83](https://github.com/tamaratran/fast-jev-compaction/pull/83) by its author, cherry-picked with authorship kept: when Jev rates a call as no longer needed, the call keeps its tool name and the head of its input, and its result becomes a truncation note, instead of the call and result being deleted.

**3. Stubs are the default.** PR #83 keeps deleting by default; this fork defaults `dropCalls` to `false`. A compaction that deletes calls leaves the model's own earlier reports with nothing behind them, and a session then repeats claims whose evidence is gone. An explicit `dropCalls` option still wins.

## Deliberately not taken

- **Upstream PR #139** gives rebuilt messages their handles back, which undoes change 1.
- **Upstream PR #98** drops every handle, which also loses hidden reasoning and images kept on user messages.

## Taking upstream changes

```bash
git fetch upstream
git merge upstream/main
```

Then check that `keepsHandle` and the `dropCalls` default of `false` survived the merge, in `hooks/fast-jev.ts` and `.claude-plugin/plugin.json`.
