/**
 * The repository name a git remote points at: its last path segment without
 * `.git`, case kept (`git@github.com:acme/Widgets.git` -> `Widgets`). The
 * default name of a team project added from a workspace with a remote, so the
 * web console does not label it by its id.
 */
export function repositoryNameFromRemote(rawRemote: string | null | undefined): string | null {
  if (!rawRemote) return null;
  const path = rawRemote.trim().replace(/[?#].*$/, '');
  const segment = path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .pop();
  return segment || null;
}
