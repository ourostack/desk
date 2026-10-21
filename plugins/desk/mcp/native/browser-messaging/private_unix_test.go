//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func makePrivate(t *testing.T, file string) {
	t.Helper()
	if err := os.Chmod(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, 0600); err != nil {
		t.Fatal(err)
	}
}

func makePublic(t *testing.T, dir string) {
	t.Helper()
	if err := os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
}
