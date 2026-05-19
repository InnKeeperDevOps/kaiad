// Server-side autonomous fix runner. The fix executes HERE, inside the
// kaiad container — not on the agent (the agent pod is memory-capped and
// OOM-kills the Node-based AI CLI; kaiad is a long-lived container that
// already has git + openssh + the SSH key material). The agent's only
// role is shipping the error that creates the incident.
//
// Flow: clone the service repo with its configured SSH key → run the
// per-service AI CLI (claude|cursor) on the error+repo prompt → commit
// → push to the service's configured branch. The CLI authenticates via
// its own logged-in session (e.g. ~/.claude), NOT an API key.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface KaiadFixParams {
  repoUrl: string;
  branch: string;
  sshKeyType: "uploaded" | "local_path";
  /** Private-key PEM (uploaded) or a path on disk (local_path). */
  sshKeyValue: string | null;
  executor: "claude" | "cursor";
  errorMessage: string;
  contextLines: string[];
  timeoutMs?: number;
  logger?: { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void };
}

export type KaiadFixReason =
  | "no_changes"
  | "auth"
  | "clone_failed"
  | "cli_failed"
  | "push_failed"
  | "error";

export interface KaiadFixResult {
  ok: boolean;
  commitSha?: string;
  reason?: KaiadFixReason;
  output: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// The AI CLIs refuse to run as root ("--dangerously-skip-permissions /
// bypassPermissions cannot be used with root"). The kaiad container
// runs as root, so the CLI subprocess is dropped to an unprivileged
// uid (the node:22 image ships `node` = uid/gid 1000 with /home/node).
// git runs as root before/after, so the scratch tree is chowned to the
// CLI uid for the CLI step and back to root for commit/push.
const FIX_UID = Number(process.env.SM_FIX_UID) || 1000;
const FIX_GID = Number(process.env.SM_FIX_GID) || 1000;
const FIX_HOME = process.env.SM_FIX_HOME || "/home/node";
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// normalizePEM repairs transport damage to a key without changing its
// content: CRLF/CR → LF and exactly one trailing newline. Both are
// required by OpenSSH and routinely lost when a key is pasted through a
// browser textarea / JSON. Mirrors the agent's normalizePEM.
function normalizePEM(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "") + "\n";
}

function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; uid?: number; gid?: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        ...(opts.uid != null ? { uid: opts.uid } : {}),
        ...(opts.gid != null ? { gid: opts.gid } : {})
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = e && typeof e.code === "number" ? e.code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

// buildFixPrompt — the prompt sent to the AI CLI. It carries the repo
// and the error explicitly (the CLI also operates inside the clone).
export function buildFixPrompt(
  repoUrl: string,
  branch: string,
  errorMessage: string,
  contextLines: string[]
): string {
  const ctx = contextLines.length ? contextLines.join("\n") : "(none)";
  return [
    "You are an automated code-fix agent invoked by Kaiad. A running service has emitted the error below. You are inside a fresh clone of that service's repository at the working directory.",
    "",
    `REPOSITORY: ${repoUrl} (branch ${branch})`,
    "",
    "ERROR:",
    errorMessage,
    "",
    "LOG CONTEXT (last lines before the error):",
    ctx,
    "",
    "INSTRUCTIONS:",
    "1. Identify the root cause from the error and surrounding code.",
    "2. Edit only the files necessary to fix the bug. Do not refactor or change unrelated code.",
    "3. Do NOT run git commands and do NOT commit or push. Kaiad commits and pushes your changes after you exit.",
    "4. If you cannot find a fix, exit without modifying any files."
  ].join("\n");
}

function looksLikeAuthFailure(s: string): boolean {
  return (
    /Permission denied \(publickey\)/i.test(s) ||
    /could not read from remote repository/i.test(s) ||
    /error in libcrypto/i.test(s) ||
    /Host key verification failed/i.test(s)
  );
}

