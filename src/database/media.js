import {
  collection, doc, getDocFromServer, getDocs, onSnapshot,
  query, runTransaction, serverTimestamp, where, writeBatch
} from 'firebase/firestore';
import { db, ensureGalleryUser, onGalleryIdentityChange } from './firebase.js';
import { assembleMediaData, encodeMediaFile, mediaError, MAX_FILE_SIZE } from './media-codec.js';

export { MAX_FILE_SIZE };

const CHUNKS_PER_BATCH = 6; // At most 3.9 MB of Base64 in each request.
const STALE_UPLOAD_MS = 5 * 60 * 1000;

function requireConnection() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw mediaError('offline', 'No hay conexión. Conéctate a internet para guardar o eliminar archivos.');
  }
}

async function userMediaScope(item) {
  const user = await ensureGalleryUser();
  if (item?.ownerUid && item.ownerUid !== user.uid) {
    throw mediaError('session-changed', 'La sesión de la galería cambió. Vuelve a cargar la página.');
  }
  return {
    ownerUid: user.uid,
    mediaCollection: collection(doc(collection(db, 'christmasMedia'), user.uid), 'files')
  };
}

function itemReference(mediaCollection, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,180}$/.test(id)) {
    throw mediaError('invalid-id', 'El identificador del archivo no es válido.');
  }
  return doc(mediaCollection, id);
}

function chunkReference(ref, index, uploadToken) {
  return doc(collection(ref, 'chunks'), `${uploadToken}_${String(index).padStart(4, '0')}`);
}

function canClaimUpload(item) {
  return item.status === 'failed'
    || (item.status === 'uploading' && Date.now() - item.createdAtMs > STALE_UPLOAD_MS);
}

function assertUploadOwner(snapshot, uploadToken) {
  if (!snapshot.exists() || snapshot.data().status !== 'uploading' || snapshot.data().uploadToken !== uploadToken) {
    throw mediaError('cancelled', 'La carga se canceló porque el archivo fue eliminado o cambió.');
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw mediaError('cancelled', 'La carga del archivo fue cancelada.');
}

async function removeReferences(references) {
  for (let offset = 0; offset < references.length; offset += CHUNKS_PER_BATCH) {
    const batch = writeBatch(db);
    references.slice(offset, offset + CHUNKS_PER_BATCH).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

async function cleanFailedUpload(ref, uploadToken, chunkCount) {
  const shouldClean = await runTransaction(db, async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists()) {
      const current = existing.data();
      // Do not destroy a successfully committed upload if its final acknowledgement was uncertain.
      if (current.uploadToken === uploadToken && current.status === 'ready') return false;
      if (current.uploadToken === uploadToken && current.status === 'uploading') {
        transaction.set(ref, { ...current, status: 'failed' });
      }
    }
    return true;
  });
  if (!shouldClean) return;
  await removeReferences(Array.from({ length: chunkCount }, (_, index) => chunkReference(ref, index, uploadToken)));
  await runTransaction(db, async transaction => {
    const existing = await transaction.get(ref);
    if (existing.exists() && existing.data().uploadToken === uploadToken && existing.data().status === 'failed') {
      transaction.delete(ref);
    }
  });
}

function publicMetadata(snapshot, ownerUid) {
  const data = snapshot.data();
  return {
    id: snapshot.id,
    ownerUid,
    name: data.name,
    type: data.type,
    mimeType: data.mimeType,
    size: data.size,
    source: data.source,
    chunkCount: data.chunkCount,
    base64Length: data.base64Length,
    uploadToken: data.uploadToken,
    status: data.status,
    createdAtMs: data.createdAtMs
  };
}

export async function uploadMedia(file, options = {}) {
  requireConnection();
  throwIfAborted(options.signal);
  const scope = await userMediaScope();
  return uploadToCollection(file, options, scope);
}

async function uploadToCollection(file, { id, source = 'upload', signal } = {}, { mediaCollection, ownerUid }) {
  requireConnection();
  throwIfAborted(signal);
  const encoded = await encodeMediaFile(file);
  throwIfAborted(signal);
  const ref = id ? itemReference(mediaCollection, id) : doc(mediaCollection);
  const uploadToken = doc(mediaCollection).id;
  const metadata = {
    id: ref.id,
    name: String(file.name || 'Sin nombre').slice(0, 255),
    type: encoded.type,
    mimeType: encoded.mimeType,
    size: file.size,
    source: source === 'builtin' ? 'builtin' : 'upload',
    chunkCount: encoded.chunks.length,
    base64Length: encoded.base64Length,
    uploadToken,
    status: 'uploading',
    createdAtMs: Date.now()
  };
  let ownsUpload = false;
  try {
    // A transaction prevents two open tabs from importing the same default twice.
    const claimed = await runTransaction(db, async transaction => {
      const existing = await transaction.get(ref);
      if (existing.exists()) {
        if (!canClaimUpload(existing.data())) return false;
      }
      transaction.set(ref, { ...metadata, createdAt: serverTimestamp() });
      return true;
    });
    if (!claimed) {
      const existing = await getDocFromServer(ref);
      return existing.exists() ? publicMetadata(existing, ownerUid) : null;
    }
    ownsUpload = true;
    for (let offset = 0; offset < encoded.chunks.length; offset += CHUNKS_PER_BATCH) {
      throwIfAborted(signal);
      requireConnection();
      await runTransaction(db, async transaction => {
        const existing = await transaction.get(ref);
        assertUploadOwner(existing, uploadToken);
        encoded.chunks.slice(offset, offset + CHUNKS_PER_BATCH).forEach(chunk => {
          transaction.set(chunkReference(ref, chunk.index, uploadToken), { ...chunk, uploadToken });
        });
      });
    }
    throwIfAborted(signal);
    await runTransaction(db, async transaction => {
      const existing = await transaction.get(ref);
      assertUploadOwner(existing, uploadToken);
      transaction.set(ref, { ...existing.data(), status: 'ready' });
    });
    return { ...metadata, status: 'ready', ownerUid };
  } catch (error) {
    if (ownsUpload && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      try {
        await cleanFailedUpload(ref, uploadToken, encoded.chunks.length);
      } catch (cleanupError) {
        // Incomplete files stay hidden; a later default import may reclaim a stale upload.
        console.warn('No se pudo completar la limpieza del archivo:', cleanupError.code || cleanupError.message);
      }
    }
    throw error;
  }
}

export function subscribeMedia(onItems, onError = console.error) {
  let active = true;
  let stopListening = null;
  let stopAuth = null;
  const stopAll = () => {
    const firestoreStop = stopListening;
    const authStop = stopAuth;
    stopListening = null;
    stopAuth = null;
    firestoreStop?.();
    authStop?.();
  };
  const fail = error => {
    if (!active) return;
    active = false;
    stopAll();
    onError(error);
  };
  // Incomplete deletions remain visible so another session can finish removing them.
  // Tombstone IDs also suppress deleted defaults while another import is incomplete.
  userMediaScope().then(({ mediaCollection, ownerUid }) => {
    if (!active) return;
    stopAuth = onGalleryIdentityChange(ownerUid, () => {
      fail(mediaError('session-changed', 'La sesión de la galería cambió. Vuelve a cargar la página.'));
    });
    if (!active) { stopAll(); return; }
    const visibleMedia = query(mediaCollection, where('status', 'in', ['ready', 'deleting', 'deleted']));
    stopListening = onSnapshot(visibleMedia, { includeMetadataChanges: true }, snapshot => {
      if (!active) return;
      const confirmed = snapshot.docs.filter(item => !item.metadata.hasPendingWrites);
      const items = confirmed
        .filter(item => item.data().status !== 'deleted')
        .map(item => publicMetadata(item, ownerUid))
        .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0) || a.id.localeCompare(b.id));
      onItems(items, {
        fromCache: snapshot.metadata.fromCache,
        hasPendingWrites: snapshot.metadata.hasPendingWrites,
        deletedIds: confirmed.filter(item => item.data().status === 'deleted').map(item => item.id)
      });
    }, fail);
  }).catch(fail);
  return () => {
    active = false;
    stopAll();
  };
}

