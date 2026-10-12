"""Delegate to Bijection's one native component generator."""
import os
from pathlib import Path
import subprocess
import sys
root = Path(os.environ["BIJECTION_PLATFORM_ROOT"]).resolve()
repo = Path(__file__).resolve().parent.parent
subprocess.run([sys.executable, str(root / "scripts/component_fork_codegen.py"), "agents", "--repo", str(repo)], check=True)
