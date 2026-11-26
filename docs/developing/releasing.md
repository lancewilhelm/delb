# Publish a release

Use [GitHub Releases](https://github.com/lancewilhelm/delb/releases) for the
version history and change summaries.

| Image tag               | Published from                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `edge`                  | The latest successful build from `main`.                                           |
| `stable`                | The GitHub release marked **Latest**, after the image build passes.                |
| `v1.0.0`, `v1.1.0-rc.1` | The matching published release or prerelease. Pin this tag to stay on one version. |

## Draft the notes

For `v1.0.0`, write a short first-release summary of what Delb does and link
to the [Docker install guide](../hosting/docker.md). Use `v1.0.0` as the
starting tag for the next stable release.

For later releases, open **Releases** and choose **Draft a new release**.
Select the new version and target the commit that you tested. Under **Previous
tag**, select the last stable release in this release line, then choose
**Generate release notes**. This includes changes from any prereleases since
the last stable release. GitHub groups linked pull requests by their labels
using [the release notes configuration](../../.github/release.yml).

To create the same draft from the command line, replace `TESTED_SHA` with the
full commit SHA of the tested build and use the appropriate release tags.

```sh
gh release create v1.0.1 --draft --target TESTED_SHA \
  --generate-notes --notes-start-tag v1.0.0
```

Add a short summary of the changes that readers and hosts will notice. Call out
steps an administrator must take before updating, changes that affect existing
data or configuration, and any known issues. Read the generated list and check
that each entry belongs in the release. Save the notes as a draft.

## Publish and verify the image

1. Wait for CI and the `edge` image build for the release commit. Test that
   image by digest with disposable data. For a release with migrations, also
   verify the upgrade and restore paths on a copy of a synthetic library.
2. If the release is ready for `stable`, set it as the latest release and
   publish it. For a release candidate, mark it as a prerelease before publishing.
3. Open [Actions](https://github.com/lancewilhelm/delb/actions/workflows/docker-image.yml)
   and confirm that the run for the release succeeds.
4. Confirm that the version tag resolves to an image for both Linux amd64 and
   arm64. For a release that advances `stable`, confirm that both tags resolve
   to the same digest. Here are the commands for the first release.

   ```sh
   docker buildx imagetools inspect ghcr.io/lancewilhelm/delb:v1.0.0
   docker buildx imagetools inspect ghcr.io/lancewilhelm/delb:stable
   ```

Wait for these checks before publishing another stable release. A Git tag
push runs verification. Publishing the GitHub release triggers the image build.
If a published build fails, inspect the workflow and rerun it after resolving
the failure. If a code fix is needed, publish a new version.
