// pi-shadow-rewind — Cursor-style checkpoint/rewind for Pi.
//
// Shadow-git snapshots stored OUTSIDE the cwd (under ~/.pi/agent/checkpoints/),
// so the working directory does NOT need to be a git repository and is NOT
// walked wholesale. Checkpoints capture ONLY files touched by the agent's
// write/edit/bash tools (Tool-Interception, like Cline/Cursor), keeping the
// shadow index small even when pi runs in ~.
//
// Restore is broad (Cursor-style): files that differ between two snapshot
// trees are checked out from the shadow repo into the worktree, overwriting
// any external edits to in-scope files.
//
// Forked in spirit from @touchtechclub/pi-oc-rewind (MIT). The ShadowGit class
// and the checkpoint/session bookkeeping are derived from that project; the
// capture strategy and /rewind browser UX are new.

// @pi-acp-compatible

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'

const EXT = 'shadow-rewind'
const GIT_TIMEOUT = 30_000
// Overridable so tests never write into the real checkpoint store.
function checkpointsDir(): string {
  return process.env.PI_SHADOW_REWIND_DIR ?? path.join(homedir(), '.pi', 'agent', 'checkpoints')
}
const META_FILE = 'pi-checkpoint-meta.json'

// Tools that mutate the worktree and therefore must seed the shadow index.
const MUTATING_TOOLS = new Set(['write', 'edit', 'bash', 'apply_patch', 'str_replace', 'create'])

type Checkpoint = {
  userEntryId: string
  beforeLeafId: string | null
  finalLeafId: string
  prompt: string
  beforeSnapshot: string
  afterSnapshot: string
  files: string[]
  createdAt: number
}

type ActiveCheckpoint = Omit<Checkpoint, 'finalLeafId' | 'afterSnapshot' | 'files' | 'createdAt'>

