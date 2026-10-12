"""Check this fork's exact component source with the platform's pinned JS graph."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

platform = Path(os.environ["BIJECTION_PLATFORM_ROOT"]).resolve()
repo = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(platform / "scripts"))
from qualification_toolchain import pinned_node

node = pinned_node(platform)
tools = platform / "npm-packages/components/agents/node_modules/.bin"
env = dict(os.environ, PATH=str(node.parent) + os.pathsep + os.environ["PATH"])
with tempfile.TemporaryDirectory(prefix="agent-custody-check-") as temporary:
    package = Path(temporary) / "package"
    shutil.copytree(repo, package,
                   ignore=shutil.ignore_patterns(".git", "node_modules", "dist", "target", "tools", "scripts", "example", "playground", "docs", "*.tsbuildinfo"))
    (package / "node_modules").symlink_to(tools.parent)
    subprocess.run([str(tools / "tsc"), "-p", "tsconfig.build.json"],
                   cwd=package, env=env, timeout=180, check=True)
    subprocess.run([str(tools / "vitest"), "run", "src", "--maxWorkers=1", "--no-file-parallelism"],
                   cwd=package, env=env, timeout=180, check=True)
