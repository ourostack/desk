// Native messaging entry from ourostack/desk at
// 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f, mcp/native/browser-messaging.
// Source only: no precompiled/released artifact is claimed by this port.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

type config struct {
	Runtime         string `json:"runtime"`
	HostModule      string `json:"hostModule"`
	ExtensionOrigin string `json:"extensionOrigin"`
}

var originPattern = regexp.MustCompile(`^chrome-extension://[a-p]{32}/$`)
var parentPattern = regexp.MustCompile(`^--parent-window=[0-9]+$`)

func validConfig(c config) bool {
	if !originPattern.MatchString(c.ExtensionOrigin) {
		return false
	}
	for _, file := range []string{c.Runtime, c.HostModule} {
		if !filepath.IsAbs(file) {
			return false
		}
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func readConfig(file string) (config, error) {
	var c config
	info, err := os.Lstat(file)
	if err != nil {
		return c, err
	}
	if !info.Mode().IsRegular() || info.Size() > 16384 {
		return c, errors.New("NATIVE_CONFIG_NOT_PRIVATE")
	}
	if err := verifyPrivateConfig(file, info); err != nil {
		return c, err
	}
	input, err := os.Open(file)
	if err != nil {
		return c, err
	}
	defer input.Close()
	opened, err := input.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return c, errors.New("NATIVE_CONFIG_CHANGED")
	}
	decoder := json.NewDecoder(io.LimitReader(input, 16385))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return c, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return c, errors.New("NATIVE_CONFIG_TRAILING_DATA")
	}
	if !validConfig(c) {
		return c, errors.New("NATIVE_CONFIG_INVALID")
	}
	return c, nil
}

func run(c config, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if !validConfig(c) || len(args) < 1 || args[0] != c.ExtensionOrigin ||
		(len(args) != 1 && !(runtime.GOOS == "windows" && len(args) == 2 && parentPattern.MatchString(args[1]))) {
		fmt.Fprintln(stderr, "NATIVE_HOST_REFUSED")
		return 2
	}
	child := exec.Command(c.Runtime, c.HostModule, c.ExtensionOrigin)
	prepareChild(child)
	child.Stdin, child.Stdout, child.Stderr = stdin, stdout, stderr
	// nil means inherit; an empty filtered environment must stay empty.
	child.Env = []string{}
	for _, variable := range os.Environ() {
		name, _, _ := strings.Cut(variable, "=")
		if !strings.EqualFold(name, "NODE_OPTIONS") && !strings.EqualFold(name, "NODE_PATH") {
			child.Env = append(child.Env, variable)
		}
	}
	if err := child.Run(); err != nil {
		var exited *exec.ExitError
		if errors.As(err, &exited) {
			return exited.ExitCode()
		}
		fmt.Fprintln(stderr, "NATIVE_RUNTIME_START_FAILED")
		return 1
	}
	return 0
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "NATIVE_ENTRY_IDENTITY_UNAVAILABLE")
		os.Exit(2)
	}
	c, err := readConfig(filepath.Join(filepath.Dir(executable), "native-host.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "NATIVE_CONFIG_REFUSED")
		os.Exit(2)
	}
	os.Exit(run(c, os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
