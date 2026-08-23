---
name: pr-review
description: Orchestrated PR review — planner, parallel micro-agents, confidence-gated merge.
disable-model-invocation: true
---

# PR review (orchestrated)

## Goal

Beat single-pass review on recall via **planner → specialized micro-agents → merge**. This skill is the orchestration layer only.

## Ownership (do not drift)

| File | Owns |
| --- | --- |
| This `SKILL.md` | Diff source, output format, specialist selection, merge, modes |
| `reference.md` | Shared constraints (severity scale, confidence gate, line-number rule, tool rules, finding schema) + specialist charters |

## Severity

The P0–P3 scale and the confidence gate are defined once, in `reference.md`'s shared constraints. Read them before planning; the output and merge below use those definitions.

## Output

1. `**N issues found** across X files` (or no issues)
2. Table: Severity | Location (`file:line`) | Finding
3. Each finding: `P{N}: <what breaks + who is hurt>. <fix direction>.`
4. **Copy block** — after the table, one fenced `text` block the user can paste into an agent:

```text
Check if these issues are valid — if so, understand the root cause of each and fix them. If appropriate, use sub-agents to investigate and fix each issue separately.

<file name="path/to/file.ext">
<violation number="1" location="path/to/file.ext:LINE">
P{N}: …finding text…
</violation>
</file>
```

Group violations by file. Keep the whole copy block in one fence so it copies in one shot. If nothing survives, say `**No issues found** across X files` and emit **no** copy block. Do **not** add undeclared sections.

## Diff source

- Default: `git diff origin/main...HEAD` (+ dirty tree if present)
- **Untracked files never appear in any `git diff`** — run `git status --porcelain`, and treat untracked non-ignored files as fully added. Skipping this silently drops whole new modules from the review
- Do **not** read GitHub bot/human review comments unless asked to compare

**Arg grammar** (optional tokens after `/pr-review`):

```text
/pr-review [ultra] [worktree <path>] [base <sha|ref>]
```

- `worktree <path>` — review that checkout instead of the current workspace
- `base <sha|ref>` — diff `base...HEAD` (default `origin/main`)
- Flags and key/value tokens may appear in either order; unknown tokens → ask once, do not guess

## Tools (keep few)

Orchestrator: read files, search, `git show`/`git diff`, focused tests for touched packages. No sprawling toolkits.

Specialist tool rules live in `reference.md`'s shared constraints (read-only; the single test-run exception lives in the Verify charter).

## Pipeline

### 1. Planner (you)

From the diff only:

1. List changed paths and a one-line blast radius (what can break)
2. Note symbols/APIs whose **callers outside the diff** must be checked (out-of-diff)
3. Pick which specialists to run (see selection rules below)
4. Emit a short plan; then launch specialists **in one parallel wave** (separate sub-agents in the same turn)

**Specialist selection**

- Default on nontrivial PRs: State, Parse, Security, Flow, Verify — drop one only if its charter has zero touch surface
- **Quality**: run when the diff touches tests **or** adds/changes internal helpers, wrapper types, or doc/README blocks that assert contracts; otherwise skip
- Never drop Verify solely because Quality is running — they own different failure modes

### 2. Micro-agents (parallel)

Use the host’s parallel sub-agent mechanism. Specialists inherit the parent model unless the user names one.

Each specialist gets: worktree path, exact `base...HEAD`, changed-file list (including untracked/added files), planner blast-radius notes, the mode (normal/ultra), and **only its charter** (see `reference.md`).

Paste `reference.md`’s shared constraints (severity bar, confidence gate, line-number rule, finding schema) into every specialist prompt verbatim, or they will invent their own P0–P3 scale.

Charters:

| Agent | Owns |
| --- | --- |
| **State** | Invariants, lifecycle, close/reset/retry, event ordering, post-close behavior |
| **Parse** | Lengths, encodings, fixtures/goldens, validate-before-side-effects |
| **Security** | Untrusted peers/input, authz, spoofing, expensive work before reject |
| **Flow** | Spins, starvation, deadlines, unbounded/superlinear buffers, error-path leaks |
| **Verify** | *Missing* tests for new failure modes; CI/fuzz gaps; README/doc lies; AGENTS.md policy |
| **Quality** | *Hollow* proof and LLM-shaped test/docs padding; internal no-policy wrappers — not intentional public/layer boundaries |

The pasted shared constraints carry the rest (stay in charter, out-of-diff scope per mode, confidence gate).

### 3. Merge (you)

1. Collect all findings that pass the confidence gate (`reference.md` shared constraints)
2. Dedupe near-duplicates (same root cause → keep highest severity / clearest). Prefer Verify for “test missing”; prefer Quality for “test present but hollow/duplicate”; a test that **cannot pass as written** is a P0 defect, not a Quality finding
3. Drop nits / pure style even if a specialist emitted them — including Quality naming taste or “sounds like an LLM” without an artifact. **Quality floor:** a finding that names a specific `file:line` artifact and states what bug or regression it would fail to catch is **not** a nit — keep it
4. Apply the `reference.md` allowlist:
   - **Test-shaped** entries: drop the finding **unless** the new test is strictly weaker than in-file peers covering the same claim
   - **One-line public API** entries: drop unconditionally — those are intentional layer boundaries, not “weaker peers”
5. **Confirm before publishing.** Specialist confidence is self-reported and uncalibrated — for every surviving P0/P1, open the cited `file:line` yourself and re-derive the failure story from the code, not from the agent summary. Drop what you cannot reproduce; fix the line number if it drifted. Do the same for any P2 two agents describe differently
6. Optional: run focused tests for touched packages once; fold hard evidence in
7. Output **exactly** per the Output section above. Include Quality findings in the table and copy block
8. Do not fix code unless asked

## Modes

- **normal** (default): defect specialists + Quality when its selection rule matches; specialists go out-of-diff only to confirm or refute a suspected in-diff finding. Thorough but time-bounded
- **ultra**: same agents, one wave — after finishing its in-diff hunks, each specialist additionally sweeps every symbol on the planner's out-of-diff list against **its own** charter, suspicion or not. No generic caller-sweep agent; use when user says ultra or PR is large/risky

## Examples

```text
/pr-review
/pr-review ultra
/pr-review worktree /path/to/wt base <sha>
/pr-review ultra base origin/main
```
