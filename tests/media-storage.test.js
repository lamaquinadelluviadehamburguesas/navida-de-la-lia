import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const records = new Map();
let nextId = 0;
let commitCount = 0;
let failCommit = 0;
let observer;
let errorObserver;
let stageStatuses;
let requestSizes;
let transactionHook;
let authenticate;
let identityReady;
let collectionCalls;
let identityObserver;
let authStopCount;

const identity = {
  ensureGalleryUser: (...args) => authenticate(...args),
  onGalleryIdentityChange(ownerUid, callback) {
    identityObserver = user => { if (user?.uid !== ownerUid) callback(user); };
    return () => { identityObserver = null; authStopCount++; };
  }
};

function reference(path) {
  return { path, id: path.split('/').pop() };
}

function snapshot(ref, pending = false) {
  const exists = records.has(ref.path);
  const data = records.get(ref.path);
  return { id: ref.id, ref, metadata: { hasPendingWrites: pending }, exists: () => exists, data: () => data };
}

function applyWrites(writes, countRequest = false) {
  if (countRequest) {
    commitCount++;
    requestSizes.push(JSON.stringify(writes).length);
    if (commitCount === failCommit) throw Object.assign(new Error('Test write rejected'), { code: 'permission-denied' });
  }
  writes.forEach(write => {
    if (write.type === 'delete') records.delete(write.ref.path);
    else {
      records.set(write.ref.path, write.data);
      if (write.data.status) stageStatuses.push(write.data.status);
    }
  });
}

const firestore = {
  collection(parent, name) {
    assert.equal(identityReady, true, 'Firestore must wait for authentication');
    collectionCalls++;
    return reference(parent.path ? `${parent.path}/${name}` : name);
  },
  doc(parent, id = `upload-${++nextId}`) { return reference(`${parent.path}/${id}`); },
  serverTimestamp() { return 'SERVER_TIMESTAMP'; },
  async getDocFromServer(ref) { return snapshot(ref); },
  async getDocs(ref) {
    const prefix = `${ref.path}/`;
    return { docs: [...records.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')).map(path => snapshot(reference(path))) };
  },
  async runTransaction(db, operation) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const writes = [];
      const reads = new Map();
      const result = await operation({
        async get(ref) { reads.set(ref.path, records.get(ref.path)); return snapshot(ref); },
        set(ref, data) { writes.push({ type: 'set', ref, data }); },
        delete(ref) { writes.push({ type: 'delete', ref }); }
      });
      if (transactionHook?.when(writes)) {
        const hook = transactionHook;
        transactionHook = null;
        await hook.run(writes);
      }
      // Firestore reruns a transaction if a document read by it changed before commit.
      if ([...reads].some(([path, data]) => records.get(path) !== data)) continue;
      applyWrites(writes, writes.some(write => write.ref.path.includes('/chunks/')));
      return result;
    }
    throw new Error('Test transaction exceeded retry limit');
  },
  writeBatch() {
    const writes = [];
    return {
      set(ref, data) { writes.push({ type: 'set', ref, data }); },
      delete(ref) { writes.push({ type: 'delete', ref }); },
      async commit() {
        applyWrites(writes, true);
      }
    };
  },
  async updateDoc(ref, patch) {
    assert.ok(records.has(ref.path));
    records.set(ref.path, { ...records.get(ref.path), ...patch });
    if (patch.status) stageStatuses.push(patch.status);
  },
  async deleteDoc(ref) { records.delete(ref.path); },
  query(ref, ...constraints) { return { ref, constraints }; },
  where(...args) { return args; },
  onSnapshot(query, options, next, error) {
    assert.deepEqual(query.constraints, [['status', 'in', ['ready', 'deleting', 'deleted']]]);
    assert.equal(options.includeMetadataChanges, true);
    observer = next;
    errorObserver = error;
    return () => { observer = null; errorObserver = null; };
  }
};

globalThis.__mediaFirestoreTest = firestore;
globalThis.__mediaIdentityTest = identity;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/src/database/media.js')) {
      if (specifier === 'firebase/firestore') return { url: 'media-test:firestore', shortCircuit: true };
      if (specifier === './firebase.js') return { url: 'media-test:firebase', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'media-test:firebase') return { format: 'module', source: 'export const db = {}; export const ensureGalleryUser = globalThis.__mediaIdentityTest.ensureGalleryUser; export const onGalleryIdentityChange = globalThis.__mediaIdentityTest.onGalleryIdentityChange;', shortCircuit: true };
    if (url === 'media-test:firestore') {
      const source = Object.keys(firestore).map(name => `export const ${name} = globalThis.__mediaFirestoreTest.${name};`).join('\n');
      return { format: 'module', source, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});
