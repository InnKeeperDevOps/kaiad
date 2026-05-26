package executor

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"os/exec"
	"sort"
	"strings"
)

// metalLBPoolReply is the JSON shape the agent serializes into
// command_ack.output for the `list_metallb_pool_ips` command. Mirrors
// listMetalLBPoolIPsResponseSchema in @sm/contracts.
type metalLBPoolReply struct {
	Pool      string                 `json:"pool"`
	Available []string               `json:"available"`
	Taken     []metalLBTakenEntry    `json:"taken"`
	Ranges    []string               `json:"ranges"`
}

type metalLBTakenEntry struct {
	IP        string `json:"ip"`
	Service   string `json:"service,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

// Hard cap on returned IPs so a /16 doesn't dump 64k entries onto the
// websocket. The UI shows a finite picker; if the operator needs a
// larger window we'll page later.
const metalLBPoolIPsMax = 1024

func (e *Executor) executeListMetalLBPoolIPs(ctx context.Context, payload map[string]interface{}) CommandResult {
	pool, _ := payload["pool"].(string)
	pool = strings.TrimSpace(pool)
	if pool == "" {
		return CommandResult{Success: false, Output: "missing pool"}
	}

	ranges, err := readIPAddressPoolRanges(ctx, pool)
	if err != nil {
		return CommandResult{Success: false, Output: err.Error()}
	}
	if len(ranges) == 0 {
		// Pool exists but declares no addresses, or doesn't exist. Either
		// way the picker has nothing to show — report empty and let the
		// UI render an empty state rather than failing loudly.
		body, _ := json.Marshal(metalLBPoolReply{Pool: pool, Available: []string{}, Taken: []metalLBTakenEntry{}, Ranges: []string{}})
		return CommandResult{Success: true, Output: string(body)}
	}

	taken, err := readLoadBalancerServiceIPs(ctx)
	if err != nil {
		return CommandResult{Success: false, Output: err.Error()}
	}

	pool4, pool6 := []netip.Addr{}, []netip.Addr{}
	for _, r := range ranges {
		v4, v6, err := expandRange(r, metalLBPoolIPsMax-len(pool4)-len(pool6))
		if err != nil {
			return CommandResult{Success: false, Output: fmt.Sprintf("pool %q: %v", pool, err)}
		}
		pool4 = append(pool4, v4...)
		pool6 = append(pool6, v6...)
		if len(pool4)+len(pool6) >= metalLBPoolIPsMax {
			break
		}
	}

	takenSet := map[string]metalLBTakenEntry{}
	for _, t := range taken {
		takenSet[t.IP] = t
	}

	availableOut := make([]string, 0)
	takenOut := make([]metalLBTakenEntry, 0)
	for _, list := range [][]netip.Addr{pool4, pool6} {
		for _, a := range list {
			s := a.String()
			if t, ok := takenSet[s]; ok {
				t.IP = s
				takenOut = append(takenOut, t)
			} else {
				availableOut = append(availableOut, s)
			}
		}
	}

	body, err := json.Marshal(metalLBPoolReply{
		Pool:      pool,
		Available: availableOut,
		Taken:     takenOut,
		Ranges:    ranges,
	})
	if err != nil {
		return CommandResult{Success: false, Output: fmt.Sprintf("marshal: %v", err)}
	}
	return CommandResult{Success: true, Output: string(body)}
}

// readIPAddressPoolRanges queries metallb.io/v1beta1 IPAddressPool
// resources across all namespaces (MetalLB historically installed into
// metallb-system, but cluster operators can put it anywhere) and
// returns the matching pool's spec.addresses.
func readIPAddressPoolRanges(ctx context.Context, pool string) ([]string, error) {
	cmd := exec.CommandContext(ctx, "kubectl", "get", "ipaddresspools.metallb.io", "-A", "-o", "json")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("kubectl get ipaddresspools: %v: %s", err, strings.TrimSpace(string(out)))
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Addresses []string `json:"addresses"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, fmt.Errorf("parse ipaddresspools: %v", err)
	}
	for _, item := range list.Items {
		if item.Metadata.Name == pool {
			return item.Spec.Addresses, nil
		}
	}
	return nil, nil
}

