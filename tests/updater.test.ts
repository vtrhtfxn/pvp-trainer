import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const updater = require('../electron/updater.cjs') as {
  readBuild(dir: string): { build: number; shell: number };
  pickGame(o: { bundledDir: string; updatesDir: string; shellVersion: number; allowUpdates: boolean }): { dir: string; build: number; shell: number };
  assetUrl(release: unknown, name: string, repo: string): string | null;
  looksLikeGame(html: string): boolean;
  checkForUpdate(o: { fetch: (url: string) => Promise<Response>; repo: string; currentBuild: number; shellVersion: number; updatesDir: string }): Promise<{ kind: string; build: number } | null>;
};

const REPO = 'vtrhtfxn/pvp-trainer';
const GAME_HTML = `<!doctype html><html><head><title>PvP Trainer</title></head><body>${'x'.repeat(300_000)}</body></html>`;

function dir(files: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'pvp-upd-'));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
}

/** A fake GitHub: the latest release with build.json and game.html. */
function github(build: number, shell: number, html = GAME_HTML) {
  const dl = (n: string) => `https://github.com/${REPO}/releases/download/build-${build}/${n}`;
  const routes: Record<string, () => Response> = {
    [`https://api.github.com/repos/${REPO}/releases/latest`]: () => Response.json({ tag_name: `build-${build}`, assets: [{ name: 'build.json', browser_download_url: dl('build.json') }, { name: 'game.html', browser_download_url: dl('game.html') }] }),
    [dl('build.json')]: () => Response.json({ build, shell }),
    [dl('game.html')]: () => new Response(html),
  };
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    return routes[url]?.() ?? new Response('not found', { status: 404 });
  };
  return { fetch, asked };
}

describe('desktop app updater', () => {
  it('downloads a newer game and runs it from the next start', async () => {
    const bundled = dir({ 'index.html': 'old', 'build.json': JSON.stringify({ build: 3, shell: 2 }) });
    const updates = join(dir(), 'game');
    const gh = github(7, 2);
    const r = await updater.checkForUpdate({ fetch: gh.fetch, repo: REPO, currentBuild: 3, shellVersion: 2, updatesDir: updates });
    expect(r).toEqual({ kind: 'game', build: 7 });
    expect(readFileSync(join(updates, 'index.html'), 'utf8')).toBe(GAME_HTML);
    expect(existsSync(join(updates, 'index.html.part'))).toBe(false);
    const picked = updater.pickGame({ bundledDir: bundled, updatesDir: updates, shellVersion: 2, allowUpdates: true });
    expect(picked).toEqual({ dir: updates, build: 7, shell: 2 });
    // `npm run app` (not packaged) always runs your own build.
    expect(updater.pickGame({ bundledDir: bundled, updatesDir: updates, shellVersion: 2, allowUpdates: false }).dir).toBe(bundled);
  });

  it('does nothing when already up to date', async () => {
    const gh = github(7, 2);
    const updates = join(dir(), 'game');
    expect(await updater.checkForUpdate({ fetch: gh.fetch, repo: REPO, currentBuild: 7, shellVersion: 2, updatesDir: updates })).toBeNull();
    expect(gh.asked.some((u) => u.endsWith('game.html'))).toBe(false);
  });

  it('a game that needs a newer app is not downloaded — it asks for the app instead', async () => {
    const gh = github(9, 3);
    const updates = join(dir(), 'game');
    expect(await updater.checkForUpdate({ fetch: gh.fetch, repo: REPO, currentBuild: 7, shellVersion: 2, updatesDir: updates })).toEqual({ kind: 'app', build: 9 });
    expect(existsSync(join(updates, 'index.html'))).toBe(false);
  });

  it('an older app never picks a cached game built for a newer shell', () => {
    const bundled = dir({ 'index.html': 'old', 'build.json': JSON.stringify({ build: 3, shell: 2 }) });
    const updates = dir({ 'index.html': GAME_HTML, 'build.json': JSON.stringify({ build: 9, shell: 3 }) });
    expect(updater.pickGame({ bundledDir: bundled, updatesDir: updates, shellVersion: 2, allowUpdates: true }).dir).toBe(bundled);
  });

  it('rejects downloads that are not our game, and assets from anywhere else', async () => {
    const bad = github(8, 2, '<html>hello</html>');
    const updates = join(dir(), 'game');
    expect(await updater.checkForUpdate({ fetch: bad.fetch, repo: REPO, currentBuild: 7, shellVersion: 2, updatesDir: updates })).toBeNull();
    expect(existsSync(join(updates, 'index.html'))).toBe(false);
    expect(updater.assetUrl({ assets: [{ name: 'game.html', browser_download_url: 'https://evil.example/game.html' }] }, 'game.html', REPO)).toBeNull();
    expect(updater.assetUrl({ assets: [{ name: 'game.html', browser_download_url: `https://github.com/someone/else/releases/download/x/game.html` }] }, 'game.html', REPO)).toBeNull();
    expect(updater.looksLikeGame(GAME_HTML)).toBe(true);
  });

  it('survives GitHub being down', async () => {
    const down = async () => new Response('', { status: 503 });
    expect(await updater.checkForUpdate({ fetch: down, repo: REPO, currentBuild: 1, shellVersion: 2, updatesDir: join(dir(), 'game') })).toBeNull();
  });

  it('the shell version the app checks against exists and is a number', () => {
    const v = JSON.parse(readFileSync(join(__dirname, '..', 'electron', 'shell-version.json'), 'utf8'));
    expect(Number.isInteger(v.shell)).toBe(true);
    expect(updater.readBuild(dir()).build).toBe(0);
  });
});
