package appstats

import "testing"

func TestParseMilliCPU(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"120m", 120, true},
		{"1", 1000, true},
		{"2", 2000, true},
		{"0", 0, true},
		{"", 0, false},
		{"abc", 0, false},
	}
	for _, c := range cases {
		got, ok := parseMilliCPU(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Fatalf("parseMilliCPU(%q) = %d,%v want %d,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestParseMemBytes(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"34Mi", 34 * 1024 * 1024, true},
		{"1Gi", 1024 * 1024 * 1024, true},
		{"512Ki", 512 * 1024, true},
		{"100", 100, true},
		{"2Ti", 2 * 1024 * 1024 * 1024 * 1024, true},
		{"bad", 0, false},
	}
	for _, c := range cases {
		got, ok := parseMemBytes(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Fatalf("parseMemBytes(%q) = %d,%v want %d,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestParseProcNetDev(t *testing.T) {
	sample := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  12345     100    0    0    0     0          0         0    12345     100    0    0    0     0       0          0
  eth0: 154712553  9999    0    0    0     0          0         0   908080    4321    0    0    0     0       0          0
  eth1:   1000       10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0`
	rx, tx, ok := parseProcNetDev([]byte(sample))
	if !ok {
		t.Fatal("expected ok")
	}
	if rx != 154712553+1000 {
		t.Fatalf("rx = %d, want %d", rx, 154712553+1000)
	}
	if tx != 908080+2000 {
		t.Fatalf("tx = %d, want %d", tx, 908080+2000)
	}
	// lo excluded, headers ignored.
	if _, _, ok := parseProcNetDev([]byte("no colon here\njust text")); ok {
		t.Fatal("expected ok=false for non-/proc/net/dev content")
	}
}

func TestK8sSamplerSkipsNonK8sBackend(t *testing.T) {
	s := NewK8sSampler(func() string { return "docker" })
	frames, err := s.Build("agent-1")
	if err != nil || frames != nil {
		t.Fatalf("expected no frames for docker backend, got %v %v", frames, err)
	}
}
