// The desktop app's self-updater, kept free of Electron so it can be tested (tests/updater.test.ts).
//
// Every build of main is a GitHub Release with the game (game.html, one self-contained file)
// and build.json ({ build, shell }): the build number, and the app-shell version it needs.

const fs = require('node:fs');
const path = require('node:path');

/** { build, shell } of the game in `dir` (build 0: a local build with no build.json). */
function readBuild(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
    return { build: Number(j.build) || 0, shell: Number(j.shell) || 1 };
  } catch {
    return { build: 0, shell: 1 };
  }
}

/**
 * Which game to run: a downloaded update when it is newer than the bundled game and this shell
 * can run it, else the bundled one. `allowUpdates` is false for `npm run app` and smoke tests.
 */
function pickGame({ bundledDir, updatesDir, shellVersion, allowUpdates }) {
  const bundled = { dir: bundledDir, ...readBuild(bundledDir) };
  if (!allowUpdates) return bundled;
  const cached = { dir: updatesDir, ...readBuild(updatesDir) };
  const ok = cached.build > bundled.build && cached.shell <= shellVersion && fs.existsSync(path.join(updatesDir, 'index.html'));
  return ok ? cached : bundled;
}

/** A release asset's URL — only from this repository's own releases. */
function assetUrl(release, name, repo) {
  const url = release && Array.isArray(release.assets) ? release.assets.find((a) => a && a.name === name)?.browser_download_url : null;
  return typeof url === 'string' && url.startsWith(`https://github.com/${repo}/releases/download/`) ? url : null;
}

/** A sanity check, not a signature: it has to look like our single-file build. */
function looksLikeGame(html) {
  return typeof html === 'string' && html.length >= 200_000 && html.length <= 60_000_000 && /^<!doctype html>/i.test(html.trimStart()) && html.includes('PvP Trainer');
}

/**
 * Looks at the latest release. Returns null (nothing newer), { kind: 'app', build } (a newer game
 * needs a newer app shell: nothing is downloaded) or { kind: 'game', build } after saving the new
 * game into `updatesDir` (used from the next start). `fetch(url)` is the caller's (Electron's
 * net.fetch in the app, a fake in tests).
 */
async function checkForUpdate({ fetch, repo, currentBuild, shellVersion, updatesDir }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
  if (!res.ok) return null;
  const release = await res.json();
  const infoUrl = assetUrl(release, 'build.json', repo);
  const htmlUrl = assetUrl(release, 'game.html', repo);
  if (!infoUrl || !htmlUrl) return null;
  const infoRes = await fetch(infoUrl);
  if (!infoRes.ok) return null;
  const info = await infoRes.json();
  const build = Number(info.build) || 0;
  const needShell = Number(info.shell) || 1;
  if (build <= currentBuild) return null;
  if (needShell > shellVersion) return { kind: 'app', build };
  const htmlRes = await fetch(htmlUrl);
  if (!htmlRes.ok) return null;
  const html = await htmlRes.text();
  if (!looksLikeGame(html)) return null;
  fs.mkdirSync(updatesDir, { recursive: true });
  // Write, then rename: a half-downloaded file is never picked up.
  const tmp = path.join(updatesDir, 'index.html.part');
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, path.join(updatesDir, 'index.html'));
  fs.writeFileSync(path.join(updatesDir, 'build.json'), JSON.stringify({ build, shell: needShell }));
  return { kind: 'game', build };
}

module.exports = { readBuild, pickGame, assetUrl, looksLikeGame, checkForUpdate };
