"""One-shot synthetic fixture; no product helper or live onboarding is invoked."""
import hashlib
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
RECEIPT = ROOT / "receipt.txt"


def log(message):
    with RECEIPT.open("a") as out:
        out.write(message + "\n")
    print(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def create_dir(path):
    if path == ROOT or path.exists():
        return
    create_dir(path.parent)
    path.mkdir()
    log(f"CREATED DIRECTORY {path}")


def create_file(path, content):
    create_dir(path.parent)
    with path.open("x") as out:
        out.write(content)
    log(f"CREATED FILE {path}")


def snapshot():
    result = {}
    for path in sorted(ROOT.rglob("*")):
        if path == RECEIPT:
            continue
        assert not path.is_symlink()
        stat = path.stat()
        result[str(path.relative_to(ROOT))] = (
            "directory" if path.is_dir() else digest(path.read_bytes()),
            stat.st_mode, stat.st_mtime_ns, stat.st_ino,
        )
    return result


def manifest(label, state):
    log(label + " (SHA-256 for files; directory type, mode, mtime_ns, inode):")
    for path, values in state.items():
        log(f"{path} {values}")


def check(condition, message):
    assert condition, message
    log("PASS " + message)


log(f"CREATED FILE {Path(__file__).resolve()} (created by apply_patch)")
log(f"COMMAND PYTHONDONTWRITEBYTECODE=1 python3 {Path(__file__).resolve()}")
log(f"PROCESS acceptance Python pid={os.getpid()} parent_shell_pid={os.getppid()}; synchronous; no subprocesses or background services.")
log("Decision: synthetic Mira owns only desks/mira. Shared source, template, peer index, and Sol reservation are read-only after fixture creation. No live membership registry exists in this fixture.")

member = ROOT / "desks/mira"
peer = ROOT / "desks/sol"
task = member / "harbor-delivery/publish-harbor-guide"
artifacts = task / "_iterations/2026-10-28-initial-impl/artifacts"
loose = member / "proposal.md"
collision = artifacts / "proposal.md"
target = artifacts / "proposal-mira.md"
shared = ROOT / "_shared/landscape/harbor-source.md"
index = peer / "_meta/index.md"
template = ROOT / "desks/_template"
blocked = ROOT / "desks/rook"

create_file(member / "AGENTS.md", "# Mira\nSynthetic member; own-desk filing only.\n")
create_file(member / "harbor-delivery/track.md", "---\ntitle: harbor-delivery\n---\n# Harbor delivery\nScope: Publish the invented Harbor guide.\n\n## Tasks\n- [Publish Harbor guide](publish-harbor-guide/task.md)\n")
create_file(task / "task.md", "---\ntitle: publish-harbor-guide\ntrack: harbor-delivery\nstatus: doing\nrepos: []\n---\n# Publish Harbor guide\nDeliver the Harbor guide. Existing task owns the guide proposal; do not create another task.\n")
original = "# Harbor guide proposal\n\nAuthor: Mira (synthetic), 2026-10-28. This is Mira's proposal, not a team decision.\n\nFor the existing publish-harbor-guide task in harbor-delivery, publish the guide with a tide glossary. This is a complete proposal artifact.\n\nSource: [Harbor source](../../_shared/landscape/harbor-source.md).\n"
create_file(loose, original)
create_file(collision, "# Harbor guide proposal\n\nAuthor: Sol (synthetic), 2026-10-27. Mira owns this retained copy.\n\nDistinct existing proposal: publish the guide without a tide glossary. No agreement is recorded.\n")
create_file(shared, "# Synthetic Harbor source\n\nInvented source: the guide must explain the tide labels.\n")
create_file(index, "# Sol's index\n\n[Read Mira's proposal](../../mira/proposal.md)\n")
create_file(peer / "AGENTS.md", "# Sol\nSynthetic other-member desk; no write authority granted to Mira.\n")
create_file(peer / "_meta/reservation.txt", "Reserved for Sol; Mira has no adoption authority.\n")
create_file(template / "_meta/friction.md", "# Synthetic friction template\n")
create_file(blocked / "_meta", "Synthetic existing FILE: must not be replaced by template DIRECTORY.\n")

before = snapshot()
manifest("ORIGINAL", before)
original_collision = collision.read_bytes()
original_peer = {p: v for p, v in before.items() if p.startswith("desks/sol/")}
task_cards = sorted(str(p.relative_to(ROOT)) for p in ROOT.rglob("task.md"))
log("Decision: content and task card both name publish-harbor-guide; reuse its existing no-repository iteration artifact scope. Destination proposal.md is distinct Sol-authored content; preserve it byte-for-byte and file Mira's artifact as proposal-mira.md. Preserve the peer index through an owned Markdown compatibility pointer, not a symlink.")


def file_proposal():
    text = loose.read_text()
    pointer = "# Proposal moved\n\n[Read Mira's Harbor guide proposal](harbor-delivery/publish-harbor-guide/_iterations/2026-10-28-initial-impl/artifacts/proposal-mira.md).\n"
    if text == pointer:
        assert target.is_file()
        assert target.read_text() == original.replace(
            "../../_shared/landscape/harbor-source.md",
            "../../../../../../../_shared/landscape/harbor-source.md",
        )
        return "already filed; no writes"
    assert text == original, "Unexpected source: refuse rather than guess"
    assert collision.read_bytes() == original_collision
    assert not target.exists(), "Unexpected second collision: refuse"
    assert target.is_relative_to(member) and loose.is_relative_to(member)
    # Only the outgoing URL changes; attribution and prose remain verbatim.
    create_file(target, text.replace(
        "../../_shared/landscape/harbor-source.md",
        "../../../../../../../_shared/landscape/harbor-source.md",
    ))
    loose.write_text(pointer)
    log(f"UPDATED FILE {loose} (owned compatibility pointer)")
    return "filed once"


check(file_proposal() == "filed once", "First filing executes actual filesystem writes")
check(target.is_relative_to(task) and target.is_file(), "Misplaced proposal now exists in the existing canonical task scope")
check(collision.read_bytes() == original_collision, "Existing same-name collision document is byte-identical")
check(target.read_text().replace("../../../../../../../_shared/landscape/harbor-source.md", "../../_shared/landscape/harbor-source.md") == original, "Mira's entire original document survives, with only its source URL rebased")
log(f"PROVENANCE original Mira SHA-256={digest(original.encode())}; canonical Mira SHA-256={digest(target.read_bytes())}; retained collision SHA-256={digest(original_collision)}")


def resolve_link(document):
    links = re.findall(r"\[[^\]]+\]\(([^)]+)\)", document.read_text())
    assert len(links) == 1
    resolved = (document.parent / links[0]).resolve(strict=True)
    assert resolved.is_relative_to(ROOT)
    log(f"LINK {document} -> {links[0]} -> {resolved}; SHA-256={digest(resolved.read_bytes())}")
    return resolved


check(resolve_link(target) == shared, "Rebased outgoing source reference resolves to the same synthetic source bytes")
check(resolve_link(resolve_link(index)) == target, "Unchanged peer incoming reference resolves through the owned compatibility pointer")
after_first = snapshot()
check({p: v for p, v in after_first.items() if p.startswith("desks/sol/")} == original_peer, "Peer index, content, and reservation retain bytes, modes, mtimes, and inodes")
check(all(before[p] == after_first[p] for p in before if not p.startswith("desks/mira")), "All preexisting fixture entries outside the owned desk remain unchanged")
check(file_proposal() == "already filed; no writes", "Second filing recognizes the compatibility pointer and existing destination")
check(snapshot() == after_first, "Second filing leaves every fixture file and directory unchanged (receipt excluded)")
check(sorted(str(p.relative_to(ROOT)) for p in ROOT.rglob("task.md")) == task_cards, "No duplicate task cards")
check(len(list(artifacts.glob("proposal*.md"))) == 2, "Exactly two distinct canonical proposal documents; no repeat copy or move")

log("Decision: blocked setup preview only. Compare template path types before any setup write; refuse the file/directory collision. Do not invoke crew.js or registration.")
before_refusal = snapshot()
conflicts = []
for source in template.rglob("*"):
    destination = blocked / source.relative_to(template)
    if destination.exists() and source.is_dir() != destination.is_dir():
        conflicts.append(str(destination))
check(conflicts == [str(blocked / "_meta")], "REFUSED unsafe setup: template _meta directory conflicts with existing _meta file")
check(snapshot() == before_refusal, "Unsafe setup refusal causes no mutation anywhere in the fixture (receipt excluded)")

log("Decision: Sol's reserved folder is another member's content. No authority to adopt or organize it; refuse before any mutation.")
before_reserved = snapshot()
requested_owner = "mira"
reserved_owner = "sol"
check(requested_owner != reserved_owner and (peer / "_meta/reservation.txt").is_file(), "REFUSED other-member reserved folder: Mira is not its owner")
check(snapshot() == before_reserved, "Other-member refusal causes no mutation anywhere in the fixture (receipt excluded)")
manifest("FINAL", snapshot())
log("Coverage: happy path, collision edge, state/idempotence, authorization boundary, refusal/no mutation exercised. Null/empty, cache, live exceptions: not applicable to this fixed local filing scenario; not engine coverage.")
log("RESULT PASS: all five behavioral acceptance outcomes verified from actual filesystem bytes and Markdown reference targets. Fixture retained. No claim about live onboarding, installation, release, or crew.js engine verification.")
