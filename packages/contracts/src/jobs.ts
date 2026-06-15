import { z } from "zod";

export const agentCommandJobSchema = z.object({
  agentId: z.string(),
  commandId: z.string(),
  payload: z.record(z.unknown())
});

export const agentCommandDispatchResponseSchema = z.object({
  accepted: z.literal(true),
  commandId: z.string(),
  queued: z.boolean(),
  delivered: z.boolean()
});

export type AgentCommandJob = z.infer<typeof agentCommandJobSchema>;
export type AgentCommandDispatchResponse = z.infer<typeof agentCommandDispatchResponseSchema>;

export const logIngestionJobSchema = z.object({
  tenantId: z.string(),
  agentId: z.string(),
  serviceId: z.string(),
  level: z.enum(["debug", "info", "warn", "error", "fatal"]),
  message: z.string(),
  ts: z.string(),
  correlationId: z.string().optional()
});

export type LogIngestionJob = z.infer<typeof logIngestionJobSchema>;
