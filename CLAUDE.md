# clinic-pharmacy-tool: notes for Claude Code

## What this repo is

A standalone, multi-tenant clinic pharmacy and stock app. The design is Spec 06 in `docs/specs/` (06 index, 06a design, 06b acceptance). It is stopped before code until the spec is approved.

## Writing or revising a spec

1. `git fetch`, and confirm the working branch contains current `origin/main` (`git rev-list --count HEAD..origin/main` must be 0).
2. Record this in the spec header:
   `**Written against:** clinic-pharmacy-tool origin/main @ <sha> (fetched YYYY-MM-DD)`.
   Add the Ritu Desk `origin/main` sha whenever the spec relies on Ritu Desk conventions.
3. If the branch is behind, rebase, or re-check every claim about existing code before writing.
4. Any claim about deployed infrastructure says how and when it was measured.

## Boundaries

- **Standalone.** No code, table, package or runtime call depends on Ritu Desk, its voice server, or Ritu Desk's Spec 07. Ideas may be borrowed and restated; code is not shared. The one exception is the UI kit, which starts as a copy owned by this repo (06a §1.2).
- **Stack.** It defaults to Ritu Desk's (06a §1.2). Propose a different tool only with a reason written into the spec.
- **No secrets or patient data** in logs, test output, commits or chat. Tests use synthetic data only.

## Before every push

1. **Confirm the repo's visibility first:** an unauthenticated request to `https://api.github.com/repos/<owner>/<repo>` (200 = public, 404 = private). Say which it is before pushing.
2. **Never put any of these in this repo** (files, commit messages, branch names, PR text):
   - client names (clinics using Engageo products);
   - patient data, real or derived;
   - security findings or incident notes;
   - infrastructure details of Ritu Desk or any other Engageo system: hosts, ports, project or service names, database layouts, roles, secrets, weaknesses.

   Incident notes live only in the private Ritu Desk repo. Use generic examples ("the pilot clinic", "a branch in Gujarat").
3. **Scan before pushing** for those terms. If anything slipped into history, stop and ask before rewriting it.
