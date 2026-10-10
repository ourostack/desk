package main

import (
	"encoding/json"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

const extensionID = "mmlmfjhmonkocbjadbfplnigmagldckm"

type config struct {
	Browser, Profile, Owner, Receipt, Nonce string
}

type receipt struct {
	Version int    `json:"version"`
	Nonce   string `json:"nonce"`
	Status  string `json:"status"`
	Code    string `json:"code,omitempty"`
	PID     int    `json:"pid,omitempty"`
}

func writeReceipt(c config, status, code string, pid int) error {
	data, err := json.Marshal(receipt{1, c.Nonce, status, code, pid})
	if err != nil {
		return err
	}
	// O_EXCL is the reservation: check-then-rename would let concurrent
	// invocations both start a browser for the same attempt.
	file, err := os.OpenFile(c.Receipt, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func finishReceipt(c config, status, code string, pid int) error {
	data, err := json.Marshal(receipt{1, c.Nonce, status, code, pid})
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(c.Receipt), ".receipt-")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if _, err = file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	// Keep the reservation in place until its complete successor replaces it.
	return os.Rename(name, c.Receipt)
}

func validConfig(c config) bool {
	if !filepath.IsAbs(c.Browser) || !filepath.IsAbs(c.Receipt) ||
		!regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(c.Nonce) ||
		c.Profile == "" || c.Profile == "." || c.Profile == ".." ||
		strings.ContainsAny(c.Profile, "/\\\x00\r\n") ||
		c.Owner == "" || len(c.Owner) > 160 || strings.ContainsAny(c.Owner, "\x00\r\n") {
		return false
	}
	info, err := os.Stat(c.Browser)
	return err == nil && info.Mode().IsRegular()
}

func validArgs(c config, args []string) bool {
	if len(args) != 2 || args[0] != "--profile-directory="+c.Profile ||
		strings.ContainsAny(args[1], "\x00\r\n") {
		return false
	}
	u, err := url.Parse(args[1])
	if err != nil || u.Scheme != "chrome-extension" || u.Host != extensionID ||
		u.Path != "/connect.html" || u.User != nil || u.Fragment != "" {
		return false
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil || len(q["mcpRelayUrl"]) != 1 || len(q["client"]) != 1 {
		return false
	}
	for key, values := range q {
		if len(values) != 1 || (key != "mcpRelayUrl" && key != "client" && key != "token" && key != "protocolVersion") {
			return false
		}
	}
	if version := q.Get("protocolVersion"); version != "" && !regexp.MustCompile(`^[1-9][0-9]{0,4}$`).MatchString(version) {
		return false
	}
	relay, err := url.Parse(q.Get("mcpRelayUrl"))
	if err != nil || relay.Scheme != "ws" || relay.Port() == "" ||
		relay.User != nil || relay.RawQuery != "" || relay.Fragment != "" {
		return false
	}
	ip := net.ParseIP(relay.Hostname())
	if relay.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return false
	}
	var client struct {
		Name string `json:"name"`
	}
	return json.Unmarshal([]byte(q.Get("client")), &client) == nil && client.Name == c.Owner
}

func run(c config, args, env []string, start func(string, []string, []string) (int, error)) int {
	if !validConfig(c) {
		return 2
	}
	if len(args) == 1 && args[0] == "--check" {
		if writeReceipt(c, "ready", "", 0) != nil {
			return 2
		}
		return 0
	}
	if !validArgs(c, args) {
		writeReceipt(c, "refused", "invalid_arguments", 0)
		return 2
	}
	// Reserve the output before launching. A second invocation on this same
	// attempt refuses instead of opening an unaccounted replacement window.
	if writeReceipt(c, "starting", "", 0) != nil {
		return 2
	}
	clean := make([]string, 0, len(env))
	for _, entry := range env {
		if !strings.HasPrefix(entry, "DESK_BROWSER_") &&
			!strings.HasPrefix(entry, "PLAYWRIGHT_MCP_EXTENSION_TOKEN=") {
			clean = append(clean, entry)
		}
	}
	pid, err := start(c.Browser, append([]string{"--new-window"}, args...), clean)
	if err != nil && pid > 0 {
		return 2
	}
	status, code := "spawned", ""
	if err != nil {
		status, code, pid = "refused", "browser_spawn_failed", 0
	}
	// Replace only the exact file we just reserved. Failure leaves "starting",
	// which the parent treats as unknown, never as permission to launch again.
	if finishReceipt(c, status, code, pid) != nil {
		return 2
	}
	if err != nil {
		return 1
	}
	return 0
}

func main() {
	c := config{
		Browser: os.Getenv("DESK_BROWSER_EXECUTABLE"),
		Profile: os.Getenv("DESK_BROWSER_PROFILE"),
		Owner:   os.Getenv("DESK_BROWSER_OWNER"),
		Receipt: os.Getenv("DESK_BROWSER_RECEIPT"),
		Nonce:   os.Getenv("DESK_BROWSER_NONCE"),
	}
	os.Exit(run(c, os.Args[1:], os.Environ(), func(browser string, args, env []string) (int, error) {
		command := exec.Command(browser, args...)
		command.Env = env
		if err := command.Start(); err != nil {
			return 0, err
		}
		pid := command.Process.Pid
		return pid, command.Process.Release()
	}))
}
