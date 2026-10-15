# @bijectionhq/agents maintenance

Use one private worktree per chat. Edit normally and preserve unrelated work.
Commit selected files with Git, then publish through the platform's installed
`stack repo land --repository <this-worktree>` owner. Use `stack repo refresh`
with the same repository selection to merge published main. The retired
`scripts/land.py` remains available for recovering older publication records.
Do not rewrite published history or replace files from stale snapshots.
Keep upstream contracts intact. Read BIJECTION.md and concave.json before edits.
Every semantic divergence needs an invariant, a bounded source fence, a witness,
and an explicit removal condition. Record it with Concave before landing.
Do not add automatic CI, publish packages, deploy, or create paid runtime unless
explicitly requested. Fork examples are upstream comparison material.
