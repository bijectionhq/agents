# @bijectionhq/agents maintenance

Use one private worktree per chat. Edit normally and preserve unrelated work.
Commit selected files with Git, then publish through the platform's installed
`stack repo land --repository <this-worktree>` owner. Use `stack repo refresh`
with the same repository selection to merge published main. The retired
`scripts/land.py` remains available for recovering older publication records.
Do not rewrite published history or replace files from stale snapshots.
No local builds or compilation, including dependencies and tool bootstrap.
Reuse installed tools and dispatch builds to the platform's remote build core.
Real integration, persistence, provider and recovery tests use the platform's
Atlas framework against real production deployments, with its isolation,
assertion and cleanup owners. Do not replace them with a local backend,
disposable local database or ad hoc harness.
Keep upstream contracts intact. Read BIJECTION.md and concave.json before edits.
Every semantic divergence needs an invariant, a bounded source fence, a witness,
and an explicit removal condition. Record it with Concave before landing.
Do not add automatic CI, publish packages, deploy, or create paid runtime unless
explicitly requested. Fork examples are upstream comparison material.
