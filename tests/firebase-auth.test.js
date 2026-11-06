import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

let state;
const appMock = { name: '[DEFAULT]' };
const authMock = {
  currentUser: null,
  authStateReady: () => state.restore()
};
const services = {
  getApps: () => [appMock],
  initializeApp: () => assert.fail('The existing application must be reused'),
  getAuth: () => authMock,
  getFirestore: app => ({ app }),
  signInAnonymously: async () => {
    state.signInCalls++;
    return state.signIn();
  },
  onAuthStateChanged: (auth, callback) => {
    assert.equal(auth, authMock);
    state.observer = callback;
    return () => { state.observer = null; };
  }
};

globalThis.__firebaseAuthTest = services;
const modules = {
  'firebase/app': ['getApps', 'initializeApp'],
  'firebase/auth': ['getAuth', 'signInAnonymously', 'onAuthStateChanged'],
  'firebase/firestore': ['getFirestore']
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/src/database/firebase.js') && modules[specifier]) {
      return { url: `firebase-auth-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('firebase-auth-test:')) {
      const names = modules[url.slice('firebase-auth-test:'.length)];
      return { format: 'module', shortCircuit: true,
        source: names.map(name => `export const ${name} = globalThis.__firebaseAuthTest.${name};`).join('\n') };
    }
    return nextLoad(url, context);
  }
});
const { app, auth, db, ensureGalleryUser, onGalleryIdentityChange } = await import('../src/database/firebase.js');
hooks.deregister();
delete globalThis.__firebaseAuthTest;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  authMock.currentUser = null;
  state = {
    signInCalls: 0,
    observer: null,
    async restore() {},
    async signIn() {
      const user = { uid: 'anonymous-owner', isAnonymous: true };
      authMock.currentUser = user;
      return { user };
    }
  };
});

test('Firebase services reuse the existing application', () => {
  assert.equal(app, appMock);
  assert.equal(auth, authMock);
  assert.equal(db.app, appMock);
});

test('an existing signed-in user is restored before deciding to create an anonymous account', async () => {
  const restored = deferred();
  state.restore = () => restored.promise;
  const session = ensureGalleryUser();
  assert.equal(state.signInCalls, 0);
  const realUser = { uid: 'existing-owner', isAnonymous: false };
  authMock.currentUser = realUser;
  restored.resolve();
  assert.equal(await session, realUser);
  assert.equal(state.signInCalls, 0);
});

test('concurrent gallery operations create only one anonymous session', async () => {
  const anonymousSignIn = deferred();
  state.signIn = () => anonymousSignIn.promise;
  const first = ensureGalleryUser();
  const second = ensureGalleryUser();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(state.signInCalls, 1);
  const user = { uid: 'one-owner', isAnonymous: true };
  authMock.currentUser = user;
  anonymousSignIn.resolve({ user });
  assert.equal(await first, user);
  assert.equal(await second, user);
  assert.equal(await ensureGalleryUser(), user);
  assert.equal(state.signInCalls, 1);
});

test('a failed sign-in may be retried after the provider is enabled', async () => {
  state.signIn = async () => { throw Object.assign(new Error('Provider disabled'), { code: 'auth/operation-not-allowed' }); };
  await assert.rejects(ensureGalleryUser(), { code: 'auth/operation-not-allowed' });
  const user = { uid: 'retry-owner', isAnonymous: true };
  state.signIn = async () => { authMock.currentUser = user; return { user }; };
  assert.equal(await ensureGalleryUser(), user);
  assert.equal(state.signInCalls, 2);
});

test('identity observer ignores the same user and reports sign-out or another user', () => {
  const changes = [];
  const stop = onGalleryIdentityChange('owner', user => changes.push(user?.uid || null));
  state.observer({ uid: 'owner' });
  state.observer({ uid: 'owner', tokenRefreshed: true });
  assert.deepEqual(changes, []);
  state.observer(null);
  state.observer({ uid: 'other-owner' });
  assert.deepEqual(changes, [null, 'other-owner']);
  stop();
  assert.equal(state.observer, null);
});