const { uploadMedia, getMediaData, deleteMedia, subscribeMedia, seedDefaultMedia } = await import('../src/database/media.js');
hooks.deregister();
delete globalThis.__mediaFirestoreTest;
delete globalThis.__mediaIdentityTest;

async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

beforeEach(() => {
  records.clear();
  nextId = 0;
  commitCount = 0;
  failCommit = 0;
  stageStatuses = [];
  requestSizes = [];
  observer = null;
  errorObserver = null;
  transactionHook = null;
  authenticate = async () => { identityReady = true; return { uid: 'test-user' }; };
  identityReady = false;
  collectionCalls = 0;
  identityObserver = null;
  authStopCount = 0;
});

test('large video is split over bounded batches and becomes ready after all chunks', async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 5).fill(41);
  const file = new File([bytes], 'recuerdo.mp4', { type: 'video/mp4' });
  const item = await uploadMedia(file);
  assert.deepEqual(stageStatuses, ['uploading', 'ready']);
  assert.equal(item.type, 'video');
  assert.equal(item.status, 'ready');
  assert.ok(commitCount > 1);
  assert.ok(requestSizes.every(size => size < 4 * 1024 * 1024));
  const dataUrl = await getMediaData(item);
  assert.deepEqual(Buffer.from(dataUrl.split(',')[1], 'base64'), Buffer.from(bytes));
});

test('deleting an upload removes its parent and every stored chunk', async () => {
  const item = await uploadMedia(new File([new Uint8Array(1024 * 1024)], 'photo.png', { type: 'image/png' }));
  assert.ok(records.size > 1);
  await deleteMedia(item);
  assert.equal(records.size, 0);
});

test('deleting a default leaves only a tombstone and seeding cannot recreate it', async () => {
  const item = await uploadMedia(new File(['default'], 'default.jpg', { type: 'image/jpeg' }), { id: 'default-photo', source: 'builtin' });
  await deleteMedia(item);
  assert.equal(records.size, 1);
  assert.deepEqual(records.get('christmasMedia/test-user/files/default-photo'), { source: 'builtin', status: 'deleted', deletedAt: 'SERVER_TIMESTAMP' });
  await seedDefaultMedia([{ id: 'default-photo', url: 'never-fetch-this', name: 'default.jpg', type: 'image' }]);
  assert.equal(records.size, 1);
});

test('failed chunk write cleans staged metadata and reports the original error', async () => {
  failCommit = 1;
  await assert.rejects(uploadMedia(new File(['content'], 'photo.jpg', { type: 'image/jpeg' })), { code: 'permission-denied' });
  assert.equal(records.size, 0);
  assert.ok(!stageStatuses.includes('ready'));
});

test('subscription excludes pending writes and never includes Base64 payload', async () => {
  records.set('christmasMedia/test-user/files/confirmed', {
    name: 'confirmed.jpg', type: 'image', mimeType: 'image/jpeg', size: 3, source: 'upload',
    status: 'ready', chunkCount: 1, base64Length: 4, createdAtMs: 1, unexpectedPayload: 'secret'
  });
  records.set('christmasMedia/test-user/files/pending', { status: 'ready' });
  let result;
  let resultState;
  const stop = subscribeMedia((items, state) => { result = items; resultState = state; });
  await flush();
  observer({ docs: [snapshot(reference('christmasMedia/test-user/files/confirmed')), snapshot(reference('christmasMedia/test-user/files/pending'), true)], metadata: { fromCache: false, hasPendingWrites: true } });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'confirmed');
  assert.equal(result[0].unexpectedPayload, undefined);
  assert.deepEqual(resultState, { fromCache: false, hasPendingWrites: true, deletedIds: [] });
  stop();
  assert.equal(observer, null);
});

test('cancelled uploads fail before starting a Firestore write', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(uploadMedia(new File(['photo'], 'photo.jpg', { type: 'image/jpeg' }), { signal: controller.signal }), { code: 'media/cancelled' });
  assert.equal(records.size, 0);
});

