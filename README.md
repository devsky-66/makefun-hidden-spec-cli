# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON — and
`mend` reads all four to one specification, finds the lines an edit names even
when the model drifted their whitespace or indentation, and changes every file
or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`SPEC.md` in the kit is the whole specification. `runner.ts` is the kit's
trial runner, kept as it is.

## Layout

- `main.ts` — the CLI (Node 22, standard library only)
- `runner.ts` — the kit's runner (unchanged)

## License

MIT — see `LICENSE`.
