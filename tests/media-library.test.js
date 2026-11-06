import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

let state;
const operations = {
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  uploadMedia: (...args) => state.uploadMedia(...args),
  deleteMedia: (...args) => state.deleteMedia(...args),
  getMediaData: (...args) => state.getMediaData(...args),
  seedDefaultMedia: (...args) => state.seedDefaultMedia(...args),
  subscribeMedia: (...args) => state.subscribeMedia(...args),
  setupGallery: callbacks => {
    state.callbacks = callbacks;
    return {
      setItems: items => state.items.push(items.map(item => ({ ...item }))),
      setStatus: status => state.statuses.push({ ...status }),
      setUploadProgress: message => state.progress.push(message),
      destroy: () => { state.galleryDestroyed++; }
    };
  }
};

globalThis.__mediaLibraryTest = operations;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/src/media-library.js')) {
      if (specifier === './database/media.js') return { url: 'media-library-test:storage', shortCircuit: true };
      if (specifier === './gallery.js') return { url: 'media-library-test:gallery', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'media-library-test:storage' || url === 'media-library-test:gallery') {
      const names = url.endsWith(':gallery') ? ['setupGallery']
        : ['MAX_FILE_SIZE', 'uploadMedia', 'deleteMedia', 'getMediaData', 'seedDefaultMedia', 'subscribeMedia'];
      return { format: 'module', source: names.map(name => `export const ${name} = globalThis.__mediaLibraryTest.${name};`).join('\n'), shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});
const { describeMediaError, setupMediaLibrary } = await import('../src/media-library.js');
hooks.deregister();
delete globalThis.__mediaLibraryTest;

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

function item(id, type = 'video') {
  return { id, type, name: `${id}.${type === 'image' ? 'png' : 'mp4'}`, mimeType: type === 'image' ? 'image/png' : 'video/mp4', size: 3, status: 'ready', source: 'upload', createdAtMs: 1 };
}

function createLibrary(defaults = []) {
  const instance = setupMediaLibrary({
    defaults,
    onImageAdded: (...args) => state.added.push(args),
    onImageRemoved: id => state.removed.push(id),
    onViewChange: view => state.views.push(view),
    onNotice: message => state.notices.push(message)
  });
  state.instances.push(instance);
  return instance;
}

function destroyLibrary(instance) {
  instance.destroy();
  state.instances = state.instances.filter(current => current !== instance);
}

function emit(items, metadata = { fromCache: false, hasPendingWrites: false }) {
  const subscription = state.subscriptions.at(-1);
  assert.ok(subscription.active);
  subscription.next(items, metadata);
}

function currentItems() { return state.items.at(-1) || []; }
function currentStatus() { return state.statuses.at(-1); }

beforeEach(() => {
  state = {
    callbacks: null, items: [], statuses: [], progress: [], added: [], removed: [], views: [], notices: [],
    instances: [], subscriptions: [], timers: new Set(), galleryDestroyed: 0, unsubscribeCount: 0, payloadRequests: [],
    async uploadMedia() { throw new Error('Unexpected upload'); },
    async deleteMedia() {},
    async getMediaData(file) { state.payloadRequests.push(file.id); return `data:${file.mimeType};base64,AQID`; },
    async seedDefaultMedia() {},
    subscribeMedia(next, error) {
      const subscription = { next, error, active: true };
      state.subscriptions.push(subscription);
      return () => { subscription.active = false; state.unsubscribeCount++; };
    }
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '' } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay };
    state.timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = timer => state.timers.delete(timer);
});

afterEach(() => {
  for (const instance of state.instances) instance.destroy();
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete globalThis.window;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
});

test('a rejected upload never becomes visible or announces a successful save', async () => {
  state.uploadMedia = async () => { throw Object.assign(new Error('Denied'), { code: 'permission-denied' }); };
  createLibrary();
  emit([]);
  await flush();
  await assert.rejects(state.callbacks.onFiles([new File(['abc'], 'photo.png', { type: 'image/png' })]), /Firebase no permite/);
  assert.equal(window.location.hash, '#galeria');
  assert.deepEqual(currentItems(), []);
  assert.equal(state.notices.length, 0);
  assert.equal(currentStatus().error, true);
  assert.match(currentStatus().message, /Firebase no permite/);
  assert.equal(state.progress.at(-1), '');
});

test('confirmed deleted defaults stay hidden even when another default cannot be imported', async () => {
  const builtin = { ...item('builtin-deleted-video'), source: 'builtin', url: '/example.mp4' };
  state.seedDefaultMedia = async () => { throw Object.assign(new Error('Denied'), { code: 'permission-denied' }); };
  createLibrary([builtin]);
  assert.equal(currentItems().length, 1);
  emit([], { fromCache: false, hasPendingWrites: false, deletedIds: [builtin.id] });
  await flush();
  assert.deepEqual(currentItems(), []);
  assert.equal(currentStatus().error, true);
});

test('acknowledged uploads stay visible until the server subscription catches up', async () => {
  const upload = deferred();
  state.uploadMedia = () => upload.promise;
  createLibrary();
  emit([]);
  await flush();
  const saved = item('new-video');
  const save = state.callbacks.onFiles([new File(['abc'], saved.name, { type: saved.mimeType })]);
  assert.deepEqual(currentItems(), []);
  assert.equal(currentStatus().busy, true);
  upload.resolve(saved);
  await save;
  assert.deepEqual(currentItems().map(file => file.id), [saved.id]);
  assert.equal(state.notices.filter(message => message.includes('guardado')).length, 1);
  emit([]);
  assert.deepEqual(currentItems().map(file => file.id), [saved.id]);
  emit([saved]);
  assert.deepEqual(currentItems().map(file => file.id), [saved.id]);
});

