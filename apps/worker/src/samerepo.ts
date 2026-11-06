// Same-repo dependency detection for the dependsOn same-commit rule.
//
// A dependency is "same-repo" when its git repo URL AND branch equal the
// dependent's after normalisation. For those deps a dependent build at
// commit X may only consume the dependency's build at X (see
// builddeps.ts), and the poller leaves the dependent to the chain
// trigger instead of building it on every commit (see builds.ts).

/**
 * Hosts whose repo paths are case-insensitive. On every other host the
 * path keeps its case: self-hosted servers (Gitea, GitLab CE, bare SSH)
 * can be case-sensitive, so `Org/Repo` and `org/repo` there are treated
 * as different repos.
 */
const CASE_INSENSITIVE_PATH_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

function cleanPath(p: string): string {
  let out = p.replace(/^\/+/, "").replace(/\/+$/, "");
  if (out.toLowerCase().endsWith(".git")) out = out.slice(0, -4);
  return out.replace(/\/+$/, "");
}

/**
 * Canonical `host/path` key for a git remote URL, so the scp-style ssh
 * form (`git@host:org/repo.git`), `ssh://[user@]host[:port]/org/repo` and
 * `https://[user@]host/org/repo` all compare equal.
 *
 * - user info and port are dropped (ssh and https of one server commonly
 *   use different ports and users but address the same repo);
 * - trailing `.git` and trailing slashes are stripped;
 * - the host is lowercased; the path is lowercased only for github.com,
 *   gitlab.com and bitbucket.org.
 *
 * Anything that is not a recognisable remote (local paths, file://) is
 * returned trimmed with `.git`/slashes stripped, so it still compares
 * equal to itself.
 */
export function normalizeGitRepoUrl(raw: string): string {
  const url = raw.trim();
  let host: string;
  let repoPath: string;

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) {
    if (scheme[1].toLowerCase() === "file") return cleanPath(url);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      // Documented fallback: compare the cleaned literal instead. Logged
      // so a malformed remote URL is visible rather than silently odd.
      console.warn("[builds][WARN] git repo URL is not parseable; comparing it literally", {
        url: url.replace(/\/\/[^@/]*@/, "//***@"),
        err: (err as Error).message
      });
      return cleanPath(url);
    }
    host = parsed.hostname.toLowerCase();
    repoPath = parsed.pathname;
  } else {
    // scp-like syntax: [user@]host:path  (no "//" after the colon).
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(url);
    if (!scp) return cleanPath(url);
    host = scp[1].toLowerCase();
    repoPath = scp[2];
  }

  let p = cleanPath(repoPath);
  if (CASE_INSENSITIVE_PATH_HOSTS.has(host)) p = p.toLowerCase();
  return `${host}/${p}`;
}

export type RepoRef = { gitRepoUrl: string; branch: string };

/**
 * True when both refs point at the same repo AND branch. Branches are
 * compared exactly (trimmed) — the same value the build rows record, so
 * branch-filtered build queries agree with this check.
 */
export function isSameRepo(a: RepoRef, b: RepoRef): boolean {
  return (
    normalizeGitRepoUrl(a.gitRepoUrl) === normalizeGitRepoUrl(b.gitRepoUrl) &&
    a.branch.trim() === b.branch.trim()
  );
}

export type DependencyGraphNode = RepoRef & {
  id: string;
  tenantId: string;
  name: string;
  dependsOn: string[];
};
/**
 * The same-repo dependencies of `svc` (from its cached `dependsOn`),
 * looked up by name within its tenant in `graph`. Deps that don't exist
 * as a service, or that are the service itself, are skipped.
 */
export function sameRepoDependencies<T extends DependencyGraphNode>(
  svc: Pick<DependencyGraphNode, "id" | "tenantId" | "gitRepoUrl" | "branch" | "dependsOn">,
  graph: T[]
): T[] {
  const out: T[] = [];
  for (const depName of new Set(svc.dependsOn)) {
    const dep = graph.find((g) => g.tenantId === svc.tenantId && g.name === depName);
    if (!dep || dep.id === svc.id) continue;
    if (isSameRepo(dep, svc)) out.push(dep);
  }
  return out;
}
