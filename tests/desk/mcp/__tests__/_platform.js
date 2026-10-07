// Precise skip reasons for tests that exercise something Windows does not have. A test skipped with one of these names the
// limit, so a skip is never a silent gap: the Windows behavior is covered by the native Windows tests (windows_acl.test.js,
// outbox_windows.test.js, windows_store.test.js).
const win32 = process.platform === "win32"

export const isWindows = win32
export const NO_POSIX_MODES = win32 ? "NTFS keeps no POSIX mode bits: fs.stat reports 0o666 or 0o777 and chmod cannot deny access; the Windows owner-only DACL is covered by the native Windows tests" : false
export const NO_ENOTDIR = win32 ? "Windows reports a file used as a folder as ENOENT, not ENOTDIR" : false
export const NO_SHEBANG_SCRIPTS = win32 ? "the fixture is an executable #! shell script, which Windows cannot run as a program" : false
export const NO_POSIX_PATHS = win32 ? "the pattern is a POSIX path under /tmp or /var/folders, which a Windows temp folder is not; pkill does not exist on Windows" : false
export const NO_FILE_SYMLINKS = win32 ? "creating a file symbolic link needs a privilege a standard Windows user does not have; a folder link is tested as a junction" : false
export const NO_BACKSLASH_NAMES = win32 ? "a backslash is a path separator on Windows, so it cannot be part of a folder name" : false
