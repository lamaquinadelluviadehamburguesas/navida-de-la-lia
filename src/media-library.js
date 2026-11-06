import {
  deleteMedia,
  getMediaData,
  MAX_FILE_SIZE,
  seedDefaultMedia,
  subscribeMedia,
  uploadMedia
} from './database/media.js';
import { setupGallery } from './gallery.js';
import { assembleMediaData, encodeMediaFile } from './database/media-codec.js';

export function describeMediaError(error) {
  const code = error?.code || '';
  if (['auth/operation-not-allowed', 'auth/admin-restricted-operation', 'auth/configuration-not-found'].includes(code)) {
    return 'Activa el proveedor Anónimo en Firebase Console → Authentication → Métodos de acceso.';
  }
  if (code === 'auth/unauthorized-domain') {
    return 'Autoriza este dominio en Firebase Authentication → Configuración → Dominios autorizados.';
  }
  if (code === 'media/session-changed') {
    return 'La sesión cambió. Recarga la página para abrir la galería de la sesión actual.';
  }
  if (code.includes('permission-denied')) {
    return 'Firebase no permite esta operación. Publica las reglas de firestore.rules para la galería y sus fragmentos.';
  }
  if (code.includes('unauthenticated')) {
    return 'Firebase requiere iniciar sesión para acceder a estos archivos.';
  }
  if (code === 'auth/network-request-failed' || code.includes('unavailable')
    || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    return 'No hay conexión con Firebase. Comprueba tu conexión e inténtalo de nuevo.';
  }
  return error?.message || 'No se pudo completar la operación. Inténtalo de nuevo.';
}

