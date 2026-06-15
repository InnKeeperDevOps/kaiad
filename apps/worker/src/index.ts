import { fingerprintError } from "@sm/domain";
import { queueNameFor } from "@sm/queue";

export function mapErrorToIncident(input: { message: string; stack?: string[]; tenantId: string; serviceId: string }) {
  return {
    tenantId: input.tenantId,
    serviceId: input.serviceId,
    fingerprint: fingerprintError(input.message, input.stack),
    message: input.message
  };
}

export type LogDedupState = {
  lastSeenByFingerprint: Map<string, number>;
};

export type LogEventLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type ProcessLogEventForIncidentResult =
  | {
      kind: "incident";
      incident: { tenantId: string; serviceId: string; fingerprint: string; message: string };
      nextState: LogDedupState;
    }
  | { kind: "suppressed"; reason: "cooldown"; fingerprint: string; nextState: LogDedupState }
  | { kind: "ignored"; reason: "non_error_level"; nextState: LogDedupState };

function cloneDedupState(state: LogDedupState): LogDedupState {
  return { lastSeenByFingerprint: new Map(state.lastSeenByFingerprint) };
}

export function processLogEventForIncident(
  input: {
    tenantId: string;
    logEvent: {
      level: LogEventLevel;
      message: string;
      serviceId: string;
      agentId: string;
      ts: string;
    };
    cooldownMs: number;
  },
  state: LogDedupState
): ProcessLogEventForIncidentResult {
  const nextState = cloneDedupState(state);
  if (input.logEvent.level !== "error") {
    return { kind: "ignored", reason: "non_error_level", nextState };
  }
  const fingerprint = fingerprintError(input.logEvent.message);
  const eventTimeMs = Date.parse(input.logEvent.ts);
  const lastSeenMs = state.lastSeenByFingerprint.get(fingerprint);
  if (lastSeenMs !== undefined && eventTimeMs - lastSeenMs < input.cooldownMs) {
    return { kind: "suppressed", reason: "cooldown", fingerprint, nextState };
  }
  nextState.lastSeenByFingerprint.set(fingerprint, eventTimeMs);
  return {
    kind: "incident",
    incident: {
      tenantId: input.tenantId,
      serviceId: input.logEvent.serviceId,
      fingerprint,
      message: input.logEvent.message
    },
    nextState
  };
}

export function queueCatalog() {
  return {
    agentCommands: queueNameFor("agentCommands")
  };
}
