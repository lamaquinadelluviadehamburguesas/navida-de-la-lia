import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectBrowser } from './browser-smoke.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Exercise the real HTML/CSS/gallery module while blocking main.js and all Firebase startup. */
export async function runGallerySmoke({
  url = process.env.SMOKE_URL || 'http://127.0.0.1:5173/',
  screenshotPath = process.env.SMOKE_SCREENSHOT,
  desktopScreenshot = process.env.SMOKE_DESKTOP_SCREENSHOT,
  mobileScreenshot = process.env.SMOKE_MOBILE_SCREENSHOT
} = {}) {
  const browser = await connectBrowser();
  const checks = [];
  let currentCheck = 'fixture setup';
  const check = async (name, callback) => {
    currentCheck = name;
    await callback();
    checks.push(name);
  };
  const card = id => `.media-card[data-id="${id}"]`;
  const visibleCount = () => browser.evaluate("document.querySelectorAll('.media-card:not([hidden])').length");
  try {
    // Never execute main.js: it starts the real Firestore library and imports default assets.
    await browser.send('Network.setBlockedURLs', { urls: ['*/src/main.js*', '*/@vite/client*'] });
    await browser.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await browser.resize(1440, 900);
    await browser.navigate(url);
    await browser.waitFor("document.readyState === 'complete' && Boolean(document.querySelector('#menu-toggle'))");
    assert.equal(await browser.evaluate("typeof window.STATE === 'undefined'"), true,
      'Fixture safety check failed: main.js executed.');
    await browser.evaluate(`(async () => {
      document.querySelector('#loader')?.remove();
      location.hash = '#arbol';
      const { setupGallery } = await import('/src/gallery.js');
      const readAsDataURL = async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Missing fixture asset: ' + url);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      };
      const [photo, video] = await Promise.all([
        readAsDataURL('/photos/magic_focusee.jpg'), readAsDataURL('/background.mp4')
      ]);
      const items = [
        { id: 'fixture-photo', name: 'Recuerdo familiar.jpg', type: 'image', mimeType: 'image/jpeg', size: 47041, status: 'ready', source: 'upload' },
        { id: 'fixture-video', name: 'Navidad.mp4', type: 'video', mimeType: 'video/mp4', size: 2488992, status: 'ready', source: 'upload' },
        { id: 'fixture-retry', name: '<img src=x onerror=window.__unsafeName=true>.jpg', type: 'image', mimeType: 'image/jpeg', size: 47041, status: 'ready', source: 'upload' }
      ];
      const state = window.__galleryFixture = {
        items, deleted: [], fileNames: [], loads: [], views: [], retries: 0,
        failDelete: true, failPreview: true
      };
      const gallery = state.gallery = setupGallery({
        onFiles: async files => { state.fileNames.push(...files.map(file => file.name)); },
        onDelete: async item => {
          await new Promise(resolve => setTimeout(resolve, 80));
          if (item.id === 'fixture-video' && state.failDelete) throw new Error('Error de eliminación simulado. Reintenta.');
          state.deleted.push(item.id);
          state.items = state.items.filter(current => current.id !== item.id);
          gallery.setItems(state.items);
        },
        onLoadMedia: async item => {
          state.loads.push(item.id);
          if (item.id === 'fixture-retry' && state.failPreview) throw new Error('Error de vista previa simulado.');
          return item.type === 'video' ? video : photo;
        },
        onViewChange: view => state.views.push(view),
        onRetry: () => { state.retries++; gallery.setStatus({ message: 'Galería de prueba conectada.', busy: false }); }
      });
      gallery.setItems(items);
      gallery.setStatus({ message: 'Galería de prueba conectada.', busy: false });
      return true;
    })()`, { timeout: 20_000 });

    await check('fixtures isolated from Firebase and previews lazy in tree view', async () => {
      assert.equal(await browser.evaluate('window.__galleryFixture.loads.length'), 0);
      assert.equal(await browser.evaluate('document.body.dataset.view'), 'tree');
      assert.equal(await browser.evaluate("document.querySelector('#gallery-view').hidden"), true);
      assert.equal(await browser.evaluate("document.querySelector('#file-input').accept"), 'image/*,video/*');
    });

    await check('hamburger opens by keyboard; Escape closes and restores focus', async () => {
      await browser.evaluate("document.querySelector('#menu-toggle').focus()");
      await browser.key('Enter');
      await browser.waitFor("document.querySelector('#controls-menu').open");
      assert.equal(await browser.evaluate("document.querySelector('#menu-toggle').getAttribute('aria-expanded')"), 'true');
      assert.equal(await browser.evaluate("document.querySelector('#controls-menu').contains(document.activeElement)"), true);
      await browser.key('Escape');
      await browser.waitFor("!document.querySelector('#controls-menu').open");
      assert.equal(await browser.evaluate('document.activeElement.id'), 'menu-toggle');
    });

    await check('gallery navigation closes menu and loads Base64 image/video', async () => {
      await browser.click('#menu-toggle');
      await browser.click('#gallery-btn');
      await browser.waitFor("document.body.dataset.view === 'gallery' && !document.querySelector('#controls-menu').open");
      assert.equal(await visibleCount(), 3);
      await browser.waitFor("document.querySelector('.media-card[data-id=\"fixture-photo\"] img').complete && document.querySelector('.media-card[data-id=\"fixture-photo\"] img').naturalWidth > 0");
      await browser.waitFor("document.querySelector('.media-card[data-id=\"fixture-video\"] video').readyState >= 1", { timeout: 15_000 });
      await browser.evaluate("document.querySelector('.media-card[data-id=\"fixture-video\"] video').play()", { timeout: 15_000 });
      await browser.waitFor("document.querySelector('.media-card[data-id=\"fixture-video\"] video').currentTime > 0.1 && document.querySelector('.media-card[data-id=\"fixture-video\"] video').readyState >= 2", { timeout: 15_000 });
      await browser.evaluate("document.querySelector('.media-card[data-id=\"fixture-video\"] video').pause()");
      const media = await browser.evaluate(`(() => {
        const image = document.querySelector(${JSON.stringify(`${card('fixture-photo')} img`)});
        const video = document.querySelector(${JSON.stringify(`${card('fixture-video')} video`)});
        return { image: image.src.startsWith('data:image/jpeg;base64,'),
          video: video.src.startsWith('data:video/mp4;base64,'), controls: video.controls,
          playsInline: video.playsInline, preload: video.preload };
      })()`);
      assert.deepEqual(media, { image: true, video: true, controls: true, playsInline: true, preload: 'metadata' });
      assert.equal(await browser.evaluate("document.querySelector('#count-all').textContent"), '3');
    });

    await check('preview error has a working retry; file names are rendered as text', async () => {
      const retrySelector = `${card('fixture-retry')} .preview-retry`;
      await browser.evaluate(`document.querySelector(${JSON.stringify(card('fixture-retry'))}).scrollIntoView({block:'center'})`);
      await browser.waitFor(`!document.querySelector(${JSON.stringify(retrySelector)}).hidden`);
      await browser.evaluate('window.__galleryFixture.failPreview = false');
      await browser.click(retrySelector);
      await browser.waitFor(`document.querySelector(${JSON.stringify(`${card('fixture-retry')} img`)}).naturalWidth > 0`);
      assert.equal(await browser.evaluate("Boolean(window.__unsafeName)"), false);
      assert.equal(await browser.evaluate(`${JSON.stringify('<img src=x onerror=window.__unsafeName=true>.jpg')} === document.querySelector(${JSON.stringify(`${card('fixture-retry')} .media-name`)}).textContent`), true);
    });

    if (desktopScreenshot || mobileScreenshot) {
      await browser.evaluate("document.querySelector('#gallery-view').scrollTop = 0");
      if (desktopScreenshot) {
        await mkdir(dirname(desktopScreenshot), { recursive: true });
        await browser.screenshot(desktopScreenshot);
      }
      if (mobileScreenshot) {
        await browser.resize(390, 844, { mobile: true });
        await pause(120);
        await browser.evaluate("document.querySelector('#gallery-view').scrollTop = 0");
        await mkdir(dirname(mobileScreenshot), { recursive: true });
        await browser.screenshot(mobileScreenshot);
        await browser.resize(1440, 900);
      }
    }

    await check('photo/video filters update visible cards', async () => {
      await browser.click('[data-filter="video"]');
      assert.equal(await visibleCount(), 1);
      assert.equal(await browser.evaluate("document.querySelector('[data-filter=video]').getAttribute('aria-pressed')"), 'true');
      await browser.click('[data-filter="image"]');
      assert.equal(await visibleCount(), 2);
      await browser.click('[data-filter="all"]');
      assert.equal(await visibleCount(), 3);
    });

    await check('delete cancellation keeps the item', async () => {
      await browser.click(`${card('fixture-photo')} .delete-media-btn`);
      await browser.waitFor(`!document.querySelector(${JSON.stringify(`${card('fixture-photo')} .delete-confirmation`)}).hidden`);
      await browser.click(`${card('fixture-photo')} .delete-actions button:not(.confirm-delete-btn)`);
      assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${card('fixture-photo')} .delete-confirmation`)}).hidden`), true);
      assert.equal(await browser.evaluate('window.__galleryFixture.deleted.length'), 0);
    });

    await check('confirmed deletion removes item and updates counts', async () => {
      await browser.click(`${card('fixture-photo')} .delete-media-btn`);
      await browser.click(`${card('fixture-photo')} .confirm-delete-btn`);
      await browser.waitFor(`!document.querySelector(${JSON.stringify(card('fixture-photo'))})`);
      assert.equal(await browser.evaluate("document.querySelector('#count-all').textContent"), '2');
      assert.deepEqual(await browser.evaluate('window.__galleryFixture.deleted'), ['fixture-photo']);
    });

    await check('failed deletion preserves card and supports retry', async () => {
      await browser.click(`${card('fixture-video')} .delete-media-btn`);
      await browser.click(`${card('fixture-video')} .confirm-delete-btn`);
      await browser.waitFor(`!document.querySelector(${JSON.stringify(`${card('fixture-video')} .delete-error`)}).hidden`);
      assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${card('fixture-video')} .delete-error`)}).textContent`), 'Error de eliminación simulado. Reintenta.');
      assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(`${card('fixture-video')} .confirm-delete-btn`)}).disabled`), false);
      await browser.evaluate('window.__galleryFixture.failDelete = false');
      await browser.click(`${card('fixture-video')} .confirm-delete-btn`);
      await browser.waitFor(`!document.querySelector(${JSON.stringify(card('fixture-video'))})`);
    });

    await check('connection error and retry are explicit', async () => {
      await browser.evaluate("window.__galleryFixture.gallery.setStatus({message:'Permiso denegado de prueba.',error:true,busy:false})");
      assert.equal(await browser.evaluate("document.querySelector('#gallery-status').dataset.error"), 'true');
      assert.equal(await browser.evaluate("document.querySelector('#gallery-status-message').textContent"), 'Permiso denegado de prueba.');
      await browser.click('#gallery-retry');
      await browser.waitFor('window.__galleryFixture.retries === 1');
      assert.equal(await browser.evaluate("document.querySelector('#gallery-retry').hidden"), true);
    });

    await check('390px layout keeps menu and navigation hit targets reachable', async () => {
      await browser.resize(390, 844, { mobile: true });
      await pause(100);
      await browser.click('#menu-toggle');
      await browser.click('#tree-link');
      await browser.waitFor("document.body.dataset.view === 'tree'");
      assert.equal(await browser.evaluate('getComputedStyle(document.querySelector("#webcam-wrapper")).display'), 'none');
      await browser.click('#menu-toggle');
      await browser.click('#gallery-btn');
      await browser.waitFor("document.body.dataset.view === 'gallery'");
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true,
        'The page overflows horizontally at 390px.');
      await browser.click('[data-filter="video"]');
      assert.equal(await browser.evaluate("document.querySelector('#gallery-empty').hidden"), false);
      await browser.click('[data-filter="all"]');
      await browser.click(`${card('fixture-retry')} .delete-media-btn`);
      await browser.click(`${card('fixture-retry')} .delete-actions button:not(.confirm-delete-btn)`);
    });

    await check('file picker forwards image/video files and clears the input', async () => {
      const names = await browser.evaluate(`(async () => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['photo'], 'nueva-foto.jpg', {type:'image/jpeg'}));
        transfer.items.add(new File(['video'], 'nuevo-video.mp4', {type:'video/mp4'}));
        const input = document.querySelector('#file-input');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', {bubbles:true}));
        await new Promise(resolve => setTimeout(resolve, 30));
        return { names: window.__galleryFixture.fileNames, value: input.value };
      })()`);
      assert.deepEqual(names, { names: ['nueva-foto.jpg', 'nuevo-video.mp4'], value: '' });
    });

    if (screenshotPath) await browser.screenshot(screenshotPath);
    const exceptions = browser.diagnostics.exceptions;
    assert.equal(exceptions.length, 0, 'Unexpected browser JavaScript exception.');
    return { ok: true, isolatedFromFirebase: true, checks,
      snapshot: await browser.snapshot(), diagnostics: browser.diagnostics };
  } catch (error) {
    error.message = `${currentCheck}: ${error.message}`;
    error.smoke = { checks, diagnostics: browser.diagnostics };
    try { error.smoke.snapshot = await browser.snapshot(); } catch { /* The target may have disconnected. */ }
    throw error;
  } finally {
    try { await browser.evaluate('window.__galleryFixture?.gallery.destroy()'); } catch { /* No fixture on early failure. */ }
    // Leave no live Vite document that could execute real startup on a later HMR reload.
    try { await browser.navigate('about:blank'); } catch { /* Already disconnected. */ }
    try { await browser.send('Network.setBlockedURLs', { urls: [] }); } catch { /* Already disconnected. */ }
    browser.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runGallerySmoke().then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => {
      console.error(JSON.stringify({ error: error.message, ...error.smoke }, null, 2));
      process.exitCode = 1;
    });
}
