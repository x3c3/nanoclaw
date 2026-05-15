# Releasing NanoClaw

Starting with v2.0.63, NanoClaw publishes a GitHub Release on every `package.json` version bump. Each release ships:

- A tagged commit on `main` (`vX.Y.Z`).
- A `CHANGELOG.md` entry under `## [<version>] - <YYYY-MM-DD>`.
- A GitHub Release whose body mirrors the CHANGELOG entry plus a contributors section.

## When to cut a release

A release is cut whenever `package.json` is bumped on `main`. Maintainers bump the version on whatever cadence the work justifies — there is no fixed schedule. Cutting more frequently is better than batching: smaller releases are easier to read, pin, and revert.

## What goes in a release

`CHANGELOG.md` is the canonical record of user-visible change. The release body on GitHub mirrors it. Aim for:

- **Bold lead-ins** per major feature or fix, then a sentence-case prose explanation.
- **`[BREAKING]` prefix** for any change that requires user action. Always include the workaround inline — never link to a separate doc for the fix.
- **Doc links** for major features (relative paths into the repo, e.g. `[setup/lib/install-slug.sh](setup/lib/install-slug.sh)`).
- **Inline commands** for actionable steps, in backticks.
- **Minor items** as single plain bullets at the bottom of the entry, no bold lead-in.
- **No PR numbers** in the user-facing prose. PR references can live in the GitHub Release's `## Contributors` section.

## Publishing the release

1. Bump `package.json` and add a `CHANGELOG.md` entry in the same commit (commit message: `chore: bump version to vX.Y.Z`).
2. Once the bump commit lands on `main`, open a draft GitHub Release:
   - **Tag:** `vX.Y.Z`, target `main`.
   - **Title:** `vX.Y.Z` (bare version — descriptive content lives in the body, matching the CHANGELOG header pattern).
   - **Body:** copy the CHANGELOG entry verbatim. Append a `## Contributors` section listing every PR author who landed work in the release window. Append a `**Full Changelog**: https://github.com/nanocoai/nanoclaw/compare/<prev-tag>...vX.Y.Z` line at the bottom.
3. If anyone in the window opened their first NanoClaw PR, add a `## New Contributors` section above `## Contributors`, with each first-timer's first PR link and an invite to Discord.
4. Publish (not just save draft).

## Rollup releases

If multiple `package.json` bumps land between two GitHub Releases (as happened between v2.0.54 and v2.0.63), the next release is a rollup: its CHANGELOG entry covers everything merged since the last released tag, and the body opens with a one-line "Rollup release covering vX.Y.Z through vX.Y.W." note. After the catchup, return to one release per bump.

## Pinning

Packagers and forks pin to any tagged release. The tag is the source of truth — the GitHub Release's `target_commitish` always points to a tagged commit.