export default function shadowRewind(pi: ExtensionAPI) {
  const checkpoints = new Map<string, Checkpoint>()
  const redoStack: Checkpoint[] = []
  let active: ActiveCheckpoint | undefined
  let pendingPrompt: string | undefined
  let snapshotter: ShadowGit | undefined
  // Files touched by mutating tools during the current turn. These are the
  // ONLY paths staged into the shadow index, which is what keeps the index
  // small regardless of workspace size.
  const touchedThisTurn = new Set<string>()
  let branchFiles: string[] = []

  function refreshBranchFiles(ctx: { sessionManager: { getBranch(): SessionEntry[] } }) {
    branchFiles = collectBranchDiffFiles(ctx.sessionManager.getBranch(), checkpoints)
  }

  pi.on('session_start', (_event, ctx) => {
    snapshotter = new ShadowGit(pi, ctx.cwd, ctx.sessionManager.getSessionId())
    checkpoints.clear()
    redoStack.length = 0
    active = undefined
    touchedThisTurn.clear()

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== 'custom' || entry.customType !== EXT) continue
      const data = entry.data as Partial<Checkpoint> | undefined
      const checkpoint = repairCheckpoint(data, ctx.sessionManager)
      if (checkpoint) checkpoints.set(checkpoint.userEntryId, checkpoint)
    }
    refreshBranchFiles(ctx)
  })

  pi.on('before_agent_start', (event) => {
    redoStack.length = 0
    active = undefined
    touchedThisTurn.clear()
    pendingPrompt = event.prompt
  })

  pi.on('message_start', async (event, ctx) => {
    if (event.message.role !== 'assistant' || active || pendingPrompt === undefined) return

    const branch = ctx.sessionManager.getBranch()
    const userEntry = findLatestUserByText(branch, pendingPrompt)
    if (!userEntry) return

    try {
      const beforeSnapshot = await getSnapshotter(ctx).track()
      active = {
        userEntryId: userEntry.id,
        beforeLeafId: userEntry.parentId,
        prompt: userText(userEntry.message),
        beforeSnapshot,
      }
    } catch (error) {
      active = undefined
      ctx.ui.notify(`Checkpoint skipped: ${message(error)}`, 'warning')
    }
  })

  pi.on('tool_call', (event, ctx) => {
    // Tool-Interception capture: collect paths mutated by write/edit/bash so
    // the after-snapshot only stages what the agent actually changed. This is
    // the key difference from oc-rewind/ayulab, which `git add --all` the
    // entire worktree.
    //
    // We use the `tool_call` event (not tool_execution_start) because tool_call
    // carries `event.input` with the resolved parameters ({ path } for
    // write/edit, { command } for bash).
    //
    // NOTE: we collect paths regardless of `active` to avoid a race where
    // tool_call fires while the async message_start handler is still running
    // and has not set `active` yet. agent_end re-checks `active` before
    // committing.
    if (!MUTATING_TOOLS.has(event.toolName)) return
    const paths = extractPathsFromToolEvent(event.toolName, event.input, undefined)
    for (const p of paths) {
      const rel = toShadowRel(p, ctx.cwd)
      if (rel) touchedThisTurn.add(rel)
    }
  })

  pi.on('agent_end', async (_event, ctx) => {
    if (!active) return
    const current = active
    active = undefined

    try {
      const snap = getSnapshotter(ctx)
      const afterSnapshot = await snap.track(touchedThisTurn, (warning) =>
        ctx.ui.notify(`Checkpoint warning: ${warning}`, 'warning'),
      )
      const files = await snap.diffFiles(current.beforeSnapshot, afterSnapshot)
      const checkpoint: Checkpoint = {
        ...current,
        finalLeafId: ctx.sessionManager.getLeafId() ?? current.userEntryId,
        afterSnapshot,
        files,
        createdAt: Date.now(),
      }
      checkpoints.set(checkpoint.userEntryId, checkpoint)
      pi.appendEntry(EXT, checkpoint)
      refreshBranchFiles(ctx)
    } catch (error) {
      ctx.ui.notify(`Checkpoint finalization failed: ${message(error)}`, 'warning')
    } finally {
      touchedThisTurn.clear()
      pendingPrompt = undefined
    }
  })

  // ==========================================================================
  // /tree integration: offer file restore on No-summary tree navigation.
  // ==========================================================================
  pi.on('session_before_tree', async (event, ctx) => {
    if (!ctx.hasUI) return
    if (event.preparation.userWantsSummary) return

    const resolved = resolveSnapshotForTarget(
      ctx.sessionManager,
      event.preparation.targetId,
      checkpoints,
    )
    if (!resolved || resolved.checkpoint.files.length === 0) return

    const prompt = truncate(resolved.checkpoint.prompt, 60)
    const ok = await ctx.ui.confirm(
      'Sync files?',
      `Restore ${resolved.checkpoint.files.length} file(s) to checkpoint "${prompt}"?`,
    )
    if (!ok) return
    try {
      await getSnapshotter(ctx).restoreFiles(resolved.snapshot, resolved.checkpoint.files)
      ctx.ui.notify(`Restored ${resolved.checkpoint.files.length} file(s)`, 'info')
    } catch (error) {
      ctx.ui.notify(`Tree file restore failed: ${message(error)}`, 'warning')
    }
  })

  /**
   * Work out which snapshot describes the file state at `targetId`.
   *
   * The branch is the path from the root to the TARGET, not the current leaf:
   * navigating to another branch must not pick up that branch's checkpoints.
   */
  function resolveSnapshotForTarget(
    sessions: ReadonlySessionLookup,
    targetId: string,
    store: Map<string, Checkpoint>,
  ): { checkpoint: Checkpoint; snapshot: string } | undefined {
    if (!targetId || store.size === 0) return undefined

    // getBranch falls back to the current leaf for unknown ids — refuse.
    const branch = sessions.getBranch(targetId)
    if (branch[branch.length - 1]?.id !== targetId) return undefined

    return pickSnapshotForTarget(branch, targetId, store)
  }

  // ==========================================================================
  // Commands
  // ==========================================================================
  pi.registerCommand('rewind', {
    description: 'Browse checkpoints, preview diff, and restore files/conversation.',
    handler: async (_args, ctx) => runRewindFlow(ctx),
  })

  pi.registerCommand('undo', {
    description: 'Undo last user message and restore its file checkpoint.',
    handler: async (_args, ctx) => undo(ctx),
  })

  pi.registerCommand('redo', {
    description: 'Redo the most recently undone message and file checkpoint.',
    handler: async (_args, ctx) => redo(ctx),
  })

  pi.registerCommand('diff', {
    description:
      'Show session diff. Without args: per-file line stats. With a file path: full diff for it.',
    getArgumentCompletions: (prefix) => diffFileCompletions(branchFiles, prefix),
    handler: async (args, ctx) => diff(ctx, args.trim()),
  })

  pi.registerCommand('shadow-checkpoints', {
    description: 'Show disk usage of checkpoint snapshots across sessions and delete them.',
    handler: async (_args, ctx) => manageCheckpointCache(ctx),
  })

  // ==========================================================================
  // /rewind browser (Cursor-style: list → diff preview → restore mode)
  // ==========================================================================
  async function runRewindFlow(ctx: ExtensionCommandContext) {
    await ctx.waitForIdle()

    const branchUserIds = new Set(
      ctx.sessionManager
        .getBranch()
        .filter((e) => e.type === 'message' && e.message.role === 'user')
        .map((e) => e.id),
    )
    const branchCheckpoints = [...checkpoints.values()]
      .filter((c) => branchUserIds.has(c.userEntryId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 25)

    if (branchCheckpoints.length === 0) {
      ctx.ui.notify('No checkpoints available', 'warning')
      return
    }

    const items: string[] = []
    if (redoStack.length > 0) {
      items.push('↩ Undo last rewind')
    }
    for (let i = 0; i < branchCheckpoints.length; i++) {
      items.push(formatCheckpointLabel(branchCheckpoints[i], i + 1))
    }

    const choice = await ctx.ui.select('Rewind to checkpoint:', items)
    if (!choice) {
      ctx.ui.notify('Rewind cancelled', 'info')
      return
    }

    // Undo-last-rewind shortcut
    if (choice === '↩ Undo last rewind' && redoStack.length > 0) {
      const undone = redoStack[redoStack.length - 1]
      try {
        const result = await ctx.navigateTree(undone.finalLeafId, { summarize: false })
        if (result.cancelled) {
          ctx.ui.notify('Undo cancelled', 'info')
          return
        }

        await getSnapshotter(ctx).restoreFiles(undone.afterSnapshot, undone.files)
        redoStack.pop()
        ctx.ui.setEditorText('')
        refreshBranchFiles(ctx)
        ctx.ui.notify(`Undo successful — restored ${undone.files.length} file(s)`, 'info')
      } catch (error) {
        ctx.ui.notify(`Undo failed: ${message(error)}`, 'error')
      }
      return
    }

    const idx = items.indexOf(choice) - (redoStack.length > 0 ? 1 : 0)
    if (idx < 0 || idx >= branchCheckpoints.length) return
    const target = branchCheckpoints[idx]

    // Diff preview
    let diffText = ''
    try {
      const snap = getSnapshotter(ctx)
      const stats = await snap.diffNumstat(target.beforeSnapshot, target.afterSnapshot)
      if (stats.size > 0) {
        const lines = [...stats.entries()]
          .sort((a, b) => b[1].added + b[1].removed - (a[1].added + a[1].removed))
          .map(([file, s]) => `  ${file}  +${s.added}/-${s.removed}`)
        diffText = `${lines.join('\n')}\n\n${stats.size} file(s) changed`
      }
    } catch {
      // Continue without preview if diff fails
    }

    if (diffText) {
      const proceed = await ctx.ui.confirm(
        `Files changed in checkpoint #${idx + 1}:\n\n${diffText}`,
        'Proceed with restore?',
      )
      if (!proceed) {
        ctx.ui.notify('Rewind cancelled', 'info')
        return
      }
    }

    const RESTORE_OPTIONS = [
      'Restore all (files + conversation)',
      'Files only (keep conversation)',
      'Conversation only (keep files)',
      'Cancel',
    ] as const
    const modeChoice = await ctx.ui.select('Restore mode:', [...RESTORE_OPTIONS])
    const mode = RESTORE_OPTIONS.find((option) => option === modeChoice)
    if (!mode || mode === 'Cancel') {
      ctx.ui.notify('Rewind cancelled', 'info')
      return
    }

    const doFiles = mode !== 'Conversation only (keep files)'
    const doConversation = mode !== 'Files only (keep conversation)'

    const leafBefore = ctx.sessionManager.getLeafId()

    // Navigate FIRST: if another handler cancels, the files stay untouched and
    // conversation and worktree cannot drift apart.
    if (doConversation) {
      try {
        const leafId = target.beforeLeafId ?? target.userEntryId
        const result = await ctx.navigateTree(leafId, { summarize: false })
        if (result.cancelled) {
          ctx.ui.notify('Rewind cancelled', 'info')
          return
        }
      } catch (error) {
        ctx.ui.notify(`Conversation rewind failed: ${message(error)}`, 'warning')
        return
      }
    }

    if (doFiles) {
      try {
        const snap = getSnapshotter(ctx)
        // Safety net: snapshot current state so /undo can bring it back.
        const safetyBefore = await snap.track()
        // Restore files from the checkpoint's before-snapshot (pre-edit state).
        await snap.restoreFiles(target.beforeSnapshot, target.files)
        redoStack.push({
          userEntryId: target.userEntryId,
          beforeLeafId: target.beforeLeafId,
          finalLeafId: leafBefore ?? target.userEntryId,
          prompt: target.prompt,
          beforeSnapshot: safetyBefore,
          afterSnapshot: target.afterSnapshot,
          files: target.files,
          createdAt: Date.now(),
        })
        refreshBranchFiles(ctx)
      } catch (error) {
        ctx.ui.notify(`File restore failed: ${message(error)}`, 'error')
        return
      }
    }

    if (doFiles && !doConversation) {
      ctx.ui.setEditorText(target.prompt)
    } else if (doConversation) {
      ctx.ui.setEditorText('')
    }

    const what = doFiles
      ? doConversation
        ? 'files + conversation'
        : 'files'
      : 'conversation'
    ctx.ui.notify(`Rewound ${what} to checkpoint #${idx + 1}`, 'info')
  }

  async function undo(ctx: ExtensionCommandContext) {
    await ctx.waitForIdle()
    const branch = ctx.sessionManager.getBranch()
    const target = [...branch]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'message' && entry.message.role === 'user' && checkpoints.has(entry.id),
      )

    if (!target || target.type !== 'message') {
      ctx.ui.notify('No checkpointed user message to undo', 'warning')
      return
    }

    const checkpoint = checkpoints.get(target.id)!
    if (!checkpoint.beforeLeafId) {
      ctx.ui.notify(
        'Cannot undo the first session message in-place; use /fork before it instead.',
        'warning',
      )
      return
    }

    try {
      // Navigate first so a cancelled navigation leaves the files untouched.
      const result = await ctx.navigateTree(checkpoint.beforeLeafId, { summarize: false })
      if (result.cancelled) {
        ctx.ui.notify('Undo cancelled', 'info')
        return
      }

      await getSnapshotter(ctx).restoreFiles(checkpoint.beforeSnapshot, checkpoint.files)
      redoStack.push(checkpoint)
      ctx.ui.setEditorText(checkpoint.prompt)
      refreshBranchFiles(ctx)
      ctx.ui.notify(`Undid message; restored ${checkpoint.files.length} file(s)`, 'info')
    } catch (error) {
      ctx.ui.notify(`Undo failed: ${message(error)}`, 'error')
    }
  }

  async function redo(ctx: ExtensionCommandContext) {
    await ctx.waitForIdle()
    const checkpoint = redoStack.pop()
    if (!checkpoint) {
      ctx.ui.notify('Nothing to redo', 'warning')
      return
    }

    try {
      // Navigate first so a cancelled navigation leaves the files untouched.
      const result = await ctx.navigateTree(checkpoint.finalLeafId, { summarize: false })
      if (result.cancelled) {
        redoStack.push(checkpoint)
        ctx.ui.notify('Redo cancelled', 'info')
        return
      }

      await getSnapshotter(ctx).restoreFiles(checkpoint.afterSnapshot, checkpoint.files)
      ctx.ui.setEditorText('')
      refreshBranchFiles(ctx)
      ctx.ui.notify(`Redid message; restored ${checkpoint.files.length} file(s)`, 'info')
    } catch (error) {
      redoStack.push(checkpoint)
      ctx.ui.notify(`Redo failed: ${message(error)}`, 'error')
    }
  }

  async function diff(ctx: ExtensionCommandContext, file = '') {
    await ctx.waitForIdle()

    if (checkpoints.size === 0) {
      ctx.ui.notify('No checkpoints in current session', 'info')
      return
    }

    const branchUserIds = new Set(
      ctx.sessionManager
        .getBranch()
        .filter((e) => e.type === 'message' && e.message.role === 'user')
        .map((e) => e.id),
    )

    if (file) {
      await diffFile(ctx, branchUserIds, file)
      return
    }

    const snap = getSnapshotter(ctx)
    const aggregated = new Map<string, { added: number; removed: number }>()

    for (const checkpoint of checkpoints.values()) {
      if (!branchUserIds.has(checkpoint.userEntryId)) continue
      try {
        const stats = await snap.diffNumstat(checkpoint.beforeSnapshot, checkpoint.afterSnapshot)
        for (const [f, { added, removed }] of stats) {
          const existing = aggregated.get(f)
          if (existing) {
            existing.added += added
            existing.removed += removed
          } else {
            aggregated.set(f, { added, removed })
          }
        }
      } catch (error) {
        ctx.ui.notify(`Skipping checkpoint: ${message(error)}`, 'warning')
      }
    }

    if (aggregated.size === 0) {
      ctx.ui.notify('No file changes across checkpoints', 'info')
      return
    }

    const sorted = [...aggregated.entries()].sort(
      (a, b) => b[1].added + b[1].removed - (a[1].added + a[1].removed),
    )

    const t = ctx.ui.theme
    let totalAdded = 0
    let totalRemoved = 0

    let output = `${t.bold('Session Diff')}\n\n`

    for (const [f, { added, removed }] of sorted) {
      totalAdded += added
      totalRemoved += removed
      output += `${t.fg('text', f)}  `
      output += `${t.fg('toolDiffAdded', `+${added}`)}/${t.fg('toolDiffRemoved', `-${removed}`)}\n`
    }

    const addedText = t.fg('toolDiffAdded', `+${totalAdded}`)
    const removedText = t.fg('toolDiffRemoved', `-${totalRemoved}`)
    const fileCount = t.bold(String(sorted.length))
    output += `\n${t.fg('dim', 'Total')}\n`
    output += `${addedText}/${removedText} across ${fileCount} file(s)`

    ctx.ui.notify(output, 'info')
  }

  async function diffFile(ctx: ExtensionCommandContext, branchUserIds: Set<string>, file: string) {
    const rel = normalizeGitPath(file)
    if (!rel) {
      ctx.ui.notify(`Invalid file path: ${file}`, 'warning')
      return
    }

    let from: string | undefined
    let to: string | undefined
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message' || entry.message.role !== 'user') continue
      if (!branchUserIds.has(entry.id)) continue
      const checkpoint = checkpoints.get(entry.id)
      if (!checkpoint || !checkpoint.files.includes(rel)) continue
      if (from === undefined) from = checkpoint.beforeSnapshot
      to = checkpoint.afterSnapshot
    }

    if (from === undefined || to === undefined) {
      ctx.ui.notify(`No checkpointed changes to ${rel} in current session`, 'info')
      return
    }

    let raw: string
    try {
      raw = await getSnapshotter(ctx).diffFile(from, to, rel)
    } catch (error) {
      ctx.ui.notify(`Diff failed: ${message(error)}`, 'error')
      return
    }

    if (!raw.trim()) {
      ctx.ui.notify(`No net changes to ${rel} (edits cancelled out)`, 'info')
      return
    }

    const t = ctx.ui.theme
    const header = `${t.bold('Diff')} ${t.fg('text', rel)}\n\n`
    ctx.ui.notify(header + colorizeDiff(raw, t), 'info')
  }

  function getSnapshotter(ctx: { cwd: string; sessionManager: { getSessionId(): string } }) {
    if (!snapshotter) snapshotter = new ShadowGit(pi, ctx.cwd, ctx.sessionManager.getSessionId())
    return snapshotter
  }
}

