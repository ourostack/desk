import hashlib
import io
import json
import struct
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

BASE = "b9a8bdf46e52104b675c4e9334c7d27bab14c54d"
CANDIDATE = "6bfa5bb61c477b9cfeb384a1b292fe60d1116054"
LOCK = "0ad48e8fbdb14119f09db5e1b4b7d5199b9329218a1c1785c6927f609f408a9e"
PACK = f"plugins/desk/mcp/artifacts/runtime-deps/1.4.0-alpha.6/darwin-arm64-node-127/{LOCK}/runtime-deps.tgz"


def version(value):
    return [value >> 16, (value >> 8) & 255, value & 255]


def inspect_native(archive_bytes):
    natives = {}
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.endswith((".node", ".dylib", ".so")):
                continue
            data = archive.extractfile(member).read()
            assert data[:4] == bytes.fromhex("cffaedfe"), f"{member.name}: not thin Mach-O64"
            machine = struct.unpack_from("<I", data, 4)[0]
            assert machine == 0x0100000C, f"{member.name}: wrong machine {machine:#x}"
            offset = 32
            deployment = []
            for _ in range(struct.unpack_from("<I", data, 16)[0]):
                command, size = struct.unpack_from("<II", data, offset)
                assert size >= 8 and offset + size <= len(data), "invalid load command"
                if command == 0x32:
                    platform, minimum, sdk = struct.unpack_from("<III", data, offset + 8)
                    assert platform == 1, f"{member.name}: not macOS"
                    deployment.append({"command": "LC_BUILD_VERSION", "platform": platform,
                                       "minimum": version(minimum), "sdk": version(sdk)})
                elif command == 0x24:
                    minimum, sdk = struct.unpack_from("<II", data, offset + 8)
                    deployment.append({"command": "LC_VERSION_MIN_MACOSX",
                                       "minimum": version(minimum), "sdk": version(sdk)})
                offset += size
            assert deployment, f"{member.name}: no deployment minimum"
            natives[member.name.removeprefix("./")] = {
                "format": "Mach-O64", "machine": f"0x{machine:08x}",
                "sha256": hashlib.sha256(data).hexdigest(), "deployment": deployment,
            }
    return natives


metadata = json.loads(Path(sys.argv[1]).read_text())
artifact_bytes = Path(sys.argv[2]).read_bytes()
artifact_sha = hashlib.sha256(artifact_bytes).hexdigest()
assert metadata["digest"] == f"sha256:{artifact_sha}", "download digest mismatch"
assert metadata["size_in_bytes"] == len(artifact_bytes), "download length mismatch"
assert metadata["workflow_run"]["head_sha"] == CANDIDATE, "artifact source head mismatch"
assert metadata["name"] == "desk-runtime-pack-darwin-arm64-node-127", "wrong artifact"
assert metadata["expired"] is False, "artifact expired"
with zipfile.ZipFile(io.BytesIO(artifact_bytes)) as artifact:
    names = [name for name in artifact.namelist() if name.endswith("/runtime-deps.tgz")]
    assert len(names) == 1, f"expected one runtime archive, found {names}"
    prefix = names[0].removesuffix("runtime-deps.tgz")
    archive_bytes = artifact.read(names[0])
    manifest = json.loads(artifact.read(prefix + "runtime-deps.manifest.json"))
    checksum = artifact.read(prefix + "runtime-deps.sha256").decode().split()[0]
    archive_sha = hashlib.sha256(archive_bytes).hexdigest()
    assert manifest["archive"]["sha256"] == archive_sha == checksum, "pack hash mismatch"
    assert manifest["platform"] == {"os": "darwin", "arch": "arm64", "node_abi": "127"}
    assert LOCK in names[0], "production lock path changed"
    assert manifest["package_lock"]["prod_dependency_lock_hash"] == LOCK, "production lock metadata changed"

baseline_bytes = subprocess.check_output(["git", "show", f"{BASE}:{PACK}"])
baseline = inspect_native(baseline_bytes)
candidate = inspect_native(archive_bytes)
assert candidate.keys() == baseline.keys(), "native payload file set changed"
for name, details in candidate.items():
    candidate_minimum = max(tuple(entry["minimum"]) for entry in details["deployment"])
    baseline_minimum = max(tuple(entry["minimum"]) for entry in baseline[name]["deployment"])
    assert candidate_minimum <= baseline_minimum, f"{name}: raised deployment minimum"
    details["baseline_minimum"] = list(baseline_minimum)
    details["byte_identical_to_baseline"] = details["sha256"] == baseline[name]["sha256"]

print(json.dumps({
    "status": "pass", "source_head": CANDIDATE,
    "artifact_id": metadata["id"], "artifact_name": metadata["name"],
    "artifact_digest": metadata["digest"], "artifact_bytes": len(artifact_bytes),
    "pack_archive_sha256": archive_sha, "pack_platform": manifest["platform"],
    "production_lock_hash": LOCK, "native_files": candidate,
}, indent=2))
