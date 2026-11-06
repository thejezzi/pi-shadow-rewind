import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

import {
  ShadowGit,
  collectBranchDiffFiles,
  diffFileCompletions,
  filterOlderThan,
  formatBytes,
  isInsideWorktree,
  normalizeGitPath,
  parseBashPaths,
  parseGitWorktree,
  pickSnapshotForTarget,
  tildify,
} from '../index.ts'

const run = promisify(execFile)

describe('normalizeGitPath', () => {
  it('keeps ordinary relative paths', () => {
    assert.equal(normalizeGitPath('src/index.ts'), 'src/index.ts')
    assert.equal(normalizeGitPath('src\\index.ts'), 'src/index.ts')
    assert.equal(normalizeGitPath('./src/index.ts'), 'src/index.ts')
  })

  it('rejects paths that climb out of the worktree', () => {
    assert.equal(normalizeGitPath('..'), undefined)
    assert.equal(normalizeGitPath('../secret.txt'), undefined)
    assert.equal(normalizeGitPath('a/../../secret.txt'), undefined)
    assert.equal(normalizeGitPath('src/../../etc/passwd'), undefined)
  })

  it('rejects absolute paths and the pi state dir', () => {
    assert.equal(normalizeGitPath('/etc/passwd'), undefined)
    assert.equal(normalizeGitPath('.pi/agent/checkpoints'), undefined)
    assert.equal(normalizeGitPath(''), undefined)
  })

  it('strips trailing slashes from directories', () => {
    assert.equal(normalizeGitPath('src/lib/'), 'src/lib')
  })
})

describe('isInsideWorktree', () => {
  it('accepts paths inside the worktree', () => {
    assert.equal(isInsideWorktree('/work/project', 'src/index.ts'), true)
    assert.equal(isInsideWorktree('/work/project', 'src'), true)
  })

  it('rejects paths that resolve outside the worktree', () => {
    assert.equal(isInsideWorktree('/work/project', '../other/file.txt'), false)
    assert.equal(isInsideWorktree('/work/project', 'src/../../other/file.txt'), false)
    assert.equal(isInsideWorktree('/work/project', '/etc/passwd'), false)
  })
})

describe('filterOlderThan', () => {
  const now = Date.parse('2026-01-10T00:00:00Z')
  const entry = (updatedAt?: number) => ({
    label: 'x',
    path: '/tmp/x',
    bytes: 1,
    current: false,
    updatedAt,
  })

  it('keeps only stores older than the cutoff', () => {
    const old = entry(now - 10 * 24 * 60 * 60 * 1000)
    const fresh = entry(now - 24 * 60 * 60 * 1000)
    assert.deepEqual(filterOlderThan([old, fresh], 7, now), [old])
  })

  it('never selects stores without a timestamp or with a bad day count', () => {
    assert.deepEqual(filterOlderThan([entry(undefined)], 7, now), [])
    assert.deepEqual(filterOlderThan([entry(0)], -1, now), [])
    assert.deepEqual(filterOlderThan([entry(0)], Number.NaN, now), [])
  })
})

describe('formatting helpers', () => {
  it('formats byte counts', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(1536), '1.5 KB')
  })

  it('shortens the home directory to ~', () => {
    assert.equal(tildify('/home/me/project', '/home/me'), '~/project')
    assert.equal(tildify('/home/me', '/home/me'), '~')
    assert.equal(tildify('/srv/project', '/home/me'), '/srv/project')
  })

  it('reads the worktree out of a git config', () => {
    assert.equal(parseGitWorktree('[core]\n\tworktree = /work/project\n'), '/work/project')
    assert.equal(parseGitWorktree('[core]\n'), undefined)
  })
})

describe('diffFileCompletions', () => {
  it('matches on a case-insensitive substring', () => {
    const files = ['src/index.ts', 'README.md']
    const values = (prefix: string) => diffFileCompletions(files, prefix).map((item) => item.value)

    assert.deepEqual(values('readme'), ['README.md'])
    assert.equal(values('missing').length, 0)
  })
})