// ==========================================================================
// ShadowGit — shadow git repository stored outside the worktree.
//
// The crucial method is `track(paths)`: instead of `git add --all` (which
// walks the entire worktree and is catastrophic in ~ without a .gitignore),
// it stages ONLY the given paths. Those paths come from tool_execution_end
// for write/edit/bash, so the shadow index stays O(agent-touched-files).
// ==========================================================================
export class ShadowGit {
  private initialized = false
  private readonly pi: ExtensionAPI
  private readonly cwd: string
  private readonly sessionId: string
  private readonly gitdir: string

  constructor(pi: ExtensionAPI, cwd: string, sessionId: string) {
    this.pi = pi
    this.cwd = cwd
    this.sessionId = sessionId

    const key = createHash('sha256').update(`${cwd}\0${sessionId}`).digest('hex').slice(0, 24)
    this.gitdir = path.join(checkpointsDir(), key)
  }

  /**
   * Write a tree object reflecting the given paths staged into the shadow
   * index. With no paths, writes the current index state (used for the
   * before-snapshot, which is just "whatever the shadow index currently
   * holds" — typically empty on first turn, then the union of previously
   * touched files).
   */
  async track(paths?: Iterable<string>, onWarn?: (warning: string) => void): Promise<string> {
    await this.ensure()
    if (paths) {
      const failures = await this.addPaths(paths)
      for (const failure of failures) onWarn?.(failure)
    }
    // Refresh the activity stamp so cache cleanup does not treat a busy store
    // as stale (it is only written on creation otherwise).
    await this.writeMeta()
    const result = await this.git(['write-tree'])
    return result.stdout.trim()
  }

