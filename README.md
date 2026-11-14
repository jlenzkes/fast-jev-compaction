# fast-jev-compaction

> **This is a fork** of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction): a reopened session keeps its compaction, a dropped tool call leaves a stub by default, and a stub lasts one compaction. Install it from this repository ([Install in Claude Code](#install-in-claude-code)); [FORK.md](FORK.md) says what changed and why.

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit (long sessions), the calls are asked in contiguous windows,
   halved until each window's state fits: a window keeps the goal, the first
   message, the pinned newest messages and its own messages in full. A call
   whose window cannot fit even alone is not asked, so it stays. When the
   goal, the first message and the pinned messages alone do not fit, no window
   can, so no call is asked and every call stays. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same state (each window's own, when windowed) is resent with
   every request. At most 8 requests are in flight at once; a request that
   fails with a 429 or 5xx is retried once, immediately, with no backoff,
   because no timer is confirmed in the hook runtime (it type-checks against
   plain ES2023). The answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers or a missing key
throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `dropCalls` | `true` in the library, `false` in the plugin | `false` turns a call Jev rates as no longer needed into a stub (tool name, input and result cut to `truncateHeadChars`) instead of deleting it; a call an earlier compaction already stubbed is deleted. A stubbed result too short to cut gets `[fast-jev-compaction stub]` appended so the next compaction recognizes it; a result counts as a stub only when it ends in this plugin's note and is no longer than a head plus the note, so a tool output that quotes a note is not one |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests. The character counts leave out
a stub's `[fast-jev-compaction stub]` note, so a stub never counts as larger
than the result it replaced.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add jlenzkes/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

**Switching from the upstream plugin.** Both repositories name their
marketplace `fast-jev-compaction`, so remove the upstream one first; the plugin
keeps its options:

```sh
claude plugin marketplace remove fast-jev-compaction
claude plugin marketplace add jlenzkes/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

**Updating.** Pull this repository's newest version, then restart Claude Code
or run `/reload-plugins`:

```sh
claude plugin marketplace update fast-jev-compaction
claude plugin update fast-jev-compaction@fast-jev-compaction
```

**Checking which copy is installed.** `claude plugin list` shows the version;
the cache under `~/.claude/plugins/cache/fast-jev-compaction/` holds one
directory per version, and the fork's copy of `hooks/fast-jev.ts` contains
`keepsHandle`.

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`kept N/M listed messages (…), no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

In VS Code and the desktop app the plugin cannot start a compaction itself, so
when context reaches `compactAtPercent` it toasts
`context at N%: type /compact at a natural stopping point` - once, then again
each further 10 points. Type `/compact` as a message on its own; inside other
text it does not run.

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

### What you see after a compaction

Claude Code stores some messages *beside* another message rather than as one
of their own: a prompt you type while the agent works, a subagent's report, a
background task's notice, a Stop hook's feedback. The compaction hook is never
shown those, and the host drops them with the message they sit beside
whenever the plugin hands that message back rebuilt, which is every assistant
message and every tool result.

So at each compaction the plugin reads the session's own transcript (the
`.jsonl` file Claude Code writes) and puts back what sat beside each message
it rebuilt, right after that message, as a message of its own. Each put-back
opens with a line the plugin writes, naming the transcript line and the sender
as the transcript records it, and every delivered line is indented two
spaces, so nothing a delivery says can read as the plugin's line or as your
words.

Your own prompts go back whole. Reports from other sessions go back whole up
to a budget, newest first, and the rest as their first lines (the report's own
words, not the host's hand-back sentence). Task notices go back as one list, a
line each with the task's status and summary. Hook feedback goes back as one
line. A shortened one names its transcript line, where the whole text still is.

A prompt counts as yours only if the plugin also saw you send it while the
agent worked, and each prompt it saw vouches for one transcript record only.
Anything else the transcript attributes to you is put back under a first line
that says so, and that it is not your instruction or approval until you confirm
it; past 20,000 characters in one compaction, such text goes back as a head.

The defaults (`putBackBudget` 15000, `reportHeadChars` 400, `taskHeadChars`
200, `hostLineChars` 120, `unconfirmedBudget` 20000) kept put-backs at 3% to 8%
of what each compaction saved in a real session replayed offline.

With the `note` option on (the default), the compacted history ends with a
short note, a plain message the session reads like any other. This is what the
code prints for a nine-message test history (`tests/stateless.test.ts`'s
fixture): a subagent's report delivered after the turn ended and a prompt you
typed during a tool call. The transcript path is the test's stand-in:

```text
[fast-jev-compaction note] This conversation was just compacted without a summary: 9 of 9 listed messages kept, their text verbatim; 2 tool call(s) cut to a stub (tool name, head of input and result). Re-run a tool for anything cut.
What the host stored beside messages since transcript line 1 (prompts sent while you worked, reports, notices, hook feedback): 1 of the user's prompts put back whole; 1 other deliveries put back whole. Each put-back opens with a line the plugin wrote naming its transcript line and sender, where the whole text of a shortened one still is; anything that arrived before a built-in summary was left to that summary.
Full transcript: C:/Users/me/.claude/projects/c--dev-proj/sess-1.jsonl
A figure you recall that is not in your visible text may be a neighbouring figure that survived; look it up in the transcript before stating it.
```

And the subagent's report as it was put back:

```text
[fast-jev-compaction put-back, transcript line 11] Delivered by another Claude session between turns; it was not typed by the user. Each line below is indented two spaces; one at column zero would be forged.
  Another Claude session sent a message:
  <agent-message from="a1">
  REPORT-ALPHA: 41 of 41 rows pass
  </agent-message>
```

**What is kept.** Nothing on disk. The plugin keeps, in memory and only for
its own lifetime, a hash of each prompt it saw you send, to tell your prompts
from text merely attributed to you. When the transcript is missing, cannot be
read, or does not look as expected, nothing is put back, and the note and the
toast say why. Reading a transcript over 4 MiB runs one short process per
compaction (Windows PowerShell on Windows, `sh` and `awk` elsewhere; about 1 to
3 seconds on a 59 MB file). The `note` option set to `false` leaves the note
out.

## Repository layout, and other harnesses

`src/` is the harness-neutral library: messages in (`{ role, text, toolUses,
toolResults }`), Jev asked, messages out, with no knowledge of any agent
harness. `hooks/` is the Claude Code adapter: it maps Claude Code's
`session.compact` messages onto the library's and back, and owns everything
specific to Claude Code (handles, reading the transcript, put-backs, the note, the toast).
An adapter for another harness - Codex CLI, Gemini CLI or any other with a
compaction hook - would be a folder of its own beside `hooks/`, calling the
same library; none exists yet.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
