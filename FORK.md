# SetSpark fork workflow

This repository is SetSpark's fork of [open-pencil/open-pencil](https://github.com/open-pencil/open-pencil). Everything in [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`AGENTS.md`](./AGENTS.md) applies here too. This file adds the rules that exist only because this is a fork.

## Branches

- `master` mirrors upstream `master`. It takes no commits of ours and moves only by fast-forward to upstream's `master`. Never open a PR into it or push anything else to it.
- `dev` is the default branch and holds our work. Every change of ours is a branch off `dev` with a PR into `dev`.

## Our changes

- Branch off `dev`, open the PR into `dev`, and title it as `CONTRIBUTING.md` describes (`type(scope): description`). A squash merge is fine for these PRs.
- No AI co-author trailers and no tool-generated signatures in commits or PR bodies. Record AI help in the PR's AI assistance section. The Commit messages check fails on known AI co-author trailers, merge commits included.
- Keep edits to upstream files small and in place. Each edited line can conflict at the next sync. To keep an upstream job from running here, add a `github.repository == 'open-pencil/open-pencil'` condition to the job rather than moving or rewriting the file.

## Taking upstream updates

Run this whenever upstream `master` has moved (`git rev-list --count origin/master..upstream/master` is not 0). Use a token whose pushes and PRs trigger workflows (SetSpark's agent GitHub App, or a person). A PR opened with a workflow's `GITHUB_TOKEN` gets no CI. If that happens, close it and reopen it with one of those tokens. Pushing upstream commits that change `.github/workflows/` also needs the token's `workflows` permission.

1. Fast-forward `master`. Never use `--force` and never push tags: upstream's release workflows run on `v*` tags. A plain push is refused unless it is a fast-forward. `--no-follow-tags` keeps a `push.followTags` setting from sending annotated tags along with the branch.

   ```sh
   git remote add upstream https://github.com/open-pencil/open-pencil.git  # once
   git fetch upstream master && git fetch origin
   git push --no-follow-tags origin upstream/master:refs/heads/master
   ```

2. If `dev` lacks commits from `master` (`git rev-list --count origin/dev..origin/master` is not 0), open the sync PR, unless one is already open (`gh pr list --base dev --head master`). An open PR whose head is `master` picks up later fast-forwards by itself.

   ```sh
   gh pr create --repo SetSparkIO/open-pencil --base dev --head master \
     --title 'chore: merge upstream master into dev'
   ```

3. If the PR shows conflicts, resolve them on a branch instead, because nothing may be committed to `master`. Close the `master` PR and open this branch's PR into `dev`:

   ```sh
   git switch -c sync/upstream-YYYYMMDD origin/dev
   git merge --no-ff origin/master -m 'chore: merge upstream master into dev'
   # resolve, commit, push, then open the PR into dev
   ```

4. The PR needs CI green and review-agent's approval.
5. Merge it with a merge commit. Never squash or rebase a sync PR. Squashing drops upstream's ancestry, so every later sync conflicts again on the lines both sides changed.

   ```sh
   gh pr merge <n> --repo SetSparkIO/open-pencil --merge \
     --subject 'chore: merge upstream master into dev (#<n>)' --match-head-commit <head sha>
   ```

## Upstream workflows in this fork

Fast-forwarding `master` is a push, so it runs the push workflows in upstream's own copy of each file. A change on `dev` does not affect them. What the sync can trigger (all but Deploy preview can also be started by hand with `workflow_dispatch`):

| Workflow | Trigger | In this fork |
| --- | --- | --- |
| Deploy app, Build, Deploy docs | `v*` tags | Not triggered by the sync, which pushes no tags. |
| Build native contracts CI image | push to `master` that changes the paths in its `paths` filter (its own file, and a Dockerfile path that no longer exists upstream) | Enabled. A sync that changes either path makes one run. It fails and publishes nothing: at 1c66fed8 its build context directory does not exist, and if upstream fixes that, the push to `ghcr.io/open-pencil` is refused because this fork cannot write there. Disabling it (Actions, then the workflow, then Disable workflow) needs an admin. The state is a repository setting, so syncs would keep it. |
| Heavy tests | schedule | Schedules run from `dev`. No run in this fork so far. |
| Deploy preview | after Preview | Its job is limited to upstream on `dev` (#7). |

Check what is enabled with `gh workflow list --repo SetSparkIO/open-pencil --all`.

## Builds from this fork

SetSpark's design build pins a commit on `dev` and downloads it from `https://github.com/SetSparkIO/open-pencil/archive/<commit>.tar.gz`. Pin only commits that are on `dev`.