// readLoadBalancerServiceIPs returns the (ip, service, namespace) tuples
// for every LoadBalancer Service that has at least one ingress IP
// assigned. The pool filter is applied later by the caller; assembling
// the full set in one kubectl call beats fanning out per-namespace.
func readLoadBalancerServiceIPs(ctx context.Context) ([]metalLBTakenEntry, error) {
	cmd := exec.CommandContext(ctx, "kubectl", "get", "svc", "-A", "-o", "json")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("kubectl get svc: %v: %s", err, strings.TrimSpace(string(out)))
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name        string            `json:"name"`
				Namespace   string            `json:"namespace"`
				Annotations map[string]string `json:"annotations"`
			} `json:"metadata"`
			Spec struct {
				Type           string   `json:"type"`
				LoadBalancerIP string   `json:"loadBalancerIP"`
			} `json:"spec"`
			Status struct {
				LoadBalancer struct {
					Ingress []struct {
						IP string `json:"ip"`
					} `json:"ingress"`
				} `json:"loadBalancer"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, fmt.Errorf("parse svc list: %v", err)
	}
	out2 := make([]metalLBTakenEntry, 0, len(list.Items))
	for _, item := range list.Items {
		if item.Spec.Type != "LoadBalancer" {
			continue
		}
		seen := map[string]bool{}
		for _, ing := range item.Status.LoadBalancer.Ingress {
			ip := strings.TrimSpace(ing.IP)
			if ip == "" || seen[ip] {
				continue
			}
			seen[ip] = true
			out2 = append(out2, metalLBTakenEntry{
				IP:        ip,
				Service:   item.Metadata.Name,
				Namespace: item.Metadata.Namespace,
			})
		}
		// metallb.universe.tf/loadBalancerIPs annotation is the *desired*
		// pin — it may not have been honored yet (pending). Surface it as
		// taken so a freshly-set pinned IP doesn't appear available to
		// another service until the first one settles.
		if pinned := strings.TrimSpace(item.Metadata.Annotations["metallb.universe.tf/loadBalancerIPs"]); pinned != "" {
			for _, raw := range strings.Split(pinned, ",") {
				ip := strings.TrimSpace(raw)
				if ip == "" || seen[ip] {
					continue
				}
				seen[ip] = true
				out2 = append(out2, metalLBTakenEntry{
					IP:        ip,
					Service:   item.Metadata.Name,
					Namespace: item.Metadata.Namespace,
				})
			}
		}
	}
	return out2, nil
}

// expandRange turns a MetalLB pool address entry into a list of host
// IPs. Accepts either CIDR ("192.168.1.0/24") or hyphenated range
// ("192.168.1.230-192.168.1.250"). `limit` caps how many addresses to
// return from this single range (callers chain across ranges).
func expandRange(entry string, limit int) ([]netip.Addr, []netip.Addr, error) {
	entry = strings.TrimSpace(entry)
	if limit <= 0 {
		return nil, nil, nil
	}
	if strings.Contains(entry, "/") {
		_, ipnet, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, nil, fmt.Errorf("invalid CIDR %q: %v", entry, err)
		}
		startIP, ok := netip.AddrFromSlice(ipnet.IP)
		if !ok {
			return nil, nil, fmt.Errorf("invalid CIDR start %q", entry)
		}
		startIP = startIP.Unmap()
		ones, bits := ipnet.Mask.Size()
		// Skip network + broadcast for IPv4 /n with n<=30; for IPv6 and
		// tiny IPv4 prefixes (/31, /32) we keep every address.
		skipBoundaries := startIP.Is4() && bits-ones >= 2
		var addrs []netip.Addr
		cur := startIP
		count := 0
		for {
			if !ipnet.Contains(cur.AsSlice()) {
				break
			}
			isFirst := cur == startIP
			isBroadcast := false
			if skipBoundaries {
				next := cur.Next()
				if !next.IsValid() || !ipnet.Contains(next.AsSlice()) {
					isBroadcast = true
				}
			}
			if !(skipBoundaries && (isFirst || isBroadcast)) {
				addrs = append(addrs, cur)
				count++
				if count >= limit {
					break
				}
			}
			next := cur.Next()
			if !next.IsValid() {
				break
			}
			cur = next
		}
		v4, v6 := splitByFamily(addrs)
		return v4, v6, nil
	}
	if strings.Contains(entry, "-") {
		parts := strings.SplitN(entry, "-", 2)
		startStr, endStr := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		// MetalLB accepts a short form like "192.168.1.230-250" where the
		// right side is just the last octet. Expand that before parsing.
		if !strings.Contains(endStr, ".") && !strings.Contains(endStr, ":") {
			if dot := strings.LastIndex(startStr, "."); dot > 0 {
				endStr = startStr[:dot+1] + endStr
			}
		}
		start, err := netip.ParseAddr(startStr)
		if err != nil {
			return nil, nil, fmt.Errorf("invalid range start %q: %v", entry, err)
		}
		end, err := netip.ParseAddr(endStr)
		if err != nil {
			return nil, nil, fmt.Errorf("invalid range end %q: %v", entry, err)
		}
		if start.Is4() != end.Is4() {
			return nil, nil, fmt.Errorf("range %q mixes v4 and v6", entry)
		}
		if end.Less(start) {
			return nil, nil, fmt.Errorf("range %q: end before start", entry)
		}
		var addrs []netip.Addr
		cur := start
		count := 0
		for {
			addrs = append(addrs, cur)
			count++
			if count >= limit {
				break
			}
			if cur == end {
				break
			}
			next := cur.Next()
			if !next.IsValid() {
				break
			}
			cur = next
		}
		v4, v6 := splitByFamily(addrs)
		return v4, v6, nil
	}
	// Single literal IP.
	addr, err := netip.ParseAddr(entry)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid address %q: %v", entry, err)
	}
	v4, v6 := splitByFamily([]netip.Addr{addr})
	return v4, v6, nil
}

func splitByFamily(in []netip.Addr) ([]netip.Addr, []netip.Addr) {
	var v4, v6 []netip.Addr
	for _, a := range in {
		if a.Is4() || a.Is4In6() {
			v4 = append(v4, a.Unmap())
		} else {
			v6 = append(v6, a)
		}
	}
	sort.Slice(v4, func(i, j int) bool { return v4[i].Less(v4[j]) })
	sort.Slice(v6, func(i, j int) bool { return v6[i].Less(v6[j]) })
	return v4, v6
}