export function setupMediaLibrary({ defaults, onImageAdded, onImageRemoved, onViewChange, onNotice }) {
  let remoteItems = [];
  let unsubscribe = null;
  let seedPromise = null;
  let seeded = false;
  let connected = false;
  let uploading = false;
  let disposed = false;
  let syncError = '';
  let operationError = '';
  let connectionTimer;
  const deletedIds = new Set();
  const remoteDeletedIds = new Set();
  const uploadTimers = new Set();
  const confirmedUploads = new Map();
  const pendingDeletes = new Map();
  const sceneIds = new Set();
  const previewCache = new Map();
  let displayedItems = [];

  const gallery = setupGallery({
    onFiles: saveFiles,
    onDelete: removeItem,
    onLoadMedia: loadPreview,
    onViewChange,
    onRetry: startSync
  });

  function updateStatus() {
    if (disposed) return;
    const error = operationError || syncError;
    gallery.setStatus({
      message: error || (uploading ? 'Guardando archivos…' : !connected
        ? 'Conectando con tu galería…' : !seeded
          ? 'Preparando los recuerdos incluidos…' : 'Galería sincronizada.'),
      error: Boolean(error),
      busy: uploading
    });
  }

  function loadPreview(item) {
    const key = `${item.id}:${item.status === 'local' ? 'local' : 'saved'}`;
    if (previewCache.has(key)) return previewCache.get(key);
    const promise = item.status === 'local' && item.url
      ? fetch(item.url).then(async response => {
        if (!response.ok) throw new Error('No se pudo leer el archivo incluido.');
        const file = new File([await response.blob()], item.name, { type: item.mimeType });
        const encoded = await encodeMediaFile(file);
        return assembleMediaData({ ...item, size: file.size, base64Length: encoded.base64Length,
          chunkCount: encoded.chunks.length }, encoded.chunks);
      }) : getMediaData(item);
    previewCache.set(key, promise);
    promise.catch(() => previewCache.delete(key));
    // Mantiene acotada la caché de videos y cadenas Base64 grandes.
    if (previewCache.size > 12) previewCache.delete(previewCache.keys().next().value);
    return promise;
  }

  function publishItems() {
    if (disposed) return;
    const merged = new Map();
    if (!seeded) {
      defaults.forEach(item => merged.set(item.id, { ...item, source: 'builtin', status: 'local' }));
    }
    remoteItems.forEach(item => merged.set(item.id, item));
    confirmedUploads.forEach(item => merged.set(item.id, item));
    pendingDeletes.forEach(item => merged.set(item.id, item));
    deletedIds.forEach(id => merged.delete(id));
    remoteDeletedIds.forEach(id => merged.delete(id));
    displayedItems = [...merged.values()].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    gallery.setItems(displayedItems);

    const images = displayedItems.filter(item => item.type === 'image' && item.status !== 'deleting');
    const imageIds = new Set(images.map(item => item.id));
    for (const id of sceneIds) {
      if (!imageIds.has(id)) {
        sceneIds.delete(id);
        onImageRemoved(id);
      }
    }
    images.forEach(item => {
      if (sceneIds.has(item.id)) return;
      sceneIds.add(item.id);
      loadPreview(item).then(src => {
        if (!disposed && sceneIds.has(item.id)) return onImageAdded(item, src);
      }).catch(error => {
        sceneIds.delete(item.id);
        if (!disposed) onNotice(`No se pudo cargar ${item.name}: ${describeMediaError(error)}`);
      });
    });
  }

  function startSync() {
    if (disposed) return;
    unsubscribe?.();
    clearTimeout(connectionTimer);
    syncError = '';
    operationError = '';
    connected = false;
    updateStatus();
    publishItems();
    connectionTimer = setTimeout(() => {
      if (!connected && !disposed) {
        syncError = 'Firebase está tardando en responder. Comprueba la conexión y pulsa Reintentar.';
        updateStatus();
      }
    }, 15000);
    unsubscribe = subscribeMedia((items, snapshot = {}) => {
      if (disposed) return;
      remoteItems = items;
      snapshot.deletedIds?.forEach(id => remoteDeletedIds.add(id));
      items.forEach(item => confirmedUploads.delete(item.id));
      if (!snapshot.fromCache && !snapshot.hasPendingWrites) {
        connected = true;
        syncError = '';
        clearTimeout(connectionTimer);
      }
      publishItems();
      updateStatus();
    }, error => {
      if (disposed) return;
      if (error?.code === 'media/session-changed') {
        gallery.setItems([]);
        gallery.setUploadProgress('');
        gallery.setStatus({ message: 'La sesión cambió. Recargando la galería…', busy: true });
        destroy();
        window.location.reload();
        return;
      }
      clearTimeout(connectionTimer);
      syncError = describeMediaError(error);
      updateStatus();
    });

    if (!seeded && !seedPromise) {
      seedPromise = seedDefaultMedia(defaults).then(() => {
        seeded = true;
        publishItems();
      }).catch(error => {
        syncError = describeMediaError(error);
      }).finally(() => {
        seedPromise = null;
        updateStatus();
      });
    }
  }

  async function saveFiles(files) {
    if (disposed) return;
    if (uploading) throw new Error('Espera a que termine la carga actual.');
    if (!files.length) return;
    window.location.hash = '#galeria';
    uploading = true;
    operationError = '';
    updateStatus();
    let saved = 0;
    const failures = [];
    for (const [index, file] of [...files].entries()) {
      gallery.setUploadProgress(`Guardando ${index + 1} de ${files.length}: ${file.name}`);
      const waitingTimer = setTimeout(() => {
        if (!disposed) gallery.setUploadProgress(`Esperando confirmación de Firebase para ${file.name}. No cierres esta página.`);
      }, 15000);
      uploadTimers.add(waitingTimer);
      try {
        if (file.size > MAX_FILE_SIZE) throw new Error('El archivo supera el límite de 20 MB.');
        const item = await uploadMedia(file);
        if (disposed) return;
        confirmedUploads.set(item.id, item);
        saved++;
        publishItems();
      } catch (error) {
        if (disposed) return;
        failures.push(`${file.name}: ${describeMediaError(error)}`);
      } finally {
        clearTimeout(waitingTimer);
        uploadTimers.delete(waitingTimer);
      }
    }
    uploading = false;
    gallery.setUploadProgress('');
    operationError = failures.join(' ');
    updateStatus();
    if (saved) onNotice(`${saved} ${saved === 1 ? 'archivo guardado' : 'archivos guardados'} en la galería.`);
    if (failures.length) throw new Error(`${saved ? `${saved} guardados. ` : ''}${operationError}`);
  }

  async function removeItem(item) {
    pendingDeletes.set(item.id, item);
    publishItems();
    try {
      await deleteMedia(item);
      if (disposed) return;
      pendingDeletes.delete(item.id);
      deletedIds.add(item.id);
      confirmedUploads.delete(item.id);
      remoteItems = remoteItems.filter(current => current.id !== item.id);
      previewCache.delete(`${item.id}:local`);
      previewCache.delete(`${item.id}:saved`);
      operationError = '';
      publishItems();
      updateStatus();
      onNotice('Archivo eliminado.');
    } catch (error) {
      // Conserva el archivo para reintentar, aunque Firebase ya lo marque como deleting.
      const remote = remoteItems.find(current => current.id === item.id);
      if (remote?.status === 'deleting') pendingDeletes.set(item.id, remote);
      publishItems();
      throw new Error(describeMediaError(error));
    }
  }

  publishItems();
  startSync();

  function destroy() {
    if (disposed) return;
    disposed = true;
    clearTimeout(connectionTimer);
    uploadTimers.forEach(timer => clearTimeout(timer));
    uploadTimers.clear();
    unsubscribe?.();
    gallery.destroy();
    previewCache.clear();
    confirmedUploads.clear();
    pendingDeletes.clear();
    sceneIds.forEach(onImageRemoved);
    sceneIds.clear();
  }

  return { destroy };
}