  async diffFiles(from: string, to: string): Promise<string[]> {
    await this.ensure()
    const result = await this.git(['diff', '--name-only', '--no-renames', from, to, '--', '.'])
    return unique(
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )
  }

  async diffNumstat(
    from: string,
    to: string,
  ): Promise<Map<string, { added: number; removed: number }>> {
    await this.ensure()
    const result = await this.git(['diff', '--numstat', '--no-renames', from, to, '--', '.'])
    const stats = new Map<string, { added: number; removed: number }>()
    for (const line of result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)) {
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const added = Number.parseInt(parts[0], 10)
      const removed = Number.parseInt(parts[1], 10)
      if (Number.isNaN(added) || Number.isNaN(removed)) continue
      stats.set(parts[2], { added, removed })
    }
    return stats
  }

  async diffFile(from: string, to: string, file: string): Promise<string> {
    await this.ensure()
    const result = await this.git(['diff', '--no-color', '--no-renames', from, to, '--', file])
    return result.stdout
  }

  /**
   * Restore files from a snapshot tree into the worktree. Broad (Cursor-style):
   * files present in the snapshot are checked out; files absent from the
   * snapshot are deleted from the worktree. This overwrites external edits to
   * in-scope files, matching Cursor's behaviour.
   */
  async restoreFiles(snapshot: string, files: string[]): Promise<void> {
    await this.ensure()
    if (files.length === 0) {
      return
    }
    for (const file of files) {
      const rel = normalizeGitPath(file)
      if (!rel) continue

      // Never let a stored checkpoint path reach outside the worktree.
      if (!isSafeRestoreTarget(this.cwd, rel)) continue

      const exists = await this.git(['ls-tree', snapshot, '--', rel], { allowFailure: true })
      if (exists.code === 0 && exists.stdout.trim()) {
        await this.git(['checkout', snapshot, '--', rel])
      } else {
        await rm(path.join(this.cwd, rel), { recursive: true, force: true })
      }
    }
    // Re-stage restored files into the shadow index so the next before-snapshot
    // reflects reality.
    await this.addPaths(files)
  }

  private async ensure(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.gitdir, { recursive: true })
    await this.git(['init'])
    await this.git(['config', 'core.autocrlf', 'false'])
    await this.git(['config', 'core.longpaths', 'true'])
    await this.git(['config', 'core.symlinks', 'true'])
    await this.git(['config', 'core.fsmonitor', 'false'])
    await this.writeMeta()
    this.initialized = true
  }

  private async writeMeta(): Promise<void> {
    const meta = { cwd: this.cwd, sessionId: this.sessionId, updatedAt: Date.now() }
    await writeFile(path.join(this.gitdir, META_FILE), JSON.stringify(meta)).catch(() => {})
  }

  /**
   * Stage specific paths into the shadow index. Unlike `git add --all`, this
   * does NOT walk the worktree — it touches only the listed files, which is
   * what makes the extension fast in ~.
   *
   * `-f` is required: the agent may edit a file the *project's* .gitignore
   * excludes (.env, build output). Those changes must still be rewindable, so
   * we force-add explicitly captured paths only.
   *
   * Non-existent paths (e.g. a file deleted by `rm`) are removed from the
   * index via `git rm --cached`, so deletions are captured correctly.
   */
  private async addPaths(paths: Iterable<string>): Promise<string[]> {
    const failures: string[] = []
    const normalized = unique(
      [...paths]
        .map((p) => normalizeGitPath(p))
        .filter((p): p is string => Boolean(p)),
    )
    if (normalized.length === 0) return failures

    // Stage existing paths. `git add` tolerates missing files only with
    // `--ignore-missing`, but we want deletions to be reflected, so we
    // handle missing files separately below.
    const existing: string[] = []
    const missing: string[] = []
    for (const rel of normalized) {
      try {
        await stat(path.join(this.cwd, rel))
        existing.push(rel)
      } catch {
        missing.push(rel)
      }
    }

    // Add in batches to avoid shell arg-length limits on Windows/POSIX.
    const BATCH = 100
    for (let i = 0; i < existing.length; i += BATCH) {
      const batch = existing.slice(i, i + BATCH)
      const result = await this.git(['add', '-f', '--', ...batch], { allowFailure: true })
      if (result.code !== 0) {
        failures.push(result.stderr.trim() || `git add failed: ${batch.join(', ')}`)
      }
    }

    // Remove deleted files from the index so the snapshot reflects their
    // absence (tool wrote a file, then bash `rm`'d it, etc.).
    for (const rel of missing) {
      await this.git(['rm', '--cached', '--ignore-unmatch', '--', rel], { allowFailure: true })
    }

    return failures
  }

  private async git(args: string[], opts: { allowFailure?: boolean } = {}) {
    const result = await this.pi.exec(
      'git',
      ['--git-dir', this.gitdir, '--work-tree', this.cwd, ...args],
      {
        cwd: this.cwd,
        timeout: GIT_TIMEOUT,
      },
    )
    if (!opts.allowFailure && result.code !== 0) {
      throw new Error(result.stderr.trim() || `git ${args.join(' ')} exited ${result.code}`)
    }
    return result
  }
}

