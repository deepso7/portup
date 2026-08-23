# Domain docs

Use this repository's domain documentation when exploring the codebase.

## Before exploring

- Read `CONTEXT.md` at the repository root.
- Read ADRs under `docs/adr/` that affect the area you are about to change.

If these files do not exist, proceed silently. The `/domain-modeling` skill creates them when the team resolves terms or architectural decisions.

## File structure

This repository uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
├── engine/
└── web/
```

## Use glossary terms

When output names a domain concept in an issue title, proposal, hypothesis, or test, use the term defined in `CONTEXT.md`. Avoid synonyms that the glossary rejects.

If a needed concept is absent, reconsider whether the codebase uses that concept. If the gap is real, record it for `/domain-modeling`.

## Flag ADR conflicts

Call out any output that contradicts an existing ADR. Name the ADR and explain why the decision may need reconsideration.