describe('collectBranchDiffFiles', () => {
  it('unions files from checkpoints on the branch only', () => {
    const branch = [
      { id: 'u1', type: 'message', message: { role: 'user', content: 'one' } },
      { id: 'u2', type: 'message', message: { role: 'user', content: 'two' } },
    ] as never
    const checkpoint = (userEntryId: string, files: string[]) => ({ userEntryId, files }) as never
    const checkpoints = new Map<string, never>([
      ['u1', checkpoint('u1', ['b.ts', 'a.ts'])],
      ['u2', checkpoint('u2', ['b.ts', 'c.ts'])],
      ['off-branch', checkpoint('off-branch', ['d.ts'])],
    ])

    assert.deepEqual(collectBranchDiffFiles(branch, checkpoints as never), ['a.ts', 'b.ts', 'c.ts'])
  })
})

describe('parseBashPaths', () => {
  const tracked = (command: string) => parseBashPaths(command).sort()

  it('records the destination of cp, never the source', () => {
    // A rewind that staged the source would delete the original file.
    assert.deepEqual(tracked('cp source.txt copy.txt'), ['copy.txt'])
    assert.deepEqual(tracked('cp -r src/ dst/'), ['dst/'])
    assert.deepEqual(tracked('install -m 644 a.conf /etc/a.conf'), ['/etc/a.conf'])
  })

  it('records both sides of mv', () => {
    assert.deepEqual(tracked('mv old.txt new.txt'), ['new.txt', 'old.txt'])
  })

  it('records rm and mkdir targets with quoted names', () => {
    assert.deepEqual(tracked('rm -rf "build output"'), ['build output'])
    assert.deepEqual(tracked('mkdir -p src/generated'), ['src/generated'])
  })

  it('keeps commands apart when chained', () => {
    assert.deepEqual(tracked('rm a.txt && cp b.txt c.txt'), ['a.txt', 'c.txt'])
  })

  it('ignores read-only commands', () => {
    assert.deepEqual(tracked('cat a.txt | grep x'), [])
    assert.deepEqual(tracked('git status'), [])
  })

  it('writes tee targets', () => {
    assert.deepEqual(tracked('echo hi | tee out.log'), ['out.log'])
  })
})

describe('pickSnapshotForTarget', () => {
  const user = (id: string) => ({ id, type: 'message', message: { role: 'user', content: id } })
  const assistant = (id: string) => ({
    id,
    type: 'message',
    message: { role: 'assistant', content: id },
  })

  // Branch: u1 -> a1 -> u2 -> a2
  const branch = [user('u1'), assistant('a1'), user('u2'), assistant('a2')] as never
  const checkpoint = (userEntryId: string, finalLeafId: string) =>
    ({
      userEntryId,
      finalLeafId,
      beforeSnapshot: `${userEntryId}-before`,
      afterSnapshot: `${finalLeafId}-after`,
      beforeLeafId: null,
      prompt: userEntryId,
      files: ['f.ts'],
      createdAt: 0,
    }) as never
  const store = new Map<string, never>([
    ['u1', checkpoint('u1', 'a1')],
    ['u2', checkpoint('u2', 'a2')],
  ])

  it('restores the before-snapshot when the target is a prompt', () => {
    assert.equal(pickSnapshotForTarget(branch, 'u1', store as never)?.snapshot, 'u1-before')
  })

  it('restores the after-snapshot when the target is a turn end', () => {
    assert.equal(pickSnapshotForTarget(branch, 'a1', store as never)?.snapshot, 'a1-after')
  })

  it('restores the before-snapshot when the target is inside a turn', () => {
    const inside = [user('u1'), assistant('a1'), { id: 'tool', type: 'custom' }] as never
    // The turn ran until 'tool', so 'a1' sits inside it but is not its end.
    const longTurn = new Map<string, never>([['u1', checkpoint('u1', 'tool')]])

    assert.equal(pickSnapshotForTarget(inside, 'a1', longTurn as never)?.snapshot, 'u1-before')
  })

  it('restores the preceding turn for a target between turns', () => {
    const between = [user('u1'), assistant('a1'), { id: 'note', type: 'custom' }] as never
    assert.equal(pickSnapshotForTarget(between, 'note', store as never)?.snapshot, 'a1-after')
  })

  it('ignores checkpoints from another branch', () => {
    const otherBranch = [user('x1'), assistant('x1-end')] as never
    assert.equal(pickSnapshotForTarget(otherBranch, 'x1-end', store as never), undefined)
  })

  it('returns nothing for an unknown target', () => {
    assert.equal(pickSnapshotForTarget(branch, 'nope', store as never), undefined)
  })
})