// ==========================================================================
// Tool-event path extraction — figure out which worktree paths a write/edit/
// bash tool call touched. This is the bridge from Pi's tool API to the
// shadow index.
// ==========================================================================
function extractPathsFromToolEvent(
  toolName: string,
  args: unknown,
  _result: unknown,
): string[] {
  if (!args || typeof args !== 'object') return []
  const a = args as Record<string, unknown>
  switch (toolName) {
    case 'write':
    case 'create':
      if (typeof a.path === 'string') return [a.path]
      return []
    case 'edit':
    case 'str_replace':
    case 'apply_patch':
      if (typeof a.path === 'string') return [a.path]
      if (!Array.isArray(a.edits)) return []

      return a.edits
        .map((edit) => {
          const entry = edit as { path?: unknown } | null
          return entry && typeof entry === 'object' && typeof entry.path === 'string'
            ? entry.path
            : null
        })
        .filter((p): p is string => Boolean(p))
    case 'bash': {
      // Best-effort: parse rm/mv/cp/tee targets out of the command string.
      const cmd = typeof a.command === 'string' ? a.command : ''
      return parseBashPaths(cmd)
    }
    default:
      return []
  }
}

/**
 * Best-effort extraction of file paths mutated by common shell commands.
 * Deliberately conservative: only well-known mutating commands are parsed,
 * so we never stage unrelated files. Unknown commands contribute no paths
 * (the file change will still be caught on the next write/edit by the agent
 * touching the same file).
 *
 * Redirects (`>`, `>>`) and exotic commands are not parsed — a `shortcut:`
 * trade-off, see README limitations.
 */
export const BASH_WRITERS: Record<string, (args: string[]) => string[]> = {
  // Removes or (re)creates the path itself.
  rm: (args) => args,
  rmdir: (args) => args,
  mkdir: (args) => args,
  truncate: (args) => args,
  tee: (args) => args,
  // `mv` consumes the source and produces the destination: both change.
  mv: (args) => args,
  // `cp`/`install` only READ the sources, so tracking them would make a rewind
  // delete the original. The destination is always the last argument.
  cp: (args) => args.slice(-1),
  install: (args) => args.slice(-1),
  dd: (args) => args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)),
}