test('pending deletion survives subscription changes and an error leaves a retryable card', async () => {
  const deletion = deferred();
  state.deleteMedia = () => deletion.promise;
  createLibrary();
  const saved = item('retry-delete');
  emit([saved]);
  await flush();
  const remove = state.callbacks.onDelete(saved);
  emit([]);
  assert.deepEqual(currentItems().map(file => file.id), [saved.id]);
  emit([{ ...saved, status: 'deleting' }]);
  assert.deepEqual(currentItems().map(file => file.id), [saved.id]);
  deletion.reject(Object.assign(new Error('Delete denied'), { code: 'permission-denied' }));
  await assert.rejects(remove, /Firebase no permite/);
  assert.equal(currentItems()[0].status, 'deleting');
  assert.equal(state.notices.length, 0);
  state.deleteMedia = async () => {};
  await state.callbacks.onDelete(currentItems()[0]);
  assert.deepEqual(currentItems(), []);
  assert.deepEqual(state.notices, ['Archivo eliminado.']);
});

test('an external deletion removes the image from both gallery and scene', async () => {
  createLibrary();
  const saved = item('external-image', 'image');
  emit([saved]);
  await flush();
  assert.equal(state.added.length, 1);
  assert.equal(state.added[0][0].id, saved.id);
  assert.equal(state.added[0][1], 'data:image/png;base64,AQID');
  emit([]);
  assert.deepEqual(currentItems(), []);
  assert.deepEqual(state.removed, [saved.id]);
});

test('retry reconnects and reloads an image after a failed payload request', async () => {
  let attempts = 0;
  state.getMediaData = async file => {
    attempts++;
    if (attempts === 1) throw new Error('Temporary payload error');
    return `data:${file.mimeType};base64,AQID`;
  };
  createLibrary();
  emit([item('retry-preview', 'image')]);
  await flush();
  assert.equal(state.added.length, 0);
  assert.equal(state.notices.length, 1);
  state.callbacks.onRetry();
  await flush();
  assert.equal(state.subscriptions.length, 2);
  assert.equal(state.unsubscribeCount, 1);
  assert.equal(attempts, 2);
  assert.equal(state.added.length, 1);
});

test('a server snapshot does not announce a synchronized gallery before default seeding resolves', async () => {
  const seed = deferred();
  state.seedDefaultMedia = () => seed.promise;
  createLibrary();
  emit([]);
  await flush();
  assert.match(currentStatus().message, /Preparando los recuerdos/);
  assert.ok(state.statuses.every(status => status.message !== 'Galería sincronizada.'));
  seed.resolve();
  await flush();
  assert.equal(currentStatus().message, 'Galería sincronizada.');
});

test('destroy unsubscribes, clears connection timers and ignores late subscription or seed updates', async () => {
  const seed = deferred();
  state.seedDefaultMedia = () => seed.promise;
  const instance = createLibrary();
  assert.equal(state.timers.size, 1);
  const oldSubscription = state.subscriptions[0];
  destroyLibrary(instance);
  assert.equal(state.unsubscribeCount, 1);
  assert.equal(state.galleryDestroyed, 1);
  assert.equal(state.timers.size, 0);
  const updatesBefore = state.items.length;
  const statusesBefore = state.statuses.length;
  oldSubscription.next([item('late-video')], { fromCache: false, hasPendingWrites: false });
  seed.resolve();
  await flush();
  assert.equal(state.items.length, updatesBefore);
  assert.equal(state.statuses.length, statusesBefore);
});

test('destroy clears an in-flight upload timer and suppresses late save notices', async () => {
  const upload = deferred();
  state.uploadMedia = () => upload.promise;
  const instance = createLibrary();
  emit([]);
  await flush();
  const saved = item('late-upload');
  const save = state.callbacks.onFiles([new File(['abc'], saved.name, { type: saved.mimeType })]);
  assert.equal(state.timers.size, 1);
  destroyLibrary(instance);
  const timersAfterDestroy = state.timers.size;
  upload.resolve(saved);
  await save;
  assert.equal(timersAfterDestroy, 0, 'The waiting-for-upload timer must be cleared during destroy');
  assert.deepEqual(state.notices, [], 'A destroyed library must not announce a later upload');
});

test('Firebase Auth setup and network errors provide actionable messages', () => {
  for (const code of ['auth/operation-not-allowed', 'auth/admin-restricted-operation', 'auth/configuration-not-found']) {
    assert.match(describeMediaError({ code }), /Activa el proveedor Anónimo/);
  }
  assert.match(describeMediaError({ code: 'auth/network-request-failed' }), /No hay conexión/);
  assert.match(describeMediaError({ code: 'auth/unauthorized-domain' }), /Autoriza este dominio/);
});

test('identity changes clear private previews and reload before late data can appear', async () => {
  let reloads = 0;
  window.location.reload = () => { reloads++; };
  createLibrary();
  const photo = item('private-memory', 'image');
  emit([photo]);
  await flush();
  const subscription = state.subscriptions.at(-1);
  subscription.error(Object.assign(new Error('Session changed'), { code: 'media/session-changed' }));
  assert.equal(reloads, 1);
  assert.deepEqual(currentItems(), []);
  assert.deepEqual(state.removed, [photo.id]);
  assert.equal(state.galleryDestroyed, 1);
  assert.equal(state.timers.size, 0);
  const updateCount = state.items.length;
  subscription.next([photo], { fromCache: false });
  await flush();
  assert.equal(state.items.length, updateCount);
});