describe('ShadowGit', () => {
  let worktree: string
  let store: string
  let snap: ShadowGit

  before(async () => {
    worktree = await mkdtemp(path.join(tmpdir(), 'pi-shadow-worktree-'))
    store = await mkdtemp(path.join(tmpdir(), 'pi-shadow-store-'))
    process.env.PI_SHADOW_REWIND_DIR = store
    snap = new ShadowGit(fakePi(), worktree, 'test-session')
  })

  after(async () => {
    delete process.env.PI_SHADOW_REWIND_DIR
    await rm(worktree, { recursive: true, force: true })
    await rm(store, { recursive: true, force: true })
  })

  it('captures a file the project ignores', async () => {
    await writeFile(path.join(worktree, '.gitignore'), '*.env\n')
    await writeFile(path.join(worktree, 'secret.env'), 'TOKEN=abc\n')

    const warnings: string[] = []
    const before = await snap.track()
    const after = await snap.track(['secret.env'], (warning) => warnings.push(warning))

    assert.deepEqual(warnings, [])
    assert.deepEqual(await snap.diffFiles(before, after), ['secret.env'])
  })

  it('records a deletion when the file is gone', async () => {
    const before = await snap.track()
    await rm(path.join(worktree, 'secret.env'))
    const after = await snap.track(['secret.env'])

    assert.deepEqual(await snap.diffFiles(before, after), ['secret.env'])
  })

  it('restores the snapshotted content', async () => {
    const target = 'notes.txt'
    await writeFile(path.join(worktree, target), 'v1\n')
    const v1 = await snap.track([target])

    await writeFile(path.join(worktree, target), 'v2\n')
    await snap.track([target])

    await snap.restoreFiles(v1, [target])
    assert.equal(await readFile(path.join(worktree, target), 'utf8'), 'v1\n')
  })

  it('recreates a file that was deleted after the snapshot', async () => {
    const target = 'gone.txt'
    await writeFile(path.join(worktree, target), 'keep me\n')
    const withFile = await snap.track([target])

    await rm(path.join(worktree, target))
    await snap.track([target])

    await snap.restoreFiles(withFile, [target])
    assert.equal(await readFile(path.join(worktree, target), 'utf8'), 'keep me\n')
  })

  it('deletes a file that the snapshot did not contain', async () => {
    const target = 'created-later.txt'
    const beforeCreate = await snap.track()

    await writeFile(path.join(worktree, target), 'new\n')
    await snap.track([target])

    await snap.restoreFiles(beforeCreate, [target])
    await assert.rejects(stat(path.join(worktree, target)))
  })

  it('refuses to delete or restore outside the worktree', async () => {
    const outside = path.join(path.dirname(worktree), 'must-survive.txt')
    await writeFile(outside, 'safe\n')

    const emptyTree = await snap.track()
    await snap.restoreFiles(emptyTree, ['../must-survive.txt', '..'])

    assert.equal(await readFile(outside, 'utf8'), 'safe\n')
    await rm(outside, { force: true })
  })

  it('refuses to follow a symlink out of the worktree', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'pi-shadow-outside-'))
    await writeFile(path.join(outsideDir, 'target.txt'), 'original\n')

    const link = path.join(worktree, 'escape')
    await symlink(outsideDir, link, 'dir')

    const emptyTree = await snap.track()
    await snap.restoreFiles(emptyTree, ['escape/target.txt'])

    assert.equal(await readFile(path.join(outsideDir, 'target.txt'), 'utf8'), 'original\n')
    await rm(link, { force: true })
    await rm(outsideDir, { recursive: true, force: true })
  })
})

/** Minimal stand-in for pi.exec: run git for real, no shell. */
function fakePi() {
  return {
    async exec(command: string, args: string[], options: { cwd: string }) {
      try {
        const { stdout, stderr } = await run(command, args, { cwd: options.cwd })
        return { stdout, stderr, code: 0 }
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string }
        return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: 1 }
      }
    },
  } as never
}
