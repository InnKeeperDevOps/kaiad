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

func TestK8sSamplerSkipsNonK8sBackend(t *testing.T) {
	s := NewK8sSampler(func() string { return "docker" })
	frames, err := s.Build("agent-1")
	if err != nil || frames != nil {
		t.Fatalf("expected no frames for docker backend, got %v %v", frames, err)
	}
}
