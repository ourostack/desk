// Ported unchanged from ourostack/desk 60adac5ff6f14fbef6e371fa2983f84e0f7eba9f.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const verifyACL = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$paths=[Console]::In.ReadToEnd()|ConvertFrom-Json
$self=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($target in $paths){
  $item=Get-Item -LiteralPath $target -Force
  if($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint){exit 2}
  $acl=$item.GetAccessControl('Access,Owner')
  if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $self){exit 2}
  if(-not $acl.AreAccessRulesProtected){exit 2}
  $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
  if($rules.Count -ne 1){exit 2}
  $rule=$rules[0]
  if($rule.IdentityReference -ne $self -or $rule.AccessControlType -ne 'Allow'){exit 2}
  $full=[System.Security.AccessControl.FileSystemRights]::FullControl
  if(($rule.FileSystemRights -band $full) -ne $full){exit 2}
}
[Console]::Out.Write('private')
`

func powerShellPath() string {
	root := ""
	for _, variable := range os.Environ() {
		name, value, _ := strings.Cut(variable, "=")
		if strings.EqualFold(name, "SystemRoot") {
			root = value
		}
	}
	if !filepath.IsAbs(root) {
		return ""
	}
	return filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

func verifyPrivateConfig(file string, info os.FileInfo) error {
	dir, err := os.Lstat(filepath.Dir(file))
	if err != nil || !dir.IsDir() || dir.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return errors.New("NATIVE_CONFIG_DIRECTORY_INVALID")
	}
	provider := powerShellPath()
	if provider == "" {
		return errors.New("NATIVE_CONFIG_ACL_UNAVAILABLE")
	}
	input, _ := json.Marshal([]string{file, filepath.Dir(file)})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, provider, "-NoProfile", "-NonInteractive", "-Command", verifyACL)
	prepareChild(command)
	command.Stdin = bytes.NewReader(input)
	output, err := command.Output()
	if err != nil || string(output) != "private" {
		return errors.New("NATIVE_CONFIG_ACL_REFUSED")
	}
	return nil
}

func prepareChild(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
