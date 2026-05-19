package executor

import "testing"

func TestNormalizePEM(t *testing.T) {
	const body = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----"

	cases := map[string]string{
		"crlf":             "-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXk\r\n-----END OPENSSH PRIVATE KEY-----\r\n",
		"no trailing lf":   body,
		"bare cr":          "-----BEGIN OPENSSH PRIVATE KEY-----\rb3BlbnNzaC1rZXk\r-----END OPENSSH PRIVATE KEY-----",
		"many trailing lf": body + "\n\n\n",
		"already clean":    body + "\n",
	}
	want := body + "\n"
	for name, in := range cases {
		if got := normalizePEM(in); got != want {
			t.Fatalf("%s: normalizePEM mismatch\n got %q\nwant %q", name, got, want)
		}
	}
}