test('failed deletion stays visible as deleting and can be completed in another session', async () => {
  const item = await uploadMedia(new File([new Uint8Array(4 * 1024 * 1024)], 'clip.mp4', { type: 'video/mp4' }));
  // Delete the first chunk batch, then simulate a rejected second batch.
  failCommit = commitCount + 2;
  await assert.rejects(deleteMedia(item), { code: 'permission-denied' });
  assert.equal(records.get(`christmasMedia/test-user/files/${item.id}`).status, 'deleting');
  let recovered;
  const stop = subscribeMedia(items => { recovered = items; });
  await flush();
  observer({ docs: [snapshot(reference(`christmasMedia/test-user/files/${item.id}`))], metadata: { fromCache: false, hasPendingWrites: false } });
  assert.equal(recovered[0].status, 'deleting');
  failCommit = 0;
  await deleteMedia(recovered[0]);
  assert.equal(records.size, 0);
  stop();
});

test('deleting a not-yet-imported default creates a tombstone atomically', async () => {
  await deleteMedia({ id: 'default-not-imported', source: 'builtin' });
  assert.deepEqual(records.get('christmasMedia/test-user/files/default-not-imported'), { source: 'builtin', status: 'deleted', deletedAt: 'SERVER_TIMESTAMP' });
  await seedDefaultMedia([{ id: 'default-not-imported', url: 'never-fetch-this', name: 'default.jpg', type: 'image' }]);
  assert.equal(records.size, 1);
});

test('deleting a default during its seed prevents further chunk writes and preserves the tombstone', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(1024 * 1024), { headers: { 'Content-Type': 'image/jpeg' } });
  transactionHook = {
    when: writes => writes.some(write => write.ref.path.includes('/chunks/')),
    run: () => deleteMedia({ id: 'default-in-flight', source: 'builtin' })
  };
  try {
    await assert.rejects(seedDefaultMedia([{ id: 'default-in-flight', url: '/default.jpg', name: 'default.jpg', type: 'image' }]), { code: 'media/cancelled' });
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(records.size, 1);
  assert.equal(records.get('christmasMedia/test-user/files/default-in-flight').status, 'deleted');
  assert.ok(!stageStatuses.includes('ready'));
});

test('deleting after chunks but before ready cannot resurrect a default', async () => {
  transactionHook = {
    when: writes => writes.some(write => write.data?.status === 'ready'),
    run: () => deleteMedia({ id: 'default-at-finalize', source: 'builtin' })
  };
  await assert.rejects(uploadMedia(new File(['default'], 'default.jpg', { type: 'image/jpeg' }), { id: 'default-at-finalize', source: 'builtin' }), { code: 'media/cancelled' });
  assert.equal(records.size, 1);
  assert.equal(records.get('christmasMedia/test-user/files/default-at-finalize').status, 'deleted');
  assert.ok(!stageStatuses.includes('ready'));
});

test('cleanup from an old upload cannot remove another owner or its chunks', async () => {
  transactionHook = {
    when: writes => writes.some(write => write.ref.path.includes('/chunks/')),
    run: () => {
      const path = 'christmasMedia/test-user/files/default-new-owner';
      records.set(path, { ...records.get(path), uploadToken: 'replacement-owner' });
      records.set(`${path}/chunks/replacement-owner_0000`, { index: 0, data: 'bmV3', uploadToken: 'replacement-owner' });
    }
  };
  await assert.rejects(uploadMedia(new File(['old'], 'default.jpg', { type: 'image/jpeg' }), { id: 'default-new-owner', source: 'builtin' }), { code: 'media/cancelled' });
  assert.equal(records.get('christmasMedia/test-user/files/default-new-owner').uploadToken, 'replacement-owner');
  assert.equal(records.get('christmasMedia/test-user/files/default-new-owner').status, 'uploading');
  assert.ok(records.has('christmasMedia/test-user/files/default-new-owner/chunks/replacement-owner_0000'));
});

test('a recent in-progress default import never reports every default as imported', async () => {
  records.set('christmasMedia/test-user/files/default-pending', { status: 'uploading', source: 'builtin', createdAtMs: Date.now() });
  records.set('christmasMedia/test-user/files/default-ready', { status: 'ready', source: 'builtin' });
  await assert.rejects(seedDefaultMedia([
    { id: 'default-pending', url: 'never-fetch-this', name: 'pending.jpg', type: 'image' },
    { id: 'default-ready', url: 'never-fetch-this-either', name: 'ready.jpg', type: 'image' }
  ]), { code: 'media/import-pending' });
  assert.equal(records.get('christmasMedia/test-user/files/default-pending').status, 'uploading');
  assert.equal(records.get('christmasMedia/test-user/files/default-ready').status, 'ready');
});

