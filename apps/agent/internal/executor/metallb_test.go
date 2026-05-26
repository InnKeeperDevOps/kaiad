package executor

import (
	"testing"
)

func TestExpandRangeCIDRv4(t *testing.T) {
	v4, v6, err := expandRange("192.168.1.0/29", 1024)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(v6) != 0 {
		t.Fatalf("expected no v6, got %d", len(v6))
	}
	// /29 = 8 addresses; skipBoundaries strips .0 and .7 → 6 hosts.
	want := []string{"192.168.1.1", "192.168.1.2", "192.168.1.3", "192.168.1.4", "192.168.1.5", "192.168.1.6"}
	if len(v4) != len(want) {
		t.Fatalf("len mismatch: got %d want %d (%v)", len(v4), len(want), v4)
	}
	for i, a := range v4 {
		if a.String() != want[i] {
			t.Fatalf("v4[%d]=%s want %s", i, a.String(), want[i])
		}
	}
}

func TestExpandRangeSlash32KeepsAddr(t *testing.T) {
	v4, _, err := expandRange("10.0.0.7/32", 1024)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(v4) != 1 || v4[0].String() != "10.0.0.7" {
		t.Fatalf("unexpected: %v", v4)
	}
}

func TestExpandRangeHyphenated(t *testing.T) {
	v4, _, err := expandRange("192.168.1.230-192.168.1.233", 1024)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	got := []string{}
	for _, a := range v4 {
		got = append(got, a.String())
	}
	want := []string{"192.168.1.230", "192.168.1.231", "192.168.1.232", "192.168.1.233"}
	if len(got) != len(want) {
		t.Fatalf("len mismatch: got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got[%d]=%s want %s", i, got[i], want[i])
		}
	}
}

func TestExpandRangeHyphenatedShortForm(t *testing.T) {
	v4, _, err := expandRange("192.168.1.230-233", 1024)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(v4) != 4 || v4[0].String() != "192.168.1.230" || v4[3].String() != "192.168.1.233" {
		t.Fatalf("unexpected: %v", v4)
	}
}

func TestExpandRangeLimit(t *testing.T) {
	v4, _, err := expandRange("10.0.0.0/16", 5)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(v4) != 5 {
		t.Fatalf("expected 5, got %d", len(v4))
	}
}

func TestExpandRangeSingleLiteral(t *testing.T) {
	v4, _, err := expandRange("172.20.0.5", 1024)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(v4) != 1 || v4[0].String() != "172.20.0.5" {
		t.Fatalf("unexpected: %v", v4)
	}
}
