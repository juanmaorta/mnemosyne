# Releasing

A release is one reviewed pull request. Merging it publishes the tag and the GitHub Release;
nothing else is done by hand.

## Why it is automated

Three things must agree, and each is read by a different part of Mnemosyne:

| What | Read by |
|---|---|
| The `vX.Y.Z` git tag | `install.sh` and `mneme upgrade`, which install the highest semver tag |
| The latest **GitHub Release** | the new-version notice in `mneme context` (`/releases/latest`) |
| `version` in `package.json` | the same notice, as "the version you have", and `mneme --version` |

Tag a version without bumping `package.json` and every install upgrades to it, then announces
"a new version is available" forever. So the tag is never typed: it is derived from
`package.json` by the workflow.

## Cutting a release

On an up-to-date `main`, with a clean tree:

```sh
npm run release -- minor --dry-run   # look first: the version and the changelog section
npm run release -- minor             # or patch, major, or an explicit 1.2.3
```

`scripts/release.mjs prepare`:

1. bumps `version` in `package.json` and `package-lock.json`;
2. adds a section on top of `CHANGELOG.md` with the commits since the last tag — `✨` under
   *Added*, `🐛` under *Fixed*, the rest under *Other*; merge commits, release commits and the
   ` (#NN)` suffix are left out;
3. commits `🔖 release: vX.Y.Z` on a new `release/vX.Y.Z` branch, pushes it and opens the PR
   with `gh`.

It refuses, and changes nothing, when the tree is dirty, you are not on `main`, `main` is not
at `origin/main`, or the version is already tagged or not higher than the latest tag.

The changelog lines are the commit subjects as written. **Edit `CHANGELOG.md` on the release
branch** before merging if they need it: the section is exactly what the GitHub Release shows.

The PR is opened from your machine and not by a workflow on purpose: a PR opened with a
workflow's `GITHUB_TOKEN` does not trigger CI.

### The first release

`package.json` already says the version (`0.1.0`) before any tag exists. Ask for it
explicitly — `npm run release -- 0.1.0` — and only `CHANGELOG.md` changes, with a
"First public release." section to edit instead of the whole history.

### Pre-releases

`npm run release -- 1.0.0-rc.1` works the same way. The GitHub Release is marked as a
pre-release and never as *latest*, so the update notice does not offer it — but `install.sh`
picks the highest tag, and `1.0.0-rc.1` is higher than `0.9.0`. Publish one only when you mean
installs to get it.

## What the merge does

`.github/workflows/release.yml` runs on every push to `main` and asks
`scripts/release.mjs plan`:

- **the version is already tagged** → nothing to do. This is every ordinary merge.
- **it is new and higher than the latest tag, and `CHANGELOG.md` has its section** →
  `gh release create vX.Y.Z --target <merge commit>`, which creates the tag and the Release
  with that section as the notes.
- **anything else** (not semver, not higher than the latest tag, no changelog section) → the
  job fails and publishes nothing. The one exception is before the first release: with no tags
  at all, a version without a changelog section is simply "not released yet", and merges stay
  green.

## When the workflow fails

The merge is on `main`, but there is no tag and no Release, so installs and the notice are
unaffected. Fix the cause with a normal PR — add the missing `CHANGELOG.md` section, or
correct the version — and either merge it (the workflow runs again) or, if nothing else needs
changing, rerun it from **Actions → Release → Run workflow**. It is idempotent: it never
publishes the same version twice.

To check what it would decide without publishing anything:

```sh
node scripts/release.mjs plan --notes-out /tmp/notes.md   # prints tag=… (empty: nothing to publish)
```

## Undoing a release

Prefer publishing a fixed patch release over deleting one: installs may already be on the tag.
If a release must go, delete the Release and the tag on GitHub, and revert or bump the version
in `package.json` with a PR, so the next merge does not publish it again.
