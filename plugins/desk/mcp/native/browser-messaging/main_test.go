package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	script := filepath.Join(t.TempDir(), "host.cjs")
	if err := os.WriteFile(script, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	return config{Runtime: node, HostModule: script, ExtensionOrigin: allowedOrigin}
}

func TestExactOriginForwardsBytesAndOnlyOrigin(t *testing.T) {
	c := fixture(t, `if (process.argv.length !== 3 || process.argv[2] !== "`+allowedOrigin+`") process.exit(9);
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
	dir := t.TempDir()
	marker := filepath.Join(dir, "started")
	quoted, _ := json.Marshal(marker)
	c := fixture(t, `require("fs").writeFileSync(`+string(quoted)+`, "wrong");`)
	for _, args := range [][]string{nil, {"chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"}, {allowedOrigin, "--extra"}} {
		var out, diagnostic bytes.Buffer
		if code := run(c, args, bytes.NewReader(nil), &out, &diagnostic); code != 2 {
			t.Fatalf("expected refusal, got %d", code)
		}
		if out.Len() != 0 {
			t.Fatal("diagnostic leaked onto framed stdout")
		}
		if diagnostic.Len() == 0 {
			t.Fatal("refusal missing stderr diagnostic")
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("refused child ran")
	}
}

func TestChildExitAndDiagnosticStayDistinct(t *testing.T) {
	c := fixture(t, `process.stderr.write("child-diagnostic"); process.exit(7);`)
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
	file := filepath.Join(dir, "native-host.json")
	data, _ := json.Marshal(c)
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	makePrivate(t, file)
	value, err := readConfig(file)
	if err != nil || value != c {
		info, _ := os.Stat(file)
		parent, _ := os.Stat(dir)
		t.Fatalf("private configuration refused: %v (file mode %v, parent mode %v)", err, info.Mode(), parent.Mode())
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(file, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := readConfig(file); err == nil {
			t.Fatal("world-readable native configuration accepted")
		}
	}
	if err := os.WriteFile(file, bytes.Repeat([]byte("x"), 16385), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readConfig(file); err == nil {
		t.Fatal("oversized config accepted")
	}
}

func TestWindowsParentArgumentNeverReachesChild(t *testing.T) {
	c := fixture(t, `if(process.argv.length !== 3) process.exit(8);`)
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
	c := fixture(t, `if (process.env.NODE_OPTIONS || process.env.NODE_PATH) process.exit(8);`)
	t.Setenv("NODE_OPTIONS", "--trace-warnings")
	t.Setenv("NODE_PATH", "/untrusted")
	var out, diagnostic bytes.Buffer
	if code := run(c, []string{allowedOrigin}, bytes.NewReader(nil), &out, &diagnostic); code != 0 {
		t.Fatalf("runtime inherited injection variables: %d", code)
	}
}

func TestConfigInPublicDirectoryIsRefused(t *testing.T) {
	c := fixture(t, "")
	dir := t.TempDir()
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
