# Releasing a new version of Forge

Installed copies of Forge update themselves from GitHub Releases. They check a
little after starting (Settings → Updates), or when you choose Help → Check for
Updates. They ask before downloading, then offer "Restart to update". The
portable version can't replace itself: it says a new version exists and opens
the download page.

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

3. Publish a GitHub release tagged `v<version>` with **all four files**:

   ```
   gh release create v0.47.0 release/Forge-Setup-0.47.0.exe release/Forge-Setup-0.47.0.exe.blockmap release/latest.yml release/Forge-0.47.0-portable.exe --repo louisatron84/IDEforfun --target main --title "Forge 0.47.0" --notes-file notes.md
   ```

   The release notes are shown in Forge's update dialog, so write them for people using Forge.
   Don't mark it as a draft or pre-release: those are ignored.

4. Update the download links on the website (forgecode.uk) to the new version.

## Notes

- `npm run dist` never uploads anything (`--publish never`); publishing is step 3.
- The installers aren't code-signed, so Windows SmartScreen still warns on a fresh install. Updates install over the existing copy.
- Copies older than 0.46.0 have no updater: people on 0.45.0 need to download 0.46.0 once by hand.