export async function getMediaData(item) {
  const { mediaCollection } = await userMediaScope(item);
  const ref = itemReference(mediaCollection, item.id);
  const snapshot = await getDocs(collection(ref, 'chunks'));
  const chunks = snapshot.docs.map(chunk => chunk.data())
    .filter(chunk => !item.uploadToken || chunk.uploadToken === item.uploadToken);
  return assembleMediaData(item, chunks);
}

export async function deleteMedia(item) {
  requireConnection();
  const { mediaCollection } = await userMediaScope(item);
  const ref = itemReference(mediaCollection, item.id);
  const deleteToken = doc(mediaCollection).id;
  const metadata = await runTransaction(db, async transaction => {
    const existing = await transaction.get(ref);
    if (!existing.exists()) {
      if (item.source === 'builtin') {
        transaction.set(ref, { source: 'builtin', status: 'deleted', deletedAt: serverTimestamp() });
      }
      return null;
    }
    const current = existing.data();
    if (current.status === 'deleted') return null;
    transaction.set(ref, { ...current, status: 'deleting', deleteToken });
    return current;
  });
  if (!metadata) return;
  // The parent is now 'deleting', so transactional chunk writers cannot add any more content.
  const chunks = await getDocs(collection(ref, 'chunks'));
  await removeReferences(chunks.docs.map(chunk => chunk.ref));
  await runTransaction(db, async transaction => {
    const existing = await transaction.get(ref);
    if (!existing.exists() || existing.data().status !== 'deleting' || existing.data().deleteToken !== deleteToken) return;
    if (metadata.source === 'builtin') {
      transaction.set(ref, { source: 'builtin', status: 'deleted', deletedAt: serverTimestamp() });
    } else transaction.delete(ref);
  });
}

export async function seedDefaultMedia(defaults) {
  requireConnection();
  const scope = await userMediaScope();
  const { mediaCollection } = scope;
  let importPending = false;
  for (const asset of defaults) {
    const ref = itemReference(mediaCollection, asset.id);
    const existing = await getDocFromServer(ref);
    if (existing.exists()) {
      const current = existing.data();
      if (!canClaimUpload(current)) {
        if (current.status === 'uploading') importPending = true;
        continue;
      }
    }
    const response = await fetch(asset.url);
    if (!response.ok) throw mediaError('default-load-failed', `No se pudo leer ${asset.name || asset.url}.`);
    const blob = await response.blob();
    const mimeType = asset.mimeType || (asset.type?.includes('/') ? asset.type : '') || blob.type;
    const name = asset.name || asset.url.split('/').pop();
    const stored = await uploadToCollection(new File([blob], name, { type: mimeType }), { id: asset.id, source: 'builtin' }, scope);
    if (!stored || stored.status === 'uploading' || stored.status === 'failed') importPending = true;
  }
  if (importPending) {
    throw mediaError('import-pending', 'Hay archivos que siguen importándose en otra pestaña. Espera y pulsa Reintentar.');
  }
}
