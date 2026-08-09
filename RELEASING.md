# Release and Adoption Policy

Owner: Bartosz Arendt for all decisions below.

## Prerelease

The first public prerelease ships only when `npx agenticloop validate`,
`npm test`, and `npm pack --dry-run` pass on `main`. Per the roadmap
sequencing, it does not ship before H2 exit.

## Compatibility and support

Before `1.0`, minor versions may include breaking changes. Starting with
`1.0`, releases follow Semantic Versioning. Only the latest released minor
version is supported.

## Deprecation

Bartosz Arendt may deprecate or remove public CLI commands, aliases, and
schemas. Removal requires notice in `CHANGELOG.md` for at least one minor
release. Starting with `1.0`, incompatible removals occur only in a major
release.

## Adoption targets

Adoption targets are public repositories only. There are no private adoption
targets, so no consent or confidentiality process applies.

## Field-demand threshold

The threshold that may open H5 is one distinct public downstream repository
outside the Agentic Loop repository with publicly visible evidence of a
completed loop. H1 requires this threshold to have an accountable owner and a
durable decision; H1 does not require the threshold to have been met.