export function parseBashPaths(command: string): string[] {
  const paths: string[] = []

  // Split into command segments so one command's arguments are not mistaken
  // for the next command's.
  for (const segment of command.split(/\s*(?:&&|\|\||[;|&])\s*/)) {
    const tokens = tokenizeShell(segment)
    if (tokens.length === 0) continue

    const writer = BASH_WRITERS[path.posix.basename(tokens[0])]
    if (!writer) continue

    const args = tokens.slice(1).filter((token) => !token.startsWith('-'))
    paths.push(...writer(args))
  }

  return paths
}

/** Split on whitespace, keeping single- and double-quoted runs together. */
function tokenizeShell(segment: string): string[] {
  const matches = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return matches.map((token) => token.replace(/^["']|["']$/g, '')).filter(Boolean)
}

// ==========================================================================
// Helpers (ported from oc-rewind, MIT)
// ==========================================================================
function findLatestUserByText(branch: SessionEntry[], text: string) {
  return [...branch]
    .reverse()
    .find(
      (entry) =>
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        userText(entry.message) === text,
    ) as UserMessageEntry | undefined
}

type UserMessageEntry = Extract<SessionEntry, { type: 'message' }> & { message: { role: 'user' } }

type ReadonlySessionLookup = {
  getEntry(id: string): SessionEntry | undefined
  getBranch(fromId?: string): SessionEntry[]
}

function repairCheckpoint(value: Partial<Checkpoint> | undefined, sessions: ReadonlySessionLookup) {
  if (!isCheckpoint(value)) return

  const original = sessions.getEntry(value.userEntryId)
  if (
    original?.type === 'message' &&
    original.message.role === 'user' &&
    userText(original.message) === value.prompt
  ) {
    return value
  }

  const repairedUser = findLatestUserByText(sessions.getBranch(value.finalLeafId), value.prompt)
  if (!repairedUser) return
  return {
    ...value,
    userEntryId: repairedUser.id,
    beforeLeafId: repairedUser.parentId,
  } satisfies Checkpoint
}

export function userText(message: { content: unknown }) {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'),
    )
    .map((block) => block.text)
    .join('')
}

function isCheckpoint(value: Partial<Checkpoint> | undefined): value is Checkpoint {
  return Boolean(
    value &&
      typeof value.userEntryId === 'string' &&
      typeof value.finalLeafId === 'string' &&
      typeof value.beforeSnapshot === 'string' &&
      typeof value.afterSnapshot === 'string' &&
      Array.isArray(value.files),
  )
}

/**
 * Resolve a tool-supplied path (which may be absolute, like
 * '/Users/florian.hauptmann/beispiel.json') to a git-shadow-relative path.
 * Absolute paths are resolved relative to cwd; relative paths are kept as-is
 * after normalization. Returns undefined for paths that escape the worktree
 * (e.g. /tmp, /etc) — those cannot be checkpointed by the shadow repo.
 *
 * Symlinks are resolved on both sides (realpathSync) so that macOS
 * /tmp → /private/tmp and similar platform quirks don't cause false
 * "escapes the worktree" rejections.
 */
function toShadowRel(file: string, cwd: string): string | undefined {
  if (!file || file.includes('\0')) return
  let rel: string
  if (path.isAbsolute(file)) {
    let resolvedCwd: string
    let resolvedFile: string
    try {
      resolvedCwd = realpathSync(cwd)
      resolvedFile = realpathSync(file)
    } catch {
      // File may not exist yet (tool about to create it) — fall back to
      // resolving the parent dir and joining the basename.
      try {
        resolvedCwd = realpathSync(cwd)
        const parent = path.dirname(file)
        resolvedFile = path.join(realpathSync(parent), path.basename(file))
      } catch {
        return
      }
    }
    const relative = path.relative(resolvedCwd, resolvedFile)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return
    rel = relative
  } else {
    rel = file
  }
  return normalizeGitPath(rel)
}

/**
 * Turn a tool-supplied path into a worktree-relative git path, or undefined if
 * it points outside the worktree. `..` segments are collapsed first, so
 * 'a/../../etc/passwd' is rejected instead of being handed to `git rm`.
 */
export function normalizeGitPath(file: string): string | undefined {
  if (!file || path.isAbsolute(file) || file.includes('\0')) return

  const normalized = path.posix.normalize(file.replaceAll('\\', '/'))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return
  if (path.posix.isAbsolute(normalized)) return
  if (normalized === '.pi' || normalized.startsWith('.pi/')) return

  return normalized.replace(/\/+$/, '')
}

/** True when `rel` stays inside `cwd` after lexical normalisation. */
export function isInsideWorktree(cwd: string, rel: string): boolean {
  const root = path.resolve(cwd)
  const inside = path.relative(root, path.resolve(root, rel))
  return inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside)
}

/**
 * Like `isInsideWorktree`, but also follows symlinks on the part of the path
 * that exists on disk. Without this, `link/file` where `link` points outside
 * the worktree would write or delete outside on restore.
 */
export function isSafeRestoreTarget(cwd: string, rel: string): boolean {
  if (!isInsideWorktree(cwd, rel)) return false

  let root: string
  try {
    root = realpathSync(cwd)
  } catch {
    return false
  }

  // Resolve the deepest ancestor that exists; the rest cannot escape by itself.
  let probe = path.resolve(cwd, rel)
  while (true) {
    try {
      const resolved = path.join(realpathSync(probe), path.relative(probe, path.resolve(cwd, rel)))
      const inside = path.relative(root, resolved)
      return inside !== '' && !inside.startsWith('..') && !path.isAbsolute(inside)
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return false
      probe = parent
    }
  }
}

function unique(values: string[]) {
  return [...new Set(values)]
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

function formatCheckpointLabel(cp: Checkpoint, index: number): string {
  const time = new Date(cp.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const prompt = truncate(cp.prompt, 60) || 'Turn'
  const files = cp.files.length
  const fileCount = files > 0 ? ` (${files} file${files === 1 ? '' : 's'})` : ''
  return `#${index} [${time}] ${prompt}${fileCount}`
}

type ThemeLike = ExtensionCommandContext['ui']['theme']

type CompletionItem = { value: string; label: string; description?: string }

/**
 * Pick the snapshot describing the file state at `targetId`, restricted to the
 * branch that ends at `targetId` (the last entry of `branch`).
 *
 * Case 1: target IS a checkpoint's prompt → that checkpoint's before-snapshot.
 * Case 2: target IS a checkpoint's final leaf → that checkpoint's after-snapshot.
 * Case 3: target sits inside a turn → that turn's before-snapshot.
 * Case 4: target sits between turns → the previous turn's after-snapshot.
 */
export function pickSnapshotForTarget(
  branch: SessionEntry[],
  targetId: string,
  store: Map<string, Checkpoint>,
): { checkpoint: Checkpoint; snapshot: string } | undefined {
  const position = new Map(branch.map((entry, index) => [entry.id, index]))
  if (!branch.some((entry) => entry.id === targetId)) return undefined

  const branchUserIds = new Set(
    branch.filter((e) => e.type === 'message' && e.message.role === 'user').map((e) => e.id),
  )
  const onBranch = orderByBranch(
    branch,
    [...store.values()].filter((c) => branchUserIds.has(c.userEntryId)),
  )

  const asUserEntry = onBranch.find((c) => c.userEntryId === targetId)
  if (asUserEntry) {
    return { checkpoint: asUserEntry, snapshot: asUserEntry.beforeSnapshot }
  }

  const asFinalLeaf = onBranch.find((c) => c.finalLeafId === targetId)
  if (asFinalLeaf) {
    return { checkpoint: asFinalLeaf, snapshot: asFinalLeaf.afterSnapshot }
  }

  const targetIdx = position.get(targetId)!
  const insideTurn = onBranch.find((cp) => {
    const start = position.get(cp.userEntryId)
    const end = position.get(cp.finalLeafId)
    return start !== undefined && end !== undefined && start < targetIdx && targetIdx <= end
  })
  if (insideTurn) {
    return { checkpoint: insideTurn, snapshot: insideTurn.beforeSnapshot }
  }

  const preceding = onBranch.filter((cp) => position.get(cp.userEntryId)! < targetIdx).pop()
  if (!preceding) return undefined
  return { checkpoint: preceding, snapshot: preceding.afterSnapshot }
}

/**
 * Sort checkpoints into branch order. `createdAt` is wall-clock and can only
 * be trusted within one branch, so position on the branch wins.
 */
export function orderByBranch(
  branch: SessionEntry[],
  checkpoints: Checkpoint[],
): Checkpoint[] {
  const position = new Map(branch.map((entry, index) => [entry.id, index]))
  return [...checkpoints].sort(
    (a, b) =>
      (position.get(a.userEntryId) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(b.userEntryId) ?? Number.MAX_SAFE_INTEGER),
  )
}

export function collectBranchDiffFiles(
  branch: SessionEntry[],
  checkpoints: Map<string, Checkpoint>,
): string[] {
  const branchUserIds = new Set(
    branch.filter((e) => e.type === 'message' && e.message.role === 'user').map((e) => e.id),
  )
  const files = new Set<string>()
  for (const id of branchUserIds) {
    const checkpoint = checkpoints.get(id)
    if (!checkpoint) continue
    for (const file of checkpoint.files) files.add(file)
  }
  return [...files].sort()
}

export function diffFileCompletions(files: string[], prefix: string): CompletionItem[] {
  const trimmed = prefix.trimStart().toLowerCase()
  return files
    .filter((file) => file.toLowerCase().includes(trimmed))
    .map((file) => ({ value: file, label: file, description: 'changed in this session' }))
}

export function colorizeDiff(diff: string, theme: ThemeLike): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return theme.fg('dim', line)
      if (line.startsWith('@@')) return theme.fg('dim', line)
      if (line.startsWith('+')) return theme.fg('toolDiffAdded', line)
      if (line.startsWith('-')) return theme.fg('toolDiffRemoved', line)
      return theme.fg('text', line)
    })
    .join('\n')
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Cache usage / cleanup (ported from oc-rewind, MIT)
// ---------------------------------------------------------------------------
export interface CacheEntry {
  label: string
  path: string
  bytes: number
  current: boolean
  cwd?: string
  updatedAt?: number
}

export function tildify(p: string, home = homedir()): string {
  if (home && (p === home || p.startsWith(`${home}/`))) {
    return `~${p.slice(home.length)}`
  }
  return p
}

export function age(ts: number | undefined, now: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '?'
  const ms = now - ts
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  const yr = Math.floor(mo / 12)
  return `${yr}y ago`
}

export function checkpointKey(cwd: string, sessionId: string): string {
  return createHash('sha256').update(`${cwd}\0${sessionId}`).digest('hex').slice(0, 24)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exp
  const formatted = exp === 0 ? String(Math.round(value)) : value.toFixed(value >= 100 ? 0 : 1)
  return `${formatted} ${units[exp]}`
}

export function summarizeUsage(entries: CacheEntry[], noun = 'item', plural = `${noun}s`): string {
  if (entries.length === 0) return `No cached ${plural} found.`
  const sorted = [...entries].sort((a, b) => b.bytes - a.bytes)
  const total = sorted.reduce((sum, e) => sum + e.bytes, 0)
  const width = Math.max(...sorted.map((e) => formatBytes(e.bytes).length))
  const lines = sorted.map(
    (e) => `  ${formatBytes(e.bytes).padStart(width)}  ${e.label}${e.current ? ' (current)' : ''}`,
  )
  const count = `${sorted.length} ${sorted.length === 1 ? noun : plural}`
  return [...lines, '', `  ${formatBytes(total).padStart(width)}  total across ${count}`].join('\n')
}

export function summarizeByProject(entries: CacheEntry[]): string {
  if (entries.length === 0) return 'No checkpoint snapshots found.'
  const byProject = new Map<string, { bytes: number; sessions: number }>()
  for (const entry of entries) {
    const key = entry.cwd ? tildify(entry.cwd) : '(unknown project)'
    const agg = byProject.get(key) ?? { bytes: 0, sessions: 0 }
    agg.bytes += entry.bytes
    agg.sessions += 1
    byProject.set(key, agg)
  }
  const rows = [...byProject.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
  const total = rows.reduce((sum, [, agg]) => sum + agg.bytes, 0)
  const width = Math.max(...rows.map(([, agg]) => formatBytes(agg.bytes).length))

  const lines = rows.map(([project, agg]) => {
    const size = formatBytes(agg.bytes).padStart(width)
    const sessions = `${agg.sessions} session${agg.sessions === 1 ? '' : 's'}`
    return `  ${size}  ${project} (${sessions})`
  })

  const projectCount = `${rows.length} project${rows.length === 1 ? '' : 's'}`
  return [
    ...lines,
    '',
    `  ${formatBytes(total).padStart(width)}  total across ${projectCount}`,
  ].join('\n')
}

export function filterOlderThan(entries: CacheEntry[], days: number, now: number): CacheEntry[] {
  if (!Number.isFinite(days) || days < 0) return []
  const cutoff = now - days * 24 * 60 * 60 * 1000
  return entries.filter((e) => typeof e.updatedAt === 'number' && e.updatedAt < cutoff)
}

export function parseGitWorktree(config: string): string | undefined {
  const match = config.match(/^\s*worktree\s*=\s*(.+?)\s*$/m)
  return match ? match[1] : undefined
}

async function measureDir(dir: string): Promise<number> {
  let total = 0
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await measureDir(full)
    } else if (entry.isFile()) {
      total += await stat(full)
        .then((s) => s.size)
        .catch(() => 0)
    }
  }
  return total
}

