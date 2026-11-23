# makefun-mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/afrzh11/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/afrzh11/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all
four formats they write them in: unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as
JSON. It finds the lines an edit names even when the model drifted their
whitespace or indentation (a three-tier matcher: exact, trailing-blank
insensitive, then fully trim-insensitive with re-indentation), and it changes
every file or none — a failed edit leaves the whole tree untouched and every
failure is reported. Node 22, standard library only, deterministic.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file (or standard input when absent or `-`); `--format`
is one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the
default, which detects the format). `--check` reports without writing;
`--strict` matches lines exactly. `SPEC.md` in this repository is the full
specification mend implements. `check.ts` runs the public practice set:

```sh
node check.ts <practice.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=00whd2w5&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
