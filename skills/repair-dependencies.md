# Repair broken dependency install

Use when `npm install` or similar fails in a project you are working on.

1. Read the FIRST error only — later errors are usually consequences.
2. Identify whether it is a cache issue, peer-conflict, missing binary, or a
   real code-level import problem. Do not delete the lockfile reflexively.
3. Fix the root cause (correct version, approval for install scripts, missing
   peer, wrong import path), not the symptom.
4. Verify: run the project's own typecheck/build, not just the install.
5. Report what specifically was wrong and what you changed.
