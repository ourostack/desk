package main

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"
)

func makePrivate(t *testing.T, file string) {
	t.Helper()
	input, _ := json.Marshal([]string{file, filepath.Dir(file)})
	command := exec.Command(powerShellPath(), "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference='Stop'
$self=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($target in ([Console]::In.ReadToEnd()|ConvertFrom-Json)){
  $item=Get-Item -LiteralPath $target -Force
  $acl=$item.GetAccessControl('Access,Owner')
  $acl.SetOwner($self)
  $acl.SetAccessRuleProtection($true,$false)
  foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRule($rule)}
  $inheritance=if($item.PSIsContainer){'ContainerInherit,ObjectInherit'}else{'None'}
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($self,'FullControl',$inheritance,'None','Allow')))
  $item.SetAccessControl($acl)
}`)
	command.Stdin = bytes.NewReader(input)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("private Windows fixture failed: %s %v", output, err)
	}
}

func makePublic(t *testing.T, dir string) {
	t.Helper()
	input, _ := json.Marshal(dir)
	command := exec.Command(powerShellPath(), "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference='Stop'
$target=[Console]::In.ReadToEnd()|ConvertFrom-Json
$item=Get-Item -LiteralPath $target -Force
$acl=$item.GetAccessControl('Access,Owner')
$everyone=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($everyone,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
$item.SetAccessControl($acl)
`)
	command.Stdin = bytes.NewReader(input)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("public Windows fixture failed: %s %v", output, err)
	}
}
