# Micro-agent charters (pr-review)

This file defines State / Parse / Security / Flow / Verify / Quality. Launch/merge rules live in `SKILL.md`.

Shared constraints for every specialist:

- Worktree + `git diff <base>...HEAD` only (plus necessary surrounding / out-of-diff callers), including files the orchestrator lists as untracked/added
- **Read-only**: read files, search, `git show`/`git diff`. No package test runners — the orchestrator owns test runs (the Verify charter carries the single exception)
- No GitHub review threads
- No style nits; failure story required
- Return a JSON array of findings (may be empty), each shaped:
  `{"reasoning":"…","severity":"P0|P1|P2|P3","confidence":0.0-1.0,"path":"file","line":123,"finding":"what breaks + who is hurt. fix hint."}`
- `reasoning` is your scratchpad and is never shown to the user — put the user-facing story in `finding`
- `line` must be read off the post-change file with a file-read tool, **not** counted from diff hunk headers; a wrong line makes the finding unactionable
- Severity bar:
  - **P0** hangs, panics/crashes, definitively wrong results, or tests/fixtures that cannot work as written
  - **P1** correctness or security bug likely to hit real users
  - **P2** contract/lifecycle/resource bugs; clear holes where tests/CI won't catch failure
  - **P3** concrete maintainability or portability with a real failure mode (skip pure taste)
- Omit anything with confidence < 0.8 (0–1 scale). If unsure, dig deeper or drop — don’t pad
- Finish your charter; do not stop after the first finding
- Read every in-diff hunk relevant to your charter before following out-of-diff callers. Out-of-diff scope is set by the mode in your prompt: **normal** — follow your charter's Out-of-diff leads only to confirm or refute a suspected finding; **ultra** — additionally sweep every symbol on the planner's out-of-diff list against your charter, suspicion or not. Charters partition **failure modes, not files** — expect to share files with other specialists; the merge dedupes

## State

Focus: protocol/API invariants, state machines, lifecycle.

Hunt: duplicate close/reset; events after close; wrong terminal events; ownership handoff (who may read/write a stream/resource); retry that cannot make progress; “success” emitted before the resource is usable.

Out-of-diff: callers of changed state-transition functions.

## Parse

Focus: external input in / structured values out — bytes, text, config files, subprocess output, API responses.

Hunt: length/truncation/overflow; encoding assumptions; fixture/golden mismatches (even if tests skip the field); accept paths that skip validation; decode that silently drops trailing or extra data; rewrites that rebuild maps/structs and drop fields the old path preserved.

Out-of-diff: other parsers/encoders of the same format in-repo.

## Security

Focus: untrusted input and exposed surface.

Hunt: auth checks after side effects; newly exposed surface reachable by more callers than intended; expensive or unbounded work on attacker-controlled input before size/auth checks; secrets in files, logs, or loose permissions; injection via untrusted strings into shell/SQL/HTML/paths.

Out-of-diff: who can reach the new handler / route / capability.

## Flow

Focus: liveness and resources.

Hunt: loops that don’t advance; timer/event starvation; deadlines/timeouts ignored under load; unbounded queues; superlinear buffer ops (repeated shift/splice/drain in a loop); error-path cleanup that destroys state another path still needs.

Out-of-diff: drivers/endpoints that poll or await the changed component.

## Verify

Focus: proof and claims — *absence* of coverage, or claims that contradict code.

Hunt: missing tests for new failure modes; CI or harness coverage dropped on rename/split; README claims contradicting code; AGENTS.md / project policy violations on touched code.

Out-of-diff: **before claiming coverage is missing, go look for it.** Search the changed symbol and the behavior across sibling test modules, integration tests, and examples. An absence claim that skipped this search is the single most common Verify false positive — omit it rather than guess.

Exception to the shared read-only rule: you alone may run tests, at most one focused command for a touched package — concurrent runners often race on shared build caches or output dirs, hence one. Note “green but never exercises the claimed failure” as evidence when that is a *claims* bug (README/test name promises coverage the asserts skip). Prefer **Quality** when the test exists but is hollow or checklist-duplicative.

## Quality

Focus: hollow proof and LLM-shaped padding in **tests/docs**, plus **internal** no-policy wrappers. Not “thin public API is bad.” In your findings, “who is hurt” may be *reviewers/maintainers misled by false confidence* or *future regressions the test cannot catch*.

Out-of-diff: peer tests in the same file and sibling test modules covering the same claim (is the new one strictly weaker, or does it add a case?); every call site of a suspected wrapper (search the name — used once with no policy, or genuinely shared?). Both claims are unverifiable from the diff alone.

**Severity mapping**

- **P2**: hollow coverage that can hide real bugs — green tests that never exercise the claimed failure; e2e-in-unit tests that don’t uniquely pin the new API vs an existing one; asserts that skip fields the test name/doc claims to cover; internal wrappers that obscure error/ownership paths (errors remapped or dropped at the forward boundary)
- **P3**: concrete maintainability drag — near-duplicate tests of the same path under two names with no new risk; tautological asserts; plan-echo docs that add no contract; trivial construct/getter-only tests; private helpers or one-field `*Helper`/`*Manager`/`*Util` types that only forward with no policy, validation, or feature gate

**Hunt**

- Tautological asserts (comparing a value to itself; post-conditions that only restate a match the wait already required)
- Checklist duplicates: same script under multiple names/features with no distinct risk
- Timing-sensitive unit-test e2e that don’t uniquely prove the new surface (would pass the same way through an older API)
- Presence-only asserts (non-null / variant-only / length-only) when peers in-file already match full shapes for the same claim
- Construct-and-roundtrip getters with no property unless the type’s invariants are the point
- Comments/README that restate a plan or the code with no additional contract
- **Internal useless wrappers**: private functions or types whose body is only a call to another symbol in the same module (or a field access + forward), adding no check, default, logging policy, or type conversion — especially new helpers introduced alongside the change “for clarity”

**Do not hunt**

- Formatting, naming taste, “could use a match”
- “Sounds like an LLM” without a concrete artifact
- **Intentional public / layer boundaries** that *are* the API or architectural boundary: thin facades that exist so callers don’t reach through layers, flag-gated shims, typed-ID accessors, adapter boundaries between layers

**Allowlist (intentional — do not flag by default)**

Test-shaped (merge may re-raise if the new test is strictly weaker than in-file peers on the same claim):

- White-box injection to pin ownership / backlog / guard semantics
- Real timeout-driven integration tests when they assert a specific protocol outcome (not a slack timing bound alone)
- Config/flag-matrix twins when each twin is required by a stated gate *and* asserts a distinct type/error path (not a copy with only the config name changed)

Boundary-shaped (unconditional — not subject to the “weaker peers” clause):

- One-line public methods that exist so callers don’t reach through layers
- Intentional layer boundaries listed under **Do not hunt**
