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
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
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
  /** Called at each phase boundary so the Incidents UI can render the
   *  live fix timeline (clone → CLI → commit → push, with errors). */
  onProgress?: (event: FixProgressEvent) => void;
}

export type FixProgressEvent = {
  step:
    | "started"
    | "cloning"
    | "cli"
    | "no_changes"
    | "committing"
    | "pushing"
    | "succeeded"
    | "failed";
  ok?: boolean;
  message?: string;
  /** Command line as it was executed (e.g. "git clone --branch main …"). */
  cmd?: string;
  /** Truncated stdout+stderr from that command (best diagnostic per step). */
  output?: string;
  /** Process exit code. */
  code?: number;
};

// Trim noisy command output before persisting / displaying.
const OUTPUT_HEAD = 1200;

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

// Per-CLI-attempt timeout. With the retry loop (default 3 attempts)
// the total fix budget is 3× this. 5 min × 3 = 15 min worst case
// felt sluggish on the Incidents page when the CLI silently hung; 90s
// surfaces failures fast while still leaving headroom for a real fix.
const DEFAULT_TIMEOUT_MS = Number(process.env.SM_EXECUTOR_TIMEOUT_MS) || 90 * 1000;

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

// runCli runs the AI CLI with stdin explicitly closed and (when uid is
// requested AND we are root) drops privileges via `setpriv` rather than
// Node's spawn `{uid,gid}` option:
//   - Node's spawn-with-uid keeps the parent's SUPPLEMENTARY GROUPS on
//     the child (Node docs). claude-code under that path hangs until
//     SIGKILL'd (reporting code 1 with empty stdout/stderr) when given
//     the large production prompt + the kaiad container's env. The
//     same invocation via `setpriv --clear-groups …` completes in
//     seconds with real output.
//   - setpriv keeps Node's own fork/exec untouched, and the explicit
//     `--clear-groups` matches what a fresh login as that user would
//     produce.
// `signaled` distinguishes a timeout-kill from a genuine non-zero exit
// so callers can produce useful error messages.
function runCli(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; uid?: number; gid?: number }
): Promise<{ code: number; stdout: string; stderr: string; signaled?: boolean }> {
  return new Promise((resolve) => {
    let realBin = bin;
    let realArgs = args;
    if (opts.uid != null && runningAsRoot) {
      realBin = "setpriv";
      realArgs = [
        "--reuid",
        String(opts.uid),
        "--regid",
        String(opts.gid ?? opts.uid),
        "--clear-groups",
        "--",
        bin,
        ...args
      ];
    }
    const child = spawn(realBin, realArgs, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let signaled = false;
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      signaled = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, signaled });
    });
  });
}

// buildFixPrompt — the prompt sent to the AI CLI. Carries the repo and
// the error explicitly (the CLI also operates inside the clone) and
// hard-states that this is an AUTOMATED, non-interactive run so the
// model commits to a best-effort decision instead of stalling on
// clarifying questions.
// Keep the prompt aggressively small. Empirically claude-code 2.1.x
// hangs on prompts that include the full Spring/Hibernate stack trace
// the agent ships — even when other 9KB-class prompts process fine.
// Claude can read the repo on its own; we only need to point it at the
// deepest exception. Keep the FIRST "Caused by:" we can find (root
// cause for nested exceptions in Java) plus a few following lines, or
// the last ~10 lines if no "Caused by:" — bounded to ~800 bytes.
const MAX_PROMPT_CONTEXT_BYTES = 800;
const MAX_PROMPT_CONTEXT_LINES = 12;

function trimContextForPrompt(lines: string[]): string {
  if (lines.length === 0) return "(none)";
  let startIdx = -1;
  // Prefer the LAST "Caused by:" — it's usually the actionable root.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Caused by:/i.test(lines[i].trimStart())) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) startIdx = Math.max(0, lines.length - MAX_PROMPT_CONTEXT_LINES);
  const slice = lines.slice(startIdx, startIdx + MAX_PROMPT_CONTEXT_LINES);
  let out = slice.join("\n");
  if (out.length > MAX_PROMPT_CONTEXT_BYTES) out = out.slice(0, MAX_PROMPT_CONTEXT_BYTES) + "\n…";
  return out;
}

