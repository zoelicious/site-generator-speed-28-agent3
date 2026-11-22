# State-Machine Site Engine

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zoelicious/site-generator-speed-28-agent3/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zoelicious/site-generator-speed-28-agent3/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0, written for the
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty on [make.fun](https://make.fun). `run(input)` returns, for every case,
exactly the output tree makefun-site 1.0.0's `build` returns — byte for byte —
and does it with far less CPU time.

## How it is faster

The reference is a pipeline of plugins over token trees, with a regular
expression at nearly every step. This engine replaces that with one
lookup-table driven state machine:

- **Markdown inline** is a single scan driven by a transition table: each
  input character maps to an action (escape, code span, strong, emphasis,
  link) with no chain of branches and no token objects.
- **Markdown blocks** are recognised from each line's first characters by
  the same table-driven dispatch, and rendered straight into the output —
  no lex-then-render pass.
- **Templates** compile once, up front, into a flat table of operations with
  precomputed jumps. A small interpreter walks that table with an explicit
  control stack, so loops and includes never recurse and never allocate a
  scope chain per element.
- **Front matter, slugs and links** are parsed with character-code checks
  instead of regular expressions, and pure results (slugs) are memoised
  within one build.

Nothing is cached from one case to the next: every `run()` call builds its
own tables, and the output depends on its input alone.

## Layout

- `solve.js` — the entry: a dependency-free ES module exporting `run(input)`.
- `main.ts` — the harness program: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`.

## License

MIT. See [LICENSE](LICENSE).