/** Clone → AI CLI → commit → push, entirely within the kaiad container. */
export async function runKaiadFix(p: KaiadFixParams): Promise<KaiadFixResult> {
  const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const branch = p.branch || "main";
  const scratch = await mkdtemp(join(tmpdir(), "kaiad-fix-"));
  let keyPath: string | null = null;
  const env: NodeJS.ProcessEnv = { ...process.env };

  try {
    if (p.sshKeyType === "uploaded" && p.sshKeyValue) {
      keyPath = join(scratch, ".sshkey");
      await writeFile(keyPath, normalizePEM(p.sshKeyValue), { mode: 0o600 });
      await chmod(keyPath, 0o600);
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o BatchMode=yes`;
    } else if (p.sshKeyType === "local_path" && p.sshKeyValue) {
      env.GIT_SSH_COMMAND = `ssh -i ${p.sshKeyValue} -o StrictHostKeyChecking=no -o BatchMode=yes`;
    }

    const clone = await run(
      "git",
      ["clone", "--branch", branch, "--single-branch", p.repoUrl, "."],
      { cwd: scratch, env, timeoutMs }
    );
    if (clone.code !== 0) {
      const out = clone.stdout + clone.stderr;
      return {
        ok: false,
        reason: looksLikeAuthFailure(out) ? "auth" : "clone_failed",
        output: `git clone failed:\n${out}`
      };
    }

    for (const [k, v] of [
      ["user.email", "kaiad-bot@kaiad.dev"],
      ["user.name", "Kaiad Auto-Fix"]
    ]) {
      await run("git", ["config", k, v], { cwd: scratch, env, timeoutMs: 15000 });
    }

    const prompt = buildFixPrompt(p.repoUrl, branch, p.errorMessage, p.contextLines);
    // claude: -p non-interactive; bypassPermissions skips the prompt
    // gate. cursor-agent: -p headless, --force skips edit approval.
    const [bin, args] =
      p.executor === "cursor"
        ? ["cursor-agent", ["-p", prompt, "--force"]]
        : ["claude", ["-p", "--permission-mode", "bypassPermissions", prompt]];

    // Drop the CLI to a non-root uid (it refuses to run as root). git
    // stays root, so hand the tree to the CLI uid for this step only.
    const cliEnv: NodeJS.ProcessEnv = { ...env };
    let cliUid: number | undefined;
    let cliGid: number | undefined;
    if (runningAsRoot) {
      await run("chown", ["-R", `${FIX_UID}:${FIX_GID}`, scratch], {
        timeoutMs: 30000
      });
      cliEnv.HOME = FIX_HOME;
      cliUid = FIX_UID;
      cliGid = FIX_GID;
    }
    const cli = await run(bin, args, {
      cwd: scratch,
      env: cliEnv,
      timeoutMs,
      uid: cliUid,
      gid: cliGid
    });
    if (runningAsRoot) {
      // Reclaim ownership so the root git commit/push can write.
      await run("chown", ["-R", "0:0", scratch], { timeoutMs: 30000 });
    }
    const cliOut = cli.stdout + cli.stderr;
    if (cli.code !== 0) {
      return { ok: false, reason: "cli_failed", output: `${p.executor} failed:\n${cliOut}` };
    }

    const status = await run("git", ["status", "--porcelain"], {
      cwd: scratch,
      env,
      timeoutMs: 15000
    });
    if (status.stdout.trim() === "") {
      return { ok: false, reason: "no_changes", output: `${p.executor} made no changes.\n${cliOut}` };
    }

    await run("git", ["add", "-A"], { cwd: scratch, env, timeoutMs: 30000 });
    const commitMsg = `fix(auto): ${p.errorMessage.split("\n")[0].slice(0, 72)}`;
    const commit = await run("git", ["commit", "-m", commitMsg], {
      cwd: scratch,
      env,
      timeoutMs: 30000
    });
    if (commit.code !== 0) {
      return { ok: false, reason: "error", output: `git commit failed:\n${commit.stdout}${commit.stderr}` };
    }

    const push = await run("git", ["push", "origin", branch], {
      cwd: scratch,
      env,
      timeoutMs
    });
    if (push.code !== 0) {
      const out = push.stdout + push.stderr;
      return {
        ok: false,
        reason: looksLikeAuthFailure(out) ? "auth" : "push_failed",
        output: `git push failed:\n${out}`
      };
    }

    const rev = await run("git", ["rev-parse", "HEAD"], {
      cwd: scratch,
      env,
      timeoutMs: 15000
    });
    const commitSha = rev.stdout.trim();
    p.logger?.info?.({ event: "kaiad_fix.pushed", commitSha, branch });
    return { ok: true, commitSha, output: `pushed ${commitSha} to ${branch}\n${cliOut}` };
  } catch (err) {
    return { ok: false, reason: "error", output: `kaiad fix error: ${(err as Error).message}` };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
