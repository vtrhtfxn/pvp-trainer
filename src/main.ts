import '@fontsource/pixelify-sans/latin-400.css';
import '@fontsource/pixelify-sans/latin-600.css';
import '@fontsource/pixelify-sans/latin-700.css';
import './styles.css';
import { Game } from './game/Game';
import { loadAssets } from './render/assets';
import { loadSettings } from './ui/settings';

async function main() {
  const loading = document.getElementById('loading')!;
  const text = loading.querySelector('.loading-text')!;
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('400 16px "Pixelify Sans"'),
        document.fonts.load('600 16px "Pixelify Sans"'),
        document.fonts.load('700 16px "Pixelify Sans"'),
      ]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
    const assets = await loadAssets();
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const ui = document.getElementById('ui')!;
    const game = new Game(canvas, ui, assets, loadSettings());
    (window as unknown as { __pvp: Game }).__pvp = game;
    loading.classList.add('done');
    setTimeout(() => loading.remove(), 600);
  } catch (err) {
    console.error(err);
    text.textContent = `Failed to start: ${(err as Error).message}`;
  }
}

void main();