export function buildFixPrompt(
  repoUrl: string,
  branch: string,
  errorMessage: string,
  contextLines: string[]
): string {
  const ctx = trimContextForPrompt(contextLines);
  return [
    "AUTOMATED TASK — you are running headless inside Kaiad. There is no human in the loop. NEVER ask questions, NEVER request clarification, NEVER wait for confirmation. If anything is ambiguous, make the best-effort decision and proceed.",
    "",
    "A running service has emitted the error below. You are inside a fresh clone of that service's repository at the working directory; edit files directly to fix the bug, then exit.",
    "",
    `REPOSITORY: ${repoUrl} (branch ${branch})`,
    "",
    "ERROR:",
    errorMessage,
    "",
    "LOG CONTEXT (the full captured trace; the deepest \"Caused by:\" is usually the actionable root cause):",
    ctx,
    "",
    "INSTRUCTIONS:",
    "1. Identify the root cause from the error/trace and the surrounding code.",
    "2. Edit ONLY the files needed to fix the bug. Do not refactor or change unrelated code.",
    "3. Do NOT run git commands. Do NOT commit or push. Kaiad commits and pushes after you exit.",
    "4. Do not produce conversational prose; just edit files. If you write to stdout, keep it terse.",
    "5. Do NOT ask questions or request human input — this is automated.",
    "6. If after analysis you genuinely cannot determine a safe fix, exit WITHOUT modifying any files."
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
  // Clone into a subdir so the SSH key file (and anything else under
  // scratch) doesn't make `git clone .` see a non-empty target.
  const repoDir = join(scratch, "repo");
  let keyPath: string | null = null;
  const env: NodeJS.ProcessEnv = { ...process.env };

  const emit = (e: FixProgressEvent) => {
    try {
      p.onProgress?.(e);
    } catch {
      // Progress is best-effort; never let it crash the fix.
    }
  };
  const snippet = (s: string, n = 400) => s.replace(/\s+$/, "").slice(0, n);
  // Format an argv array as a copy-pasteable command line, redacting
  // GIT_SSH_COMMAND noise (the key path is per-run garbage).
  const shellQuote = (s: string) => (/[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);
  const cmdLine = (bin: string, args: string[]) => [bin, ...args].map(shellQuote).join(" ");
  // tracked runs a step's command and emits ONE event with the exact
  // cmd, exit code, and trimmed output (no separate "started" event —
  // the umbrella incident.last_fix_status carries live in-flight state
  // via the status pill, and a duplicate start row with no output just
  // adds noise). step "succeeded"/"failed"/"started"/"no_changes" are
  // status-only; here it's "cloning" / "cli" / "committing" / "pushing".
  const tracked = async (
    step: FixProgressEvent["step"],
    bin: string,
    args: string[],
    opts: Parameters<typeof run>[2]
  ): Promise<{ code: number; stdout: string; stderr: string; output: string }> => {
    const cmd = cmdLine(bin, args);
    const r = await run(bin, args, opts);
    const output = (r.stdout + r.stderr).replace(/\s+$/, "");
    emit({
      step,
      ok: r.code === 0,
      cmd,
      code: r.code,
      // Render "(no output)" when the command genuinely produced none,
      // instead of an empty <details> in the UI.
      output: output.length > 0 ? output.slice(0, OUTPUT_HEAD) : "(no output)",
      message: r.code === 0 ? undefined : snippet(output)
    });
    return { ...r, output };
  };

  try {
    emit({ step: "started", ok: true });
    await mkdir(repoDir, { recursive: true });
    // mkdtemp defaults to mode 0700 (root-owned). When the CLI runs as
    // a non-root uid with cwd=scratch/repo, it can chdir there but
    // CAN'T traverse the 0700 parent → claude silently bails (exit 0,
    // no output). Open the parent's traverse bit; the SSH key stays
    // root-owned 0600 inside so uid 1000 still can't read it.
    if (runningAsRoot) {
      await chmod(scratch, 0o755);
    }
    if (p.sshKeyType === "uploaded" && p.sshKeyValue) {
      keyPath = join(scratch, ".sshkey");
      await writeFile(keyPath, normalizePEM(p.sshKeyValue), { mode: 0o600 });
      await chmod(keyPath, 0o600);
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o BatchMode=yes`;
    } else if (p.sshKeyType === "local_path" && p.sshKeyValue) {
      env.GIT_SSH_COMMAND = `ssh -i ${p.sshKeyValue} -o StrictHostKeyChecking=no -o BatchMode=yes`;
    }

    const clone = await tracked(
      "cloning",
      "git",
      ["clone", "--branch", branch, "--single-branch", p.repoUrl, "."],
      { cwd: repoDir, env, timeoutMs }
    );
    if (clone.code !== 0) {
      const reason = looksLikeAuthFailure(clone.output) ? "auth" : "clone_failed";
      return { ok: false, reason, output: `git clone failed:\n${clone.output}` };
    }

    for (const [k, v] of [
      ["user.email", "kaiad-bot@kaiad.dev"],
      ["user.name", "Kaiad Auto-Fix"]
    ]) {
      await run("git", ["config", k, v], { cwd: repoDir, env, timeoutMs: 15000 });
    }

    const prompt = buildFixPrompt(p.repoUrl, branch, p.errorMessage, p.contextLines);
    // claude: -p non-interactive; bypassPermissions skips the prompt
    // gate. cursor-agent: -p headless, --force skips edit approval.
    const [bin, args] =
      p.executor === "cursor"
        ? ["cursor-agent", ["-p", prompt, "--force"]]
        : ["claude", ["-p", "--permission-mode", "bypassPermissions", prompt]];

    // Drop the CLI to a non-root uid (it refuses to run as root). git
    // stays root, so hand the tree to the CLI uid for the CLI step
    // only and chown it back before each git command.
    const cliEnv: NodeJS.ProcessEnv = { ...env };
    let cliUid: number | undefined;
    let cliGid: number | undefined;
    if (runningAsRoot) {
      // The CLI looks up its config under HOME, but also reads USER /
      // LOGNAME to resolve identity — inheriting "root" from the kaiad
      // process causes it to silently no-op while still exiting 0.
      // Set the full unprivileged identity explicitly.
      cliEnv.HOME = FIX_HOME;
      cliEnv.USER = "node";
      cliEnv.LOGNAME = "node";
      cliEnv.SHELL = "/bin/sh";
      // Drop root-inherited paths the unprivileged uid can't read so
      // tools don't waste time probing them (e.g. /root/...).
      delete cliEnv.XDG_CONFIG_HOME;
      delete cliEnv.XDG_CACHE_HOME;
      delete cliEnv.XDG_DATA_HOME;
      cliUid = FIX_UID;
      cliGid = FIX_GID;
    }
    const cliCmd = cmdLine(bin, args);

    // Retry the CLI a few times: a single shot at the model often
    // bails (claude exits 0 with no diff, or hits a transient error).
    // Resetting between attempts gives it a clean tree each try.
    const retryLimit = Math.max(1, Number(process.env.SM_FIX_RETRY_LIMIT) || 3);
    let cli: { code: number; stdout: string; stderr: string; signaled?: boolean } | null = null;
    let cliOut = "";
    let attempt = 0;
    let succeeded = false;
    for (attempt = 1; attempt <= retryLimit; attempt++) {
      // Before any attempt after the first, reset the worktree so the
      // CLI sees the same clean clone it had originally.
      if (attempt > 1) {
        await run("git", ["reset", "--hard", "HEAD"], { cwd: repoDir, env, timeoutMs: 15000 });
        await run("git", ["clean", "-fdx"], { cwd: repoDir, env, timeoutMs: 15000 });
      }
      if (runningAsRoot) {
        await run("chown", ["-R", `${FIX_UID}:${FIX_GID}`, repoDir], { timeoutMs: 30000 });
      }
      cli = await runCli(bin, args, {
        cwd: repoDir,
        env: cliEnv,
        timeoutMs,
        uid: cliUid,
        gid: cliGid
      });
      if (runningAsRoot) {
        await run("chown", ["-R", "0:0", repoDir], { timeoutMs: 30000 });
      }
      cliOut = cli.stdout + cli.stderr;
      p.logger?.info?.({
        phase: "cli_done",
        attempt,
        retryLimit,
        executor: p.executor,
        code: cli.code,
        cliOutHead: cliOut.slice(0, 2500)
      });
      const cliOutForUi = cliOut.length > 0 ? cliOut.slice(0, OUTPUT_HEAD) : "(no output)";
      // Per-attempt event; subsequent attempts are labelled "retry N/M".
      const attemptLabel = attempt > 1 ? ` (retry ${attempt}/${retryLimit})` : "";
      const failMsg = cli.signaled
        ? `${p.executor} timed out after ${Math.round(timeoutMs / 1000)}s (SIGKILL)${attemptLabel}`
        : `${snippet(cliOut) || `${p.executor} exited ${cli.code}`}${attemptLabel}`;
      emit({
        step: "cli",
        ok: cli.code === 0,
        cmd: cliCmd,
        code: cli.code,
        output: cliOutForUi,
        message:
          cli.code !== 0
            ? failMsg
            : attempt > 1
              ? `attempt ${attempt}/${retryLimit}`
              : undefined
      });
      if (cli.code !== 0) {
        if (attempt < retryLimit) continue;
        return { ok: false, reason: "cli_failed", output: `${p.executor} failed after ${attempt} attempt(s):\n${cliOut}` };
      }
      const status = await run("git", ["status", "--porcelain"], {
        cwd: repoDir,
        env,
        timeoutMs: 15000
      });
      if (status.stdout.trim() !== "") {
        succeeded = true;
        break;
      }
      // exit 0 + no diff: retry if attempts remain.
      if (attempt < retryLimit) continue;
      emit({
        step: "no_changes",
        ok: false,
        message: `${p.executor} produced no diff after ${attempt} attempt(s).`
      });
      return {
        ok: false,
        reason: "no_changes",
        output: `${p.executor} made no changes in ${attempt} attempt(s).\n${cliOut}`
      };
    }
    if (!succeeded) {
      // Defensive — shouldn't reach here because the loop returns on
      // every exhaustion branch above.
      return { ok: false, reason: "cli_failed", output: `${p.executor} retry loop exited unexpectedly` };
    }

    // `git add -A` is bundled into the committing step's surface.
    await tracked("committing", "git", ["add", "-A"], { cwd: repoDir, env, timeoutMs: 30000 });
    const commitMsg = `fix(auto): ${p.errorMessage.split("\n")[0].slice(0, 72)}`;
    const commit = await tracked("committing", "git", ["commit", "-m", commitMsg], {
      cwd: repoDir,
      env,
      timeoutMs: 30000
    });
    if (commit.code !== 0) {
      return { ok: false, reason: "error", output: `git commit failed:\n${commit.output}` };
    }

    const push = await tracked("pushing", "git", ["push", "origin", branch], {
      cwd: repoDir,
      env,
      timeoutMs
    });
    if (push.code !== 0) {
      return {
        ok: false,
        reason: looksLikeAuthFailure(push.output) ? "auth" : "push_failed",
        output: `git push failed:\n${push.output}`
      };
    }

    const rev = await run("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      env,
      timeoutMs: 15000
    });
    const commitSha = rev.stdout.trim();
    emit({ step: "pushing", ok: true, message: commitSha.slice(0, 12) });
    emit({ step: "succeeded", ok: true, message: `pushed ${commitSha.slice(0, 12)} to ${branch}` });
    p.logger?.info?.({ event: "kaiad_fix.pushed", commitSha, branch });
    return { ok: true, commitSha, output: `pushed ${commitSha} to ${branch}\n${cliOut}` };
  } catch (err) {
    return { ok: false, reason: "error", output: `kaiad fix error: ${(err as Error).message}` };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