async function listCheckpointStores(currentKey: string): Promise<CacheEntry[]> {
  let dirs: Dirent[]
  try {
    dirs = await readdir(checkpointsDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const results: CacheEntry[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const full = path.join(checkpointsDir(), dir.name)
    const worktree = await readFile(path.join(full, 'config'), 'utf8')
      .then(parseGitWorktree)
      .catch(() => undefined)
    const meta = await readFile(path.join(full, META_FILE), 'utf8')
      .then((raw) => JSON.parse(raw) as { cwd?: string; updatedAt?: number })
      .catch(() => undefined)
    const mtime = await stat(full)
      .then((s) => s.mtimeMs)
      .catch(() => undefined)
    const cwd = worktree ?? meta?.cwd
    const updatedAt = meta?.updatedAt ?? mtime
    results.push({
      label:
        (cwd ? `${tildify(cwd)}  [${dir.name}]` : dir.name) + `  ${age(updatedAt, Date.now())}`,
      path: full,
      bytes: await measureDir(full),
      current: dir.name === currentKey,
      cwd,
      updatedAt,
    })
  }
  return results
}

async function manageCheckpointCache(ctx: ExtensionCommandContext) {
  if (!ctx.hasUI) return

  ctx.ui.setStatus('checkpoint', 'Listing checkpoint snapshots…')
  const currentKey = checkpointKey(ctx.cwd, ctx.sessionManager.getSessionId())
  const stores = await listCheckpointStores(currentKey)
  ctx.ui.setStatus('checkpoint', undefined)
  if (stores.length === 0) {
    ctx.ui.notify('No checkpoint snapshots found.', 'info')
    return
  }

  ctx.ui.notify(`${summarizeByProject(stores)}\n\n${summarizeUsage(stores, 'session')}`, 'info')

  const DELETE_OLD = 'Delete snapshots older than N days…'
  const DELETE_OTHERS = 'Delete all EXCEPT current session'
  const DELETE_ALL = 'Delete ALL checkpoint snapshots'
  const CANCEL = 'Cancel'
  const hasOthers = stores.some((s) => !s.current)
  const options = hasOthers
    ? [DELETE_OLD, DELETE_OTHERS, DELETE_ALL, CANCEL]
    : [DELETE_OLD, DELETE_ALL, CANCEL]
  const choice = await ctx.ui.select('Checkpoint snapshots', options)
  if (!choice || choice === CANCEL) return

  let targets: CacheEntry[]
  let warning: string

  if (choice === DELETE_OLD) {
    const answer = await ctx.ui.input('Delete snapshots older than how many days?', '7')
    if (answer === undefined) return
    const days = Number.parseFloat(answer.trim())
    if (!Number.isFinite(days) || days < 0) {
      ctx.ui.notify('Please enter a non-negative number of days.', 'warning')
      return
    }
    targets = filterOlderThan(
      stores.filter((s) => !s.current),
      days,
      Date.now(),
    )
    if (targets.length === 0) {
      ctx.ui.notify(`No snapshots older than ${days} day(s) (current session excluded).`, 'info')
      return
    }
    const freedTotal = formatBytes(targets.reduce((sum, s) => sum + s.bytes, 0))
    warning = `This permanently removes ${targets.length} snapshot store(s) older than ${days}`
    warning += ` day(s), freeing ${freedTotal}. The current session is kept.`
  } else {
    targets = choice === DELETE_OTHERS ? stores.filter((s) => !s.current) : stores
    const freedTotal = formatBytes(targets.reduce((sum, s) => sum + s.bytes, 0))
    warning = `This permanently removes ${targets.length} snapshot store(s) freeing ${freedTotal}.`

    warning +=
      choice === DELETE_ALL
        ? ' This includes the current session; undo/redo history for it will be lost.'
        : ' The current session is kept.'
  }

  const ok = await ctx.ui.confirm('Delete checkpoint snapshots?', warning)
  if (!ok) return

  let freed = 0
  ctx.ui.setStatus('checkpoint', `Deleting ${targets.length} snapshot store(s)…`)
  for (const store of targets) {
    await rm(store.path, { recursive: true, force: true }).catch(() => {})
    freed += store.bytes
  }
  ctx.ui.setStatus('checkpoint', undefined)
  ctx.ui.notify(`Deleted ${targets.length} snapshot store(s); freed ${formatBytes(freed)}.`, 'info')
}
