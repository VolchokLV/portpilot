import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

/** A linked worktree has a `.git` file (not directory) pointing at the main repo. */
export function isLinkedWorktree(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

export function getCurrentBranch(dir: string): string | undefined {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch && branch !== 'HEAD' ? branch : undefined;
}

/** Path of the main working tree for a repo or worktree. */
export function getMainWorktreePath(dir: string): string | undefined {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return undefined;
  return path.dirname(path.resolve(common));
}

export interface Worktree {
  path: string;
  branch?: string;
  main: boolean;
}

export function listWorktrees(dir: string): Worktree[] {
  const output = git(dir, ['worktree', 'list', '--porcelain']);
  if (!output) return [];

  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current?.path) worktrees.push(current as Worktree);
      current = { path: path.resolve(line.slice('worktree '.length)), main: worktrees.length === 0 };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (current?.path) worktrees.push(current as Worktree);
  return worktrees;
}

/** Turn a branch name into a DNS label: feature/fix-ui -> feature-fix-ui */
export function branchToLabel(branch: string): string {
  return branch
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}
