package main

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if file := os.Getenv("DESK_TEST_BROWSER_RECORD"); file != "" {
		data, err := json.Marshal(os.Args[1:])
		if err == nil {
			err = os.WriteFile(file, data, 0600)
		}
		if err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func launchFixture(t *testing.T) (config, string) {
	t.Helper()
	dir := t.TempDir()
	browser := filepath.Join(dir, "Browser with spaces")
	if err := os.WriteFile(browser, []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	c := config{Browser: browser, Profile: "Profile 4", Owner: "Desk test owner", Receipt: filepath.Join(dir, "receipt.json"), Nonce: strings.Repeat("a", 32)}
	u := &url.URL{Scheme: "chrome-extension", Host: extensionID, Path: "/connect.html"}
	q := url.Values{"mcpRelayUrl": {"ws://127.0.0.1:12345"}, "token": {"secret/+\"token"}, "client": {`{"name":"Desk test owner","version":"test"}`}}
	u.RawQuery = q.Encode()
	return c, u.String()
}

func TestLaunchPreservesURLAndUsesDirectNewWindowArgv(t *testing.T) {
	c, connect := launchFixture(t)
	var gotArgs, gotEnv []string
	code := run(c, []string{"--profile-directory=Profile 4", connect}, []string{"PATH=/bin", "DESK_BROWSER_EXECUTABLE=private", "PLAYWRIGHT_MCP_EXTENSION_TOKEN=secret", "NORMAL=value"}, func(browser string, args, env []string) (int, error) {
		if browser != c.Browser {
			t.Fatal("wrong executable")
		}
		gotArgs, gotEnv = args, env
		return 42, nil
	})
	if code != 0 || !reflect.DeepEqual(gotArgs, []string{"--new-window", "--profile-directory=Profile 4", connect}) {
		t.Fatalf("code %d, argv %v", code, gotArgs)
	}
	if !reflect.DeepEqual(gotEnv, []string{"PATH=/bin", "NORMAL=value"}) {
		t.Fatalf("private launch environment escaped: %v", gotEnv)
	}
	raw, err := os.ReadFile(c.Receipt)
	if err != nil {
		t.Fatal(err)
	}
	var r receipt
	if err := json.Unmarshal(raw, &r); err != nil || r.Status != "spawned" || r.Nonce != c.Nonce || r.PID != 42 {
		t.Fatalf("bad receipt %s, %v", raw, err)
	}
	if strings.Contains(string(raw), "token") || strings.Contains(string(raw), c.Browser) {
		t.Fatal("private launch data escaped into receipt")
	}
}

func TestInvalidLaunchNeverStartsBrowser(t *testing.T) {
	_, connect := launchFixture(t)
	for _, args := range [][]string{
		nil, {connect}, {"--profile-directory=Other", connect},
		{"--profile-directory=Profile 4", "https://example.com/"},
		{"--profile-directory=Profile 4", connect, "--remote-debugging-port=1234"},
		{"--user-data-dir=/tmp", connect},
		{"--profile-directory=Profile 4", strings.Replace(connect, extensionID, "different", 1)},
		{"--profile-directory=Profile 4", strings.Replace(connect, "127.0.0.1", "example.com", 1)},
		{"--profile-directory=Profile 4", strings.Replace(connect, "Desk+test+owner", "Other+owner", 1)},
		{"--profile-directory=Profile 4", connect + "&client=%7B%7D"},
		{"--profile-directory=Profile 4", connect + "&token=second"},
		{"--profile-directory=Profile 4", connect + "&unknown=value"},
		{"--profile-directory=Profile 4", connect + "&protocolVersion=bad"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			c, _ := launchFixture(t)
			called := false
			code := run(c, args, nil, func(string, []string, []string) (int, error) { called = true; return 1, nil })
			if code == 0 || called {
				t.Fatal("invalid arguments launched a browser")
			}
		})
	}
}

func TestPreflightDoesNotOpenWindow(t *testing.T) {
	c, _ := launchFixture(t)
	if run(c, []string{"--check"}, nil, func(string, []string, []string) (int, error) {
		t.Fatal("preflight opened a browser")
		return 0, nil
	}) != 0 {
		t.Fatal("valid preflight failed")
	}
	raw, _ := os.ReadFile(c.Receipt)
	if !strings.Contains(string(raw), `"status":"ready"`) {
		t.Fatal("missing ready receipt")
	}
}

func TestSpawnFailureHasSecretFreeRefusal(t *testing.T) {
	c, connect := launchFixture(t)
	if run(c, []string{"--profile-directory=Profile 4", connect}, nil, func(string, []string, []string) (int, error) {
		return 0, errors.New("secret token and private path")
	}) == 0 {
		t.Fatal("spawn failure succeeded")
	}
	raw, _ := os.ReadFile(c.Receipt)
	if !strings.Contains(string(raw), "browser_spawn_failed") || strings.Contains(string(raw), "secret") {
		t.Fatalf("unsafe refusal: %s", raw)
	}
}

func TestInvalidConfigurationAndReceiptRefuseBeforeSpawn(t *testing.T) {
	c, connect := launchFixture(t)
	for _, change := range []func(*config){
		func(c *config) { c.Browser = "relative" },
		func(c *config) { c.Browser += "-absent" },
		func(c *config) { c.Profile = "../Default" },
		func(c *config) { c.Owner = "" },
		func(c *config) { c.Nonce = "bad" },
		func(c *config) { c.Receipt = "relative" },
		func(c *config) { c.Receipt = filepath.Join(t.TempDir(), "absent", "receipt.json") },
	} {
		changed := c
		change(&changed)
		if run(changed, []string{"--profile-directory=Profile 4", connect}, nil, func(string, []string, []string) (int, error) {
			t.Fatal("invalid configuration started browser")
			return 1, nil
		}) == 0 {
			t.Fatal("invalid configuration accepted")
		}
	}
}

func TestConcurrentInvocationsReserveOnlyOneBrowserLaunch(t *testing.T) {
	c, connect := launchFixture(t)
	var starts atomic.Int32
	begin := make(chan struct{})
	var group sync.WaitGroup
	for range 64 {
		group.Add(1)
		go func() {
			defer group.Done()
			<-begin
			run(c, []string{"--profile-directory=Profile 4", connect}, nil, func(string, []string, []string) (int, error) {
				starts.Add(1)
				time.Sleep(20 * time.Millisecond)
				return 42, nil
			})
		}()
	}
	close(begin)
	group.Wait()
	if starts.Load() != 1 {
		t.Fatalf("one attempt launched %d browsers", starts.Load())
	}
}

func TestStartedProcessWithReleaseErrorRemainsUnknownNotRefused(t *testing.T) {
	c, connect := launchFixture(t)
	if run(c, []string{"--profile-directory=Profile 4", connect}, nil, func(string, []string, []string) (int, error) {
		return 42, errors.New("release failed after start")
	}) == 0 {
		t.Fatal("unverified release reported success")
	}
	raw, _ := os.ReadFile(c.Receipt)
	if !strings.Contains(string(raw), `"status":"starting"`) {
		t.Fatalf("a started browser was mislabeled as an absent/refused launch: %s", raw)
	}
}

func TestPackagedExecutablePreservesNativeUnicodeAndSpaceArguments(t *testing.T) {
	dir := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bytes, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	suffix := ""
	platform := runtime.GOOS
	arch := runtime.GOARCH
	if platform == "windows" {
		platform, suffix = "win32", ".exe"
	}
	if arch == "amd64" {
		arch = "x64"
	} else if arch == "386" {
		arch = "ia32"
	}
	browser := filepath.Join(dir, "Browser space é"+suffix)
	if err := os.WriteFile(browser, bytes, 0700); err != nil {
		t.Fatal(err)
	}
	c, connect := launchFixture(t)
	c.Browser = browser
	c.Profile = "Profile space é"
	output := filepath.Join(dir, "args.json")
	helper := filepath.Join("..", "..", "artifacts", "browser-launch", platform+"-"+arch, "desk-browser-launch"+suffix)
	command := exec.Command(helper, "--profile-directory="+c.Profile, connect)
	command.Env = append(os.Environ(),
		"DESK_BROWSER_EXECUTABLE="+c.Browser, "DESK_BROWSER_PROFILE="+c.Profile,
		"DESK_BROWSER_OWNER="+c.Owner, "DESK_BROWSER_RECEIPT="+c.Receipt,
		"DESK_BROWSER_NONCE="+c.Nonce, "DESK_TEST_BROWSER_RECORD="+output)
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("native helper failed: %v %s", err, out)
	}
	deadline := time.Now().Add(5 * time.Second)
	var recorded []byte
	for time.Now().Before(deadline) {
		recorded, err = os.ReadFile(output)
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	var args []string
	if err := json.Unmarshal(recorded, &args); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(args, []string{"--new-window", "--profile-directory=" + c.Profile, connect}) {
		t.Fatalf("native argument corruption: %v", args)
	}
}