test('subscription reports confirmed tombstone IDs without returning deleted cards', async () => {
  records.set('christmasMedia/test-user/files/deleted-default', { source: 'builtin', status: 'deleted' });
  records.set('christmasMedia/test-user/files/pending-deletion', { source: 'builtin', status: 'deleted' });
  records.set('christmasMedia/test-user/files/visible', { source: 'builtin', status: 'ready' });
  let items;
  let metadata;
  const stop = subscribeMedia((nextItems, nextMetadata) => { items = nextItems; metadata = nextMetadata; });
  await flush();
  observer({
    docs: [snapshot(reference('christmasMedia/test-user/files/deleted-default')), snapshot(reference('christmasMedia/test-user/files/pending-deletion'), true), snapshot(reference('christmasMedia/test-user/files/visible'))],
    metadata: { fromCache: false, hasPendingWrites: true }
  });
  assert.deepEqual(items.map(item => item.id), ['visible']);
  assert.deepEqual(metadata.deletedIds, ['deleted-default']);
  stop();
});

test('uploads wait for restored authentication before constructing Firestore paths', async () => {
  let resolveIdentity;
  authenticate = () => new Promise(resolve => { resolveIdentity = user => { identityReady = true; resolve(user); }; });
  const upload = uploadMedia(new File(['photo'], 'private.jpg', { type: 'image/jpeg' }));
  await flush();
  assert.equal(collectionCalls, 0);
  assert.equal(records.size, 0);
  resolveIdentity({ uid: 'restored-owner' });
  const saved = await upload;
  assert.equal(saved.ownerUid, 'restored-owner');
  assert.ok([...records.keys()].every(path => path.startsWith('christmasMedia/restored-owner/files/')));
});

test('authentication failure blocks reads, writes, deletes and default imports', async () => {
  authenticate = async () => { throw Object.assign(new Error('Enable anonymous authentication'), { code: 'auth/operation-not-allowed' }); };
  const file = new File(['photo'], 'private.jpg', { type: 'image/jpeg' });
  const attempts = [uploadMedia(file), getMediaData({ id: 'old' }), deleteMedia({ id: 'old' }), seedDefaultMedia([])];
  for (const attempt of attempts) await assert.rejects(attempt, { code: 'auth/operation-not-allowed' });
  assert.equal(collectionCalls, 0);
  assert.equal(records.size, 0);
});

test('subscription reports authentication failure without starting a Firestore listener', async () => {
  authenticate = async () => { throw Object.assign(new Error('Auth denied'), { code: 'auth/operation-not-allowed' }); };
  const errors = [];
  const stop = subscribeMedia(() => assert.fail('No private data may be emitted'), error => errors.push(error));
  await flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'auth/operation-not-allowed');
  assert.equal(observer, null);
  assert.equal(identityObserver, null);
  assert.equal(collectionCalls, 0);
  stop();
});

test('unsubscribe before authentication resolves never attaches either listener', async () => {
  let resolveIdentity;
  authenticate = () => new Promise(resolve => { resolveIdentity = user => { identityReady = true; resolve(user); }; });
  const stop = subscribeMedia(() => assert.fail('Cancelled subscription emitted data'), () => assert.fail('Cancelled subscription emitted an error'));
  stop();
  resolveIdentity({ uid: 'test-user' });
  await flush();
  assert.equal(observer, null);
  assert.equal(identityObserver, null);
});

test('changing identity closes both listeners and suppresses queued private snapshots', async () => {
  let emitted = 0;
  const errors = [];
  const stop = subscribeMedia(() => { emitted++; }, error => errors.push(error));
  await flush();
  const queuedSnapshot = observer;
  identityObserver({ uid: 'different-user' });
  assert.equal(observer, null);
  assert.equal(identityObserver, null);
  assert.equal(authStopCount, 1);
  assert.equal(errors[0].code, 'media/session-changed');
  queuedSnapshot({ docs: [], metadata: { fromCache: false, hasPendingWrites: false } });
  assert.equal(emitted, 0);
  stop();
  assert.equal(authStopCount, 1);
});

test('stale gallery items cannot read or delete a different user scope', async () => {
  const oldItem = { id: 'photo', ownerUid: 'previous-user' };
  await assert.rejects(getMediaData(oldItem), { code: 'media/session-changed' });
  await assert.rejects(deleteMedia(oldItem), { code: 'media/session-changed' });
  assert.equal(collectionCalls, 0);
  assert.equal(records.size, 0);
});
