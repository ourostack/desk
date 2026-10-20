// Native entry contract tests adapted from ourostack/desk at
// 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f. Only owned host fixtures run.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const allowedOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"

func fixture(t *testing.T, source string) config {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	node, err = filepath.Abs(node)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	t.Logf("owned native-entry fixture directory: %s", dir)
	script := filepath.Join(dir, "host.cjs")
	identity := filepath.Join(dir, "identity.json")
	q, _ := json.Marshal(identity)
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	expectedNonce := hex.EncodeToString(nonce[:])
	qn, _ := json.Marshal(expectedNonce)
	// Cmd.Run waits on its actual child handle. The receipt observes that
	// child's exit callback; its nonce is correlation, not an OS start identity.
	wrapper := `let phase="write-receipt";function failed(error){
const code=typeof error.code==="string"&&/^[A-Z0-9_]+$/.test(error.code)?error.code:"UNKNOWN";
process.stderr.write("OWNED_NATIVE_FIXTURE_FAILED "+phase+" "+code+"\n");process.exitCode=90;
}(async()=>{
const fs=require("node:fs"),receipt={pid:process.pid,nonce:` + string(qn) + `};
process.once("exit",code=>{
phase="write-exit-receipt";
try{fs.writeFileSync(` + string(q) + `,JSON.stringify({...receipt,exitCode:code}),{mode:0o600});}
catch(error){failed(error);}
});
fs.writeFileSync(` + string(q) + `,JSON.stringify(receipt),{mode:0o600});
phase="exercise";
` + source + `
})().catch(failed);`
	if err := os.WriteFile(script, []byte(wrapper), 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		data, err := os.ReadFile(identity)
		if os.IsNotExist(err) {
			t.Log("fixture receipt absent; run result determines whether dispatch was refused")
			return
		}
		var observed struct {
			PID      int    `json:"pid"`
			Nonce    string `json:"nonce"`
			ExitCode *int   `json:"exitCode"`
		}
		if err != nil || json.Unmarshal(data, &observed) != nil || observed.PID <= 0 ||
			observed.Nonce != expectedNonce || observed.ExitCode == nil {
			t.Error("fixture-correlated exit observation unavailable")
			return
		}
		t.Logf("fixture pid=%d exit callback=%d; synchronous Cmd.Run child wait completed", observed.PID, *observed.ExitCode)
	})
	return config{Runtime: node, HostModule: script, ExtensionOrigin: allowedOrigin}
}

func TestExactOriginForwardsBytesAndOnlyOrigin(t *testing.T) {
	c := fixture(t, `if(process.argv.length!==3||process.argv[2]!=="`+allowedOrigin+`")process.exit(9);
process.stdin.pipe(process.stdout);`)
	input := []byte{0, 1, 255, 3, 0, 13, 10}
	var output, diagnostic bytes.Buffer
	if code := run(c, []string{allowedOrigin}, bytes.NewReader(input), &output, &diagnostic); code != 0 {
		t.Fatalf("exit %d: %s", code, diagnostic.String())
	}
	if !bytes.Equal(input, output.Bytes()) {
		t.Fatalf("native bytes changed: %v", output.Bytes())
	}
}

func TestWrongOriginNeverStartsChild(t *testing.T) {
	c := fixture(t, `process.exit(91);`)
	for _, args := range [][]string{nil, {"chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"}, {allowedOrigin, "--extra"}} {
		var out, diagnostic bytes.Buffer
		if code := run(c, args, bytes.NewReader(nil), &out, &diagnostic); code != 2 {
			t.Fatalf("expected refusal, got %d", code)
		}
		if out.Len() != 0 || diagnostic.String() != "NATIVE_HOST_REFUSED\n" {
			t.Fatal("refusal diagnostic or framed stdout corrupted")
		}
	}
}

func TestChildExitAndDiagnosticStayDistinct(t *testing.T) {
	c := fixture(t, `process.stderr.write("child-diagnostic");process.exit(7);`)
	var out, diagnostic bytes.Buffer
	if code := run(c, []string{allowedOrigin}, bytes.NewReader(nil), &out, &diagnostic); code != 7 {
		t.Fatalf("child status not preserved: %d", code)
	}
	if out.Len() != 0 || diagnostic.String() != "child-diagnostic" {
		t.Fatalf("stdio corrupted: stdout=%q stderr=%q", out.String(), diagnostic.String())
	}
}

func TestFixtureReportsPhaseWithoutRawError(t *testing.T) {
	c := fixture(t, `throw Object.assign(Error("owned-private-diagnostic"),{code:"EOWNED"});`)
	var out, diagnostic bytes.Buffer
	if code := run(c, []string{allowedOrigin}, bytes.NewReader(nil), &out, &diagnostic); code != 90 {
		t.Fatalf("fixture failure status not preserved: %d", code)
	}
	if out.Len() != 0 || diagnostic.String() != "OWNED_NATIVE_FIXTURE_FAILED exercise EOWNED\n" {
		t.Fatalf("unexpected fixture failure: stdout=%q stderr=%q", out.String(), diagnostic.String())
	}
}

