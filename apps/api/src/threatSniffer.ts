// Log sniffer: classifies a service log line into zero or more
// attack-style detections (port scans, web vuln probes, brute force,
// path traversal, log4shell / shellshock, etc.) and extracts the
// likely source IP for each.
//
// Design notes:
//   - Runs in-process on the kaiad API server inside the agent's
//     `log_event` handler, fire-and-forget. The handler still acks
//     before persistence completes so a slow DB doesn't slow agents.
//   - Pure functions for the matching pass; persistence lives next to
//     it (writeDetections) so server.ts only needs `scanLogLine` +
//     `persistDetections`.
//   - The pattern catalogue trades some false positives for low miss
//     rate — operators see the source IP & message, so noise is cheap
//     to triage. We do skip detections we can't attribute to an IP
//     because an unattributable threat list isn't actionable.
//   - Severity is monotonic per-IP via the upsert query (MAX of
//     incoming vs stored), so an IP that ever did something
//     `critical` stays `critical` regardless of later mild noise.

import type { QueryFn } from "@sm/db";
import { insertThreatEvent, upsertThreatIp } from "@sm/db";

// ─── Severity ──────────────────────────────────────────────────────────

export type ThreatSeverity = "low" | "medium" | "high" | "critical";
export const SEVERITY_RANK: Record<ThreatSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

// ─── IP extraction ─────────────────────────────────────────────────────

// IPv4 dotted-quad with each octet 0-255. Anchored on word boundaries
// in the larger pattern below; rejecting 1.2.3.4567 etc. matters
// because log lines often inline tokens that look like IPs.
const IPV4_RE = /\b((?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d))\b/g;

