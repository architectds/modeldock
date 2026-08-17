# CLAUDE.md

This repository follows [AGENTS.md](AGENTS.md); the rules there apply to Claude
agents here too. In particular, keep code clean and simple - do not write more
than necessary, do not duplicate, and do not complicate without a real reason.

## Simplification discipline

- Simplification must be evidence-backed, not stylistic: name the real cost or the absent
  consumer before removing, folding, or rewiring code. Prefer deletion over abstraction;
  when two things mirror the same fact, keep one source.
- Prefer a dependency or Node builtin over hand-rolling only when the swap deletes more
  than it moves: count the implementation, its dedicated tests, and docs, minus the glue
  that remains. A wrapper that relocates complexity is not a win.
- Tests are not golden truth: a test that pins an unused API is evidence of speculation,
  not a reason to keep it.
- A simpler behavior is acceptable when it is still reasonable and easier to explain, even
  if it differs slightly from the current behavior.
