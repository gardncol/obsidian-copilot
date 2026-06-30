#!/usr/bin/env python3
"""
Weekly task: check upstream Copilot for Obsidian for new changes,
merge them into the gardncol fork, preserve custom patches, and
create a new release.
"""
import subprocess, json, os, sys, re, tempfile, base64
from datetime import datetime
from pathlib import Path

REPO_DIR = "/home/colin/obsidian-agent"
UPSTREAM = "logancyang/obsidian-copilot"
FORK = "gardncol/obsidian-copilot"
TOKEN_FILE = "/tmp/gh_token2.txt"

# ── files we changed — these must NOT be overwritten by upstream ──
PATCHED_FILES = {
    # settings / UI — Plus gate removals and renames
    "src/LLMProviders/chainRunner/utils/toolExecution.ts",
    "src/LLMProviders/chainRunner/CopilotPlusChainRunner.ts",
    "src/LLMProviders/chainRunner/AutonomousAgentChainRunner.ts",
    "src/commands/index.ts",
    "src/settings/v2/components/PlusSettings.tsx",
    "src/settings/v2/components/CopilotPlusSettings.tsx",
    "src/settings/v2/components/BasicSettings.tsx",
    "src/components/chat-components/ChatControls.tsx",
    "src/components/chat-components/SuggestedPrompts.tsx",
    "src/settings/v2/components/QASettings.tsx",
    "src/constants.ts",
    # manifest / identity
    "manifest.json",
    "README.md",
}

def run(cmd, cwd=None, check=True, timeout=120):
    """Run a shell command and return (stdout, stderr, returncode)."""
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        print(f"FAILED: {' '.join(cmd)}\n{r.stderr[:500]}")
        sys.exit(1)
    return r.stdout.strip(), r.stderr.strip(), r.returncode

def has_new_upstream_commits():
    """Check if upstream has commits our fork doesn't."""
    repo = Path(REPO_DIR)
    if not (repo / ".git").exists():
        print(f"Repo not found at {REPO_DIR}, cloning...")
        repo.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", f"https://github.com/{FORK}.git", str(repo)])
    # Fetch upstream
    run(["git", "remote", "add", "upstream",
         f"https://github.com/{UPSTREAM}.git"], cwd=repo, check=False)
    run(["git", "fetch", "upstream", "master"], cwd=repo, timeout=60)
    # Check if we're behind
    out, _, _ = run(
        ["git", "rev-list", "--count", "HEAD..upstream/master"], cwd=repo, check=False)
    behind = int(out) if out else 0
    if behind == 0:
        print(f"No new upstream commits (behind by {behind}).")
        return False
    print(f"Upstream is ahead by {behind} commits.")
    return True

def merge_upstream():
    """Merge upstream master, keeping our patched files."""
    repo = Path(REPO_DIR)
    # Stash any local changes
    run(["git", "stash"], cwd=repo, check=False)

    # Try to merge
    out, err, rc = run(
        ["git", "merge", "upstream/master", "--no-edit"], cwd=repo, check=False)
    if rc != 0:
        print("Merge conflicts detected. Resolving by keeping our versions of patched files.")
        for f in PATCHED_FILES:
            run(["git", "checkout", "--ours", f], cwd=repo, check=False)
        run(["git", "add", "."], cwd=repo)
        out2, _, rc2 = run(
            ["git", "commit", "-m", "fix: auto-merge upstream, keep fork patches"],
            cwd=repo, check=False)
        if rc2 != 0:
            print("Nothing to commit after conflict resolution.")
    else:
        print("Merge succeeded.")

    # Restore stash if any
    run(["git", "stash", "pop"], cwd=repo, check=False)

def bump_version():
    """Bump the patch version in manifest.json."""
    mf = Path(REPO_DIR) / "manifest.json"
    m = json.loads(mf.read_text())
    v = m["version"]
    # e.g. "3.3.3-fork.1" -> bump to "3.3.3-fork.2"
    parts = v.rsplit(".", 1)
    if len(parts) == 2 and parts[1].isdigit():
        new_v = f"{parts[0]}.{int(parts[1]) + 1}"
    else:
        new_v = f"{v}.1"
    m["version"] = new_v
    mf.write_text(json.dumps(m, indent=2) + "\n")
    print(f"Bumped version to {new_v}")
    return new_v

def create_release(version):
    """Build and push a new release to GitHub."""
    repo = Path(REPO_DIR)

    # Build the plugin
    run(["npm", "run", "build"], cwd=repo, timeout=120)

    # Read token
    try:
        tk = Path(TOKEN_FILE).read_text().strip()
    except FileNotFoundError:
        print(f"Token file {TOKEN_FILE} not found — can't publish release.")
        return

    tag = f"v{version}"
    import urllib.request, urllib.error

    # Delete existing release with same tag
    req = urllib.request.Request(
        f"https://api.github.com/repos/{FORK}/releases",
        headers={"Authorization": f"token {tk}", "Accept": "application/vnd.github.v3+json"})
    try:
        with urllib.request.urlopen(req) as resp:
            releases = json.loads(resp.read())
        for rel in releases:
            if rel["tag_name"] == tag:
                req_del = urllib.request.Request(rel["url"], method="DELETE",
                    headers={"Authorization": f"token {tk}", "Accept": "application/vnd.github.v3+json"})
                with urllib.request.urlopen(req_del): pass
                print(f"Deleted old release: {rel['id']}")
    except Exception as e:
        print(f"Note: {e}")

    # Create new release
    data = json.dumps({"tag_name": tag, "name": tag,
        "body": f"Auto-merge from upstream ({datetime.now().strftime('%Y-%m-%d')}).\n\nKeep our fork patches intact.",
        "draft": False, "prerelease": False}).encode()
    req_new = urllib.request.Request(
        f"https://api.github.com/repos/{FORK}/releases", data=data,
        headers={"Authorization": f"token {tk}", "Accept": "application/vnd.github.v3+json",
                 "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req_new) as resp_new:
        release = json.loads(resp_new.read())
        upload_base = release["upload_url"].replace("{?name,label}", "")
        print(f"Created: {release['html_url']}")

    # Upload assets
    for fn in ["main.js", "manifest.json", "styles.css"]:
        fp = os.path.join(REPO_DIR, fn)
        with open(fp, "rb") as f:
            d = f.read()
        u = f"{upload_base}?name={fn}"
        req_up = urllib.request.Request(u, data=d,
            headers={"Authorization": f"token {tk}", "Accept": "application/vnd.github.v3+json",
                     "Content-Type": "application/octet-stream"}, method="POST")
        with urllib.request.urlopen(req_up) as resp_up:
            a = json.loads(resp_up.read())
            print(f"  {fn} ({a['size']} bytes)")

    # git push
    run(["git", "add", "-A"], cwd=repo)
    run(["git", "commit", "--allow-empty", "-m",
         f"chore: auto-release v{version} from upstream merge"], cwd=repo, check=False)
    run(["git", "tag", tag], cwd=repo, check=False)
    run(["git", "push", "origin", "master", "--tags"], cwd=repo, timeout=60)
    print(f"\nRelease {tag} pushed to https://github.com/{FORK}/releases/tag/{tag}")

def main():
    print(f"=== Obsidian Agent Upstream Sync — {datetime.now().isoformat()} ===")

    if not has_new_upstream_commits():
        print("Nothing to do.")
        sys.exit(0)

    merge_upstream()
    version = bump_version()
    create_release(version)
    print("\nDone.")

if __name__ == "__main__":
    main()