func TestInvalidRuntimeRefusesBeforeChild(t *testing.T) {
	c := fixture(t, "")
	for _, mutate := range []func(*config){
		func(c *config) { c.Runtime = "node" },
		func(c *config) { c.HostModule = "host.mjs" },
		func(c *config) { c.Runtime = filepath.Dir(c.Runtime) },
		func(c *config) { c.ExtensionOrigin = "chrome-extension://a/" },
	} {
		invalid := c
		mutate(&invalid)
		var out, diagnostic bytes.Buffer
		if run(invalid, []string{allowedOrigin}, bytes.NewReader(nil), &out, &diagnostic) != 2 || out.Len() != 0 {
			t.Fatal("invalid configuration was accepted")
		}
	}
}

func TestSiblingConfigurationIsBoundedAndPrivate(t *testing.T) {
	c := fixture(t, "")
	dir := t.TempDir()
	t.Logf("owned config directory: %s", dir)
	file := filepath.Join(dir, "native-host.json")
	data, _ := json.Marshal(c)
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	makePrivate(t, file)
	value, err := readConfig(file)
	if err != nil || value != c {
		t.Fatalf("private configuration refused: %v", err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(file, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := readConfig(file); err == nil {
			t.Fatal("world-readable native configuration accepted")
		}
	}
	for _, invalid := range [][]byte{
		bytes.Repeat([]byte("x"), 16385),
		append(append([]byte{}, data...), []byte(` {}`)...),
		[]byte(`{"runtime":"relative","hostModule":"relative","extensionOrigin":"bad"}`),
		append([]byte(`{"unknown":true,`), data[1:]...),
		[]byte(`{`),
	} {
		if err := os.WriteFile(file, invalid, 0600); err != nil {
			t.Fatal(err)
		}
		makePrivate(t, file)
		if _, err := readConfig(file); err == nil {
			t.Fatal("invalid or oversized config accepted")
		}
	}
}

func TestWindowsParentArgumentNeverReachesChild(t *testing.T) {
	c := fixture(t, `if(process.argv.length!==3)process.exit(8);`)
	var out, diagnostic bytes.Buffer
	code := run(c, []string{allowedOrigin, "--parent-window=0"}, bytes.NewReader(nil), &out, &diagnostic)
	if runtime.GOOS == "windows" {
		if code != 0 {
			t.Fatalf("documented Windows parent argument refused: %d", code)
		}
	} else if code != 2 {
		t.Fatal("platform-inappropriate argument accepted")
	}
}

func TestInheritedRuntimeInjectionIsNotForwarded(t *testing.T) {
	c := fixture(t, `if(process.env.NODE_OPTIONS||process.env.NODE_PATH)process.exit(8);`)
	t.Setenv("NODE_OPTIONS", "--trace-warnings")
	t.Setenv("NODE_PATH", "/untrusted")
	var out, diagnostic bytes.Buffer
	if code := run(c, []string{allowedOrigin}, bytes.NewReader(nil), &out, &diagnostic); code != 0 {
		t.Fatalf("runtime inherited injection variables: %d", code)
	}
}

func TestFilteringOnlyInjectionVariablesDoesNotRestoreInheritedEnvironment(t *testing.T) {
	c := fixture(t, `if(process.env.NODE_OPTIONS||process.env.NODE_PATH)process.exit(8);`)
	previous := os.Environ()
	t.Cleanup(func() {
		os.Clearenv()
		for _, item := range previous {
			name, value, _ := strings.Cut(item, "=")
			if err := os.Setenv(name, value); err != nil {
				t.Error(err)
			}
		}
	})
	os.Clearenv()
	t.Setenv("NODE_OPTIONS", "--trace-warnings")
	t.Setenv("NODE_PATH", "/untrusted")
	var out, diagnostic bytes.Buffer
	if code := run(c, []string{allowedOrigin}, bytes.NewReader(nil), &out, &diagnostic); code != 0 {
		t.Fatalf("empty filtered environment inherited injection variables: %d", code)
	}
}

func TestConfigInPublicDirectoryIsRefused(t *testing.T) {
	c := fixture(t, "")
	dir := t.TempDir()
	t.Logf("owned public-directory refusal fixture: %s", dir)
	file := filepath.Join(dir, "native-host.json")
	data, _ := json.Marshal(c)
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	makePrivate(t, file)
	makePublic(t, dir)
	if _, err := readConfig(file); err == nil {
		t.Fatal("private config under public directory accepted")
	}
}
