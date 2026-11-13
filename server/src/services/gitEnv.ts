/**
 * simple-git に .env() で渡す環境変数。
 *
 * simple-git は .env() で環境変数を明示すると、その中に GIT_ASKPASS / EDITOR / PAGER / PREFIX /
 * GIT_SSH_COMMAND / GIT_CONFIG_* 等があると「unsafe」として例外を投げる
 * (VS Code のターミナルや Git Bash・npm から起動すると、これらが process.env に入っている)。
 * 参照専用の status 等では不要な変数なので、取り除いたうえで追加の変数を足す。
 */
const BLOCKED = new Set([
  'editor',
  'git_askpass',
  'git_editor',
  'git_exec_path',
  'git_external_diff',
  'git_pager',
  'git_proxy_command',
  'git_sequence_editor',
  'git_ssh',
  'git_ssh_command',
  'git_template_dir',
  'pager',
  'prefix',
  'ssh_askpass',
]);

function isBlocked(name: string): boolean {
  const key = name.toLowerCase().trim();
  return BLOCKED.has(key) || key.startsWith('git_config');
}

export function simpleGitEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !isBlocked(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

/** index を書き戻さない (任意ロックを取らない) 参照専用の git 実行用 */
export const READ_ONLY_GIT_ENV = (): Record<string, string> => simpleGitEnv({ GIT_OPTIONAL_LOCKS: '0' });
