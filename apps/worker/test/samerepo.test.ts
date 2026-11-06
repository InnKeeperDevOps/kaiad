import { describe, it, expect, vi } from "vitest";
import { isSameRepo, normalizeGitRepoUrl, sameRepoDependencies } from "../src/samerepo.js";

describe("normalizeGitRepoUrl", () => {
  it("treats scp-style ssh, ssh:// and https forms as equivalent", () => {
    const want = "github.com/acme/mochimask";
    for (const url of [
      "git@github.com:acme/mochimask.git",
      "git@github.com:acme/mochimask",
      "ssh://git@github.com/acme/mochimask.git",
      "ssh://git@github.com:22/acme/mochimask",
      "https://github.com/acme/mochimask.git",
      "https://github.com/acme/mochimask/",
      "https://x-access-token:secret@github.com/acme/mochimask.git/",
      "  https://github.com/acme/mochimask  "
    ]) {
      expect(normalizeGitRepoUrl(url), url).toBe(want);
    }
  });

  it("lowercases the host always, the path only on known case-insensitive hosts", () => {
    expect(normalizeGitRepoUrl("https://GitHub.com/Acme/Repo.git")).toBe("github.com/acme/repo");
    expect(normalizeGitRepoUrl("git@GITLAB.com:Grp/Sub/Repo.git")).toBe("gitlab.com/grp/sub/repo");
    expect(normalizeGitRepoUrl("https://bitbucket.org/Team/Repo")).toBe("bitbucket.org/team/repo");
    // Self-hosted: host lowercased, path case kept.
    expect(normalizeGitRepoUrl("ssh://git@Gitea.Example.com:2222/Org/Repo.git")).toBe(
      "gitea.example.com/Org/Repo"
    );
    expect(normalizeGitRepoUrl("https://gitea.example.com/Org/Repo")).toBe("gitea.example.com/Org/Repo");
    expect(normalizeGitRepoUrl("https://gitea.example.com/org/repo")).not.toBe(
      normalizeGitRepoUrl("https://gitea.example.com/Org/Repo")
    );
  });

  it("strips .git case-insensitively and repeated trailing slashes", () => {
    expect(normalizeGitRepoUrl("https://github.com/a/b.GIT//")).toBe("github.com/a/b");
    expect(normalizeGitRepoUrl("git@host.local:a/b.git/")).toBe("host.local/a/b");
  });

  it("compares non-remote forms literally (cleaned)", () => {
    expect(normalizeGitRepoUrl("/srv/git/repo.git/")).toBe("srv/git/repo");
    expect(normalizeGitRepoUrl("file:///srv/git/repo.git")).toBe("file:///srv/git/repo");
    expect(normalizeGitRepoUrl("relative/repo")).toBe("relative/repo");
  });

  it("falls back to the literal (and warns, redacting credentials) on an unparseable URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(normalizeGitRepoUrl("https://user:pw@exa mple.com/a.git")).toBe("https://user:pw@exa mple.com/a");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls[0])).not.toContain("pw@");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("isSameRepo", () => {
  it("needs the same normalised URL and the same branch", () => {
    const a = { gitRepoUrl: "git@github.com:acme/app.git", branch: "main" };
    expect(isSameRepo(a, { gitRepoUrl: "https://github.com/acme/app", branch: "main" })).toBe(true);
    expect(isSameRepo(a, { gitRepoUrl: "https://github.com/acme/app", branch: " main " })).toBe(true);
    expect(isSameRepo(a, { gitRepoUrl: "https://github.com/acme/app", branch: "develop" })).toBe(false);
    expect(isSameRepo(a, { gitRepoUrl: "https://github.com/acme/other", branch: "main" })).toBe(false);
  });
});

describe("sameRepoDependencies", () => {
  const repo = "git@github.com:acme/mochimask.git";
  const graph = [
    { id: "app", tenantId: "t1", name: "mochimask-app", gitRepoUrl: "https://github.com/acme/mochimask", branch: "main", dependsOn: [] },
    { id: "lib", tenantId: "t1", name: "shared-lib", gitRepoUrl: "https://github.com/acme/lib", branch: "main", dependsOn: [] },
    { id: "app-t2", tenantId: "t2", name: "other", gitRepoUrl: repo, branch: "main", dependsOn: [] },
    { id: "w", tenantId: "t1", name: "mochimask-worker", gitRepoUrl: repo, branch: "main", dependsOn: ["mochimask-app", "shared-lib", "ghost", "mochimask-worker", "mochimask-app", "other"] }
  ];

  it("keeps only existing, same-tenant, same-repo deps (no self, no duplicates)", () => {
    const deps = sameRepoDependencies(graph[3], graph);
    expect(deps.map((d) => d.id)).toEqual(["app"]);
  });

  it("is empty for a service without dependsOn", () => {
    expect(sameRepoDependencies(graph[0], graph)).toEqual([]);
  });
});
