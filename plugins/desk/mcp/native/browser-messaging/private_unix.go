//go:build !windows

// Ported unchanged from ourostack/desk 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f.
package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"syscall"
)

func verifyPrivateConfig(file string, info os.FileInfo) error {
	dir, err := os.Lstat(filepath.Dir(file))
	if err != nil || !dir.IsDir() || dir.Mode()&os.ModeSymlink != 0 {
		return errors.New("NATIVE_CONFIG_DIRECTORY_INVALID")
	}
	for _, item := range []os.FileInfo{info, dir} {
		stat, ok := item.Sys().(*syscall.Stat_t)
		if !ok || int(stat.Uid) != os.Geteuid() || item.Mode().Perm()&0077 != 0 {
			return errors.New("NATIVE_CONFIG_NOT_PRIVATE")
		}
	}
	if runtime.GOOS == "darwin" {
		for _, target := range []string{file, filepath.Dir(file)} {
			output, err := exec.Command("/bin/ls", "-ldeq", target).Output()
			if err != nil || regexp.MustCompile(`(?m)^\s*\d+:`).Match(output) {
				return errors.New("NATIVE_CONFIG_ACL_REFUSED")
			}
		}
	}
	return nil
}

func prepareChild(command *exec.Cmd) {}
