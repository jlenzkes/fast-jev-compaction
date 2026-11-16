---
name: long-runs
description: Keep worker briefs, results and run state on disk for a session launching workers, or resuming one, whose work will outlive its context window through compaction, restart or handover.
---

Read `${CLAUDE_PLUGIN_ROOT}/docs/long-runs.md` whole, from the plugin's install
directory, before acting. Follow that procedure and its adjacent templates.
It is experimental; no lineage has passed a first-use trial of this version yet.

Until you have read it, keep these three rules:

1. Write state changes to disk before reporting them; record every worker's
   result the moment it arrives, before replying or doing other work.
2. Give every worker a file brief and job folder; record its handle and
   expected output in STATE.md when launching it.
3. After compaction, restart or handover, read and verify the run on disk
   before acting. Look for completed results before relaunching anything.
