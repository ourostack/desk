// Native entry contract tests adapted from ourostack/desk at
// 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f. Only owned host fixtures run.
package main

import (
	"bytes"
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
	// The selected fixture records its exact generation before test work. The
	// synchronous native-entry Run reaps this exact child before returning.
	helper, err := filepath.Abs("../../src/readiness/process-start.js")
	if err != nil {
		t.Fatal(err)
	}
	qh, _ := json.Marshal(filepath.ToSlash(helper))
	wrapper := `(async()=>{
const {pathToFileURL}=require("node:url");
const {readProcessStart}=await import(pathToFileURL(` + string(qh) + `));
const start=await readProcessStart(process.pid);
if(!start) throw Error("fixture start identity unavailable");
require("node:fs").writeFileSync(` + string(q) + `, JSON.stringify({pid:process.pid,start}), {mode:0o600});
` + source + `
})().catch(()=>process.exitCode=90);`
	if err := os.WriteFile(script, []byte(wrapper), 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		data, err := os.ReadFile(identity)
		if os.IsNotExist(err) {
			t.Log("fixture never started (refused before dispatch)")
			return
		}
		var observed struct {
			PID   int    `json:"pid"`
			Start string `json:"start"`
		}
		if err != nil || json.Unmarshal(data, &observed) != nil || observed.PID <= 0 || observed.Start == "" {
			t.Error("fixture generation evidence unavailable")
			return
		}
		t.Logf("fixture pid=%d start=%s; exact synchronous child wait completed", observed.PID, observed.Start)
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
	if runtime.GOOS == "windows" {
		t.Skip("owned generation fixture needs SystemRoot for the Windows start reader")
	}
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
