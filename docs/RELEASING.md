# Releasing a new version of Forge

Installed copies of Forge update themselves from GitHub Releases, like VS Code:
with Settings → Updates on (the default) they check a little after starting and
every 6 hours, download a new version in the background, and install it when
Forge closes (the status bar's "Update ready" restarts now instead). The first
start of the new version shows the release notes on the Welcome page, so write
them for people using Forge. Help → Check for Updates asks first. The portable
version and the .deb can't replace themselves: they say a new version exists
and open the download page.

For that to work, every release must carry the files the updater reads.

## Steps

1. Bump `"version"` in `package.json` (for example `0.46.0` → `0.47.0`) and commit.
2. Build the installers:

   ```
   npm run dist
   ```

   This writes to `release/`:
   - `Forge-Setup-<version>.exe`: the installer
   - `Forge-Setup-<version>.exe.blockmap`: lets updates download only what changed
   - `latest.yml`: what installed copies read to find the update
   - `Forge-<version>-portable.exe`: the portable version

   Then `npm run checksums` writes `release/SHA256SUMS-windows.txt`: attach it too.

3. Publish a GitHub release tagged `v<version>` with **all four files**:

   ```
   gh release create v0.47.0 release/Forge-Setup-0.47.0.exe release/Forge-Setup-0.47.0.exe.blockmap release/latest.yml release/Forge-0.47.0-portable.exe --repo louisatron84/IDEforfun --target main --title "Forge 0.47.0" --notes-file notes.md
   ```

   The release notes are shown in Forge's update dialog, so write them for people using Forge.
   Don't mark it as a draft or pre-release: those are ignored.

   Publishing the release starts the **Release Linux** workflow (GitHub Actions): it
   builds `Forge-<version>-x86_64.AppImage` and `Forge-<version>-amd64.deb` on Ubuntu and
   attaches them with `latest-linux.yml` (AppImage copies update themselves; .deb users
   download the new one). Check it finished under the repository's Actions tab.

4. Update the download links on the website (forgecode.uk) to the new version.

## Notes

- `npm run dist` never uploads anything (`--publish never`); publishing is step 3.
- The installers aren't code-signed, so Windows SmartScreen still warns on a fresh install. Updates install over the existing copy.
- Copies older than 0.46.0 have no updater: people on 0.45.0 need to download 0.46.0 once by hand.
