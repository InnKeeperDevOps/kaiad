import crypto from "node:crypto";
import type { ErrorGroup, MonitoredService, SshKey } from "@sm/contracts";
import type { DomainStore } from "./domainStore.js";
import type { ErrorGroupStore } from "./errorGrouping.js";

export type DispatchOutcome =
  | { kind: "dispatched"; commandId: string; agentId: string }
  | { kind: "skipped_missing_auth" }
  | { kind: "skipped_no_agent" }
  | { kind: "skipped_no_online_agent" }
  | { kind: "skipped_paused" }
  | { kind: "skipped_in_flight" }
  | { kind: "skipped_no_repo" };

/** Everything the in-kaiad fix runner needs. The dispatcher fires this
 *  and returns immediately — the fix (clone → AI CLI → commit → push)
 *  runs in the background inside the kaiad container, NOT on the agent. */
export interface KaiadFixStart {
  commandId: string;
  tenantId: string;
  service: MonitoredService;
  group: ErrorGroup;
  sshKeyType: SshKey["type"];
  sshKeyValue: string | null;
  executor: "claude" | "cursor";
  contextLines: string[];
  /** "auto" = log-error → autoFixDispatcher path; "manual" = operator
   *  clicked Run-fix in the panel. Surfaced on the in-flight list so
   *  the UI can label and the cancel route can decide what to do next. */
  triggeredBy?: "auto" | "manual";
}

export interface AutoFixDispatcherDeps {
  domainStore: DomainStore;
  errorGroups: ErrorGroupStore;
  /** Reads the raw private key for an SSH key id. For `local_path`
   *  keys returns the path in `localPath` instead of `privateKey`. */
  readSshKeyMaterial: (tenantId: string, sshKeyId: string) => Promise<{
    type: SshKey["type"];
    privateKey: string | null;
    localPath: string | null;
  } | null>;
  /** Start the fix inside kaiad. Fire-and-forget — the dispatcher does
   *  NOT await it; the runner reports completion via its own lifecycle
   *  (group status + incident + in-flight lock release). */
  startFix: (args: KaiadFixStart) => void;
}

/**
 * Gate + kick off an in-kaiad autonomous fix for an error group.
 * Returns a tagged outcome so the caller can broadcast UI status. The
 * actual clone/CLI/commit/push happens in the kaiad container via
 * `deps.startFix` — there is no agent round-trip.
 */
export async function dispatchAutoFix(
  deps: AutoFixDispatcherDeps,
  group: ErrorGroup,
  service: MonitoredService | undefined
): Promise<DispatchOutcome> {
  if (group.status === "paused") {
    return { kind: "skipped_paused" };
  }
  if (group.status === "fixing") {
    return { kind: "skipped_in_flight" };
  }
  if (!service) {
    return { kind: "skipped_no_agent" };
  }
  if (!service.gitRepoUrl) {
    return { kind: "skipped_no_repo" };
  }
  if (!service.sshKeyId) {
    deps.errorGroups.setStatus(group.id, "missing_auth");
    return { kind: "skipped_missing_auth" };
  }

  const keyMaterial = await deps.readSshKeyMaterial(service.tenantId, service.sshKeyId);
  if (!keyMaterial) {
    deps.errorGroups.setStatus(group.id, "missing_auth");
    return { kind: "skipped_missing_auth" };
  }

  const commandId = `cmd-${crypto.randomUUID()}`;
  const contextLines = deps.errorGroups.contextLinesFor(group.id);

  deps.errorGroups.setStatus(group.id, "fixing");
  deps.startFix({
    commandId,
    tenantId: service.tenantId,
    service,
    group,
    sshKeyType: keyMaterial.type,
    sshKeyValue: keyMaterial.privateKey ?? keyMaterial.localPath ?? null,
    executor: (service.fixExecutor as "claude" | "cursor") ?? "claude",
    contextLines
  });
  return { kind: "dispatched", commandId, agentId: "" };
}