// Conservative IPv6 — full + collapsed forms. We skip IPv6 zone IDs
// (no `%eth0` capture) since they're orthogonal to identity.
const IPV6_RE = /\b((?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|:(?::[0-9a-f]{1,4}){1,7}|::)\b/gi;

// Loopback and the unspecified addresses aren't worth recording —
// they tell us nothing about an external actor and would clog the
// list with our own traffic. Link-local v6 (fe80::/10) we keep
// because lateral-movement signals are useful.
const NOISE_IPS = new Set(["127.0.0.1", "0.0.0.0", "::", "::1"]);

/** Return the first plausible client IP found in `line`, or null. */
export function extractClientIp(line: string): string | null {
  // Common log shape: `client=1.2.3.4` / `from 1.2.3.4` / `[1.2.3.4]`
  // are already covered by the bare regex below — we don't need named
  // groups, just the first hit that isn't noise. We prefer the FIRST
  // occurrence because nginx-style logs put the client IP up front.
  IPV4_RE.lastIndex = 0;
  let m = IPV4_RE.exec(line);
  while (m) {
    if (!NOISE_IPS.has(m[1])) return m[1];
    m = IPV4_RE.exec(line);
  }
  IPV6_RE.lastIndex = 0;
  m = IPV6_RE.exec(line);
  while (m) {
    const ip = m[1].toLowerCase();
    if (!NOISE_IPS.has(ip)) return ip;
    m = IPV6_RE.exec(line);
  }
  return null;
}

// ─── Detection rules ───────────────────────────────────────────────────

export type ThreatDetection = {
  attackType: string;
  severity: ThreatSeverity;
  /** Short human label for the threat list. */
  reason: string;
};

type Rule = {
  attackType: string;
  severity: ThreatSeverity;
  reason: string;
  /** First-pass cheap test — string `includes` to avoid running the regex when impossible. */
  hint?: (lower: string) => boolean;
  pattern: RegExp;
};

// Most rules anchor on lowercase content; we lowercase the line once
// per scan and pass it to `hint`. The regexes themselves are
// case-insensitive where it matters.
const RULES: Rule[] = [
  // ── Log4Shell / JNDI injection ────────────────────────────────────
  {
    attackType: "log4shell",
    severity: "critical",
    reason: "Log4Shell / JNDI lookup attempt",
    hint: (l) => l.includes("${jndi:") || l.includes("${lower:j"),
    pattern: /\$\{(?:[a-z]+:)*j(?:ndi|ndi[^}]*)[:][^}]*\}/i
  },
  // ── Shellshock ────────────────────────────────────────────────────
  {
    attackType: "shellshock",
    severity: "critical",
    reason: "Shellshock CVE-2014-6271 probe",
    hint: (l) => l.includes("() {"),
    pattern: /\(\)\s*\{\s*:?\s*;\s*}\s*;/i
  },
  // ── Path traversal ────────────────────────────────────────────────
  {
    attackType: "path_traversal",
    severity: "high",
    reason: "Directory traversal sequence",
    hint: (l) => l.includes("..") && (l.includes("/") || l.includes("%2f") || l.includes("\\")),
    pattern: /(?:\.\.\/|\.\.\\|\.\.%2f|\.\.%5c){2,}|\/etc\/passwd|\/proc\/self\/environ|\/windows\/win\.ini/i
  },
  // ── SQL injection ─────────────────────────────────────────────────
  {
    attackType: "sql_injection",
    severity: "high",
    reason: "SQL injection probe",
    hint: (l) =>
      l.includes("union") ||
      l.includes("' or ") ||
      l.includes("or 1=1") ||
      l.includes("sleep(") ||
      l.includes("benchmark("),
    pattern:
      /\b(?:union\s+(?:all\s+)?select|or\s+1\s*=\s*1|and\s+1\s*=\s*1|sleep\s*\(\s*\d+\s*\)|benchmark\s*\(\s*\d+|select\s+.*\s+from\s+information_schema|;\s*drop\s+table)/i
  },
  // ── Command injection ─────────────────────────────────────────────
  {
    attackType: "command_injection",
    severity: "high",
    reason: "Shell command injection probe",
    hint: (l) =>
      l.includes("$(") ||
      l.includes("`") ||
      l.includes("|sh") ||
      l.includes("; bash") ||
      l.includes("; wget") ||
      l.includes("; curl") ||
      l.includes("; nc "),
    pattern:
      /(?:\$\([^)]{1,40}\)|`[^`]{1,40}`|;\s*(?:bash|sh|wget|curl|nc|busybox|chmod\s+\+x)\b|\|\s*(?:sh|bash)\b)/i
  },
  // ── XSS probes ────────────────────────────────────────────────────
  {
    attackType: "xss",
    severity: "low",
    reason: "Cross-site scripting probe",
    hint: (l) => l.includes("<script") || l.includes("onerror=") || l.includes("javascript:"),
    pattern: /<script[\s>]|onerror\s*=|javascript:\s*[a-z(]/i
  },
  // ── Common exploit / scanner paths ────────────────────────────────
  {
    attackType: "exploit_path",
    severity: "medium",
    reason: "Probe for sensitive / dev-only path",
    hint: (l) =>
      l.includes("/.env") ||
      l.includes("/.git") ||
      l.includes("/wp-") ||
      l.includes("/phpmyadmin") ||
      l.includes("/xmlrpc.php") ||
      l.includes("/.aws/") ||
      l.includes("/.ssh/") ||
      l.includes("/cgi-bin/"),
    pattern:
      /\/(?:\.env|\.git\/(?:config|head)|wp-(?:admin|login|content\/plugins)|wp-config\.php|phpmyadmin|xmlrpc\.php|administrator\/index\.php|cgi-bin\/[^\s]+|\.aws\/credentials|\.ssh\/id_rsa)/i
  },
  // ── Scanner / vuln tool user-agents ───────────────────────────────
  {
    attackType: "scanner_useragent",
    severity: "medium",
    reason: "Vulnerability scanner user-agent",
    hint: (l) =>
      l.includes("nikto") ||
      l.includes("sqlmap") ||
      l.includes("nmap") ||
      l.includes("masscan") ||
      l.includes("nuclei") ||
      l.includes("gobuster") ||
      l.includes("dirbuster") ||
      l.includes("wpscan") ||
      l.includes("zgrab") ||
      l.includes("acunetix"),
    pattern: /\b(?:nikto|sqlmap|nmap|masscan|zgrab|gobuster|dirbuster|nuclei|wpscan|acunetix)\b/i
  },
  // ── Brute-force / auth abuse ──────────────────────────────────────
  // The catch is that auth failures are also legitimate operator
  // typos. We flag at `low` here; the per-IP upsert bumps repeat
  // offenders to `medium` after multiple events (see THRESHOLDS in
  // upsertThreatIp).
  {
    attackType: "auth_failure",
    severity: "low",
    reason: "Authentication failure",
    hint: (l) =>
      l.includes("authentication failed") ||
      l.includes("invalid credentials") ||
      l.includes("login failed") ||
      l.includes("failed password") ||
      l.includes("403 forbidden") ||
      l.includes(" 401 "),
    pattern:
      /(?:authentication\s+failed|invalid\s+credentials|login\s+failed|failed\s+password|\b401\b\s+[a-z]|\b403\b\s+forbidden|too\s+many\s+(?:login\s+)?attempts)/i
  },
  // ── Crawler/bot abuse (low severity by itself) ────────────────────
  // Used mainly so a noisy curl/Go script shows up in the list with
  // some context rather than being silently dropped — upserts to the
  // same IP keep aggregating.
  {
    attackType: "bot_traffic",
    severity: "low",
    reason: "Automated client / scripted requests",
    hint: (l) =>
      l.includes("python-requests/") ||
      l.includes("go-http-client/") ||
      l.includes("curl/") ||
      l.includes("libwww-perl"),
    pattern: /(?:python-requests\/|go-http-client\/|curl\/[0-9]|libwww-perl\/|wget\/[0-9])/i
  }
];

/**
 * Scan one log line. Returns an empty array on no match, or one
 * detection per rule that fired. Multiple rules can fire on the same
 * line (e.g. a scanner UA + SQLi probe in the same request log).
 */
export function scanLogLine(message: string): ThreatDetection[] {
  if (!message) return [];
  const lower = message.toLowerCase();
  const out: ThreatDetection[] = [];
  for (const rule of RULES) {
    if (rule.hint && !rule.hint(lower)) continue;
    if (rule.pattern.test(message)) {
      out.push({ attackType: rule.attackType, severity: rule.severity, reason: rule.reason });
    }
  }
  return out;
}

// ─── Persistence ───────────────────────────────────────────────────────

export type ScanContext = {
  tenantId: string;
  agentId: string;
  serviceId: string;
  level: string;
  ts: string;
};

/**
 * Run the scan + persist detections. Intended to be called as
 * `void scanAndPersistThreats(...)` so the log_event ack isn't held
 * back by DB latency. Any throw is swallowed — sniffer failures must
 * never break log ingestion.
 */
export async function scanAndPersistThreats(
  query: QueryFn,
  ctx: ScanContext,
  message: string,
  logger?: { warn?: (data: Record<string, unknown>, msg: string) => void }
): Promise<void> {
  const detections = scanLogLine(message);
  if (detections.length === 0) return;
  const sourceIp = extractClientIp(message);
  // No IP → no actionable entry. We still surface scanner UA / etc.
  // for IPs we DO have, but a SQLi probe in an internal job log
  // without an attributable source isn't useful in the IP list.
  if (!sourceIp) return;
  // De-dupe identical attack types in this single line — a regex may
  // match multiple times but we only want one event row per line.
  const uniqByType = new Map<string, ThreatDetection>();
  for (const d of detections) uniqByType.set(d.attackType, d);
  try {
    // Choose the highest-severity detection as the IP's incoming
    // severity; we still write one event row per attack type so the
    // drill-down view can show every category that fired.
    let topSeverity: ThreatSeverity = "low";
    for (const d of uniqByType.values()) {
      if (SEVERITY_RANK[d.severity] > SEVERITY_RANK[topSeverity]) topSeverity = d.severity;
    }
    for (const d of uniqByType.values()) {
      await insertThreatEvent(query, {
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        serviceId: ctx.serviceId,
        sourceIp,
        attackType: d.attackType,
        severity: d.severity,
        reason: d.reason,
        message: truncate(message, 4096),
        ts: ctx.ts
      });
    }
    await upsertThreatIp(query, {
      tenantId: ctx.tenantId,
      ipAddress: sourceIp,
      severity: topSeverity,
      ts: ctx.ts
    });
  } catch (err) {
    logger?.warn?.(
      { err: (err as Error).message, sourceIp, attackTypes: [...uniqByType.keys()] },
      "threat sniffer persistence failed"
    );
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + " …[truncated]";
}
