# pi-shadow-rewind

Cursor-style checkpoint/rewind for the [Pi](https://pi.dev) coding agent.

Shadow-git snapshots stored **outside** the working directory (under
`~/.pi/agent/checkpoints/`), capturing **only files the agent actually touched**
via its write/edit/bash tools. This keeps the shadow index small and the
extension fast even when Pi runs in a huge directory like `~` that has no
`.gitignore`.

## Why

Existing Pi rewind extensions either walk the whole worktree on every turn
(`@ayulab/pi-rewind`, which crawls `~`), or refuse to run outside a git repo
(`arpagon/pi-rewind`, `nicobailon/pi-rewind-hook`). Neither matches the Cursor /
Cline experience of "works instantly anywhere, including `~`".

`pi-shadow-rewind` implements the Cursor architecture:

1. **Shadow git repo outside cwd** — under `~/.pi/agent/checkpoints/<hash>/`,
   keyed by `(cwd, sessionId)`. The cwd does NOT need to be a git repository.
2. **Tool-Interception capture** — subscribes to `tool_execution_end` for
   `write`/`edit`/`bash` and stages only those paths into the shadow index.
   The index never contains files the agent didn't touch, so `git write-tree`
   is O(agent-touched-files), not O(workspace).
3. **Broad restore (Cursor-style)** — on rewind, files that differ between two
   snapshot trees are checked out into the worktree, overwriting any external
   edits to in-scope files.

## Commands

| Command | Description |
| --- | --- |
| `/rewind` | Browse checkpoints, preview diff stats, choose restore scope (files / conversation / both) |
| `/undo` | Undo the last user message and restore its file checkpoint |
| `/redo` | Redo the most recently undone message and file checkpoint |
| `/diff [file]` | Per-file line stats across checkpoints, or a full unified diff for one file |
| `/shadow-checkpoints` | Disk usage of checkpoint stores across sessions, with delete options |

## `/tree` integration

On `/tree` navigation with "No summary", if the target checkpoint has file
changes, the extension prompts `Sync files?` before restoring them — the same
behaviour as `@ayulab/pi-rewind`'s `restoreOnTree: "ask"`.

## Limitations (same as Claude Code / Cline)

- Bash `rm`/`mv` targets are parsed best-effort. Commands the parser doesn't
  recognise contribute no paths, so file changes from exotic shell commands
  may not be captured until the agent re-touches the file via `write`/`edit`.
- Files the agent never touches are not checkpointed and cannot be rewound.
- "External changes" (edits made outside Pi) to **in-scope** files are
  overwritten on restore, exactly like Cursor.

## Installation

### Local (for development)

```bash
# from the repo root
pi -e ./pi-shadow-rewind/index.ts
```

Or copy/symlink the `pi-shadow-rewind/` directory into
`~/.pi/agent/extensions/pi-shadow-rewind/` for auto-discovery and `/reload`.

### As a Pi package

```bash
pi install github.com:<you>/pi-shadow-rewind
```

## Configuration

No settings yet. Defaults are tuned for the Cursor experience. Future knobs
(retention, silent checkpoints) will live under a `shadowRewind` settings tree.

## Lineage

The `ShadowGit` class and the session/checkpoint bookkeeping are derived from
[`@touchtechclub/pi-oc-rewind`](https://github.com/TouchTechClub/pi-toolkit)
(MIT), which was the only existing Pi extension to store its shadow git outside
the cwd. The capture strategy (tool-interception instead of `git add --all`)
and the `/rewind` browser UX are new.

## License

MIT
