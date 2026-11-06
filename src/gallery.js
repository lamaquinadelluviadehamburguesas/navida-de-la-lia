const MEDIA_LABELS = { image: 'Foto', video: 'Video' };

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('es', { maximumFractionDigits: 1 })} MB`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setupGallery({ onFiles, onDelete, onViewChange, onLoadMedia, onRetry } = {}) {
  const menuToggle = document.getElementById('menu-toggle');
  const menu = document.getElementById('controls-menu');
  const menuClose = document.getElementById('menu-close');
  const gallery = document.getElementById('gallery-view');
  const grid = document.getElementById('gallery-grid');
  const empty = document.getElementById('gallery-empty');
  const status = document.getElementById('gallery-status');
  const statusMessage = document.getElementById('gallery-status-message');
  const retryButton = document.getElementById('gallery-retry');
  const uploadProgress = document.getElementById('upload-progress');
  const fileInput = document.getElementById('file-input');
  const folderInput = document.getElementById('folder-input');
  const filters = [...document.querySelectorAll('[data-filter]')];
  const fileButtons = [...document.querySelectorAll('[data-open-files], [data-open-folder]')];
  const listeners = [];
  const records = new Map();
  let items = [];
  let filter = 'all';
  let view = null;
  let busy = true;
  let destroyed = false;

  function listen(target, event, callback, options) {
    target.addEventListener(event, callback, options);
    listeners.push(() => target.removeEventListener(event, callback, options));
  }

  function closeMenu({ restoreFocus = true } = {}) {
    if (!menu.open) return;
    menu.close();
    document.body.dataset.menuOpen = 'false';
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Abrir menú');
    if (restoreFocus) menuToggle.focus({ preventScroll: true });
  }

  function openMenu() {
    if (destroyed || menu.open) return;
    menu.showModal();
    document.body.dataset.menuOpen = 'true';
    menuToggle.setAttribute('aria-expanded', 'true');
    menuToggle.setAttribute('aria-label', 'Cerrar menú');
    menuClose.focus();
  }

  function pauseVideos() {
    for (const record of records.values()) {
      if (record.media.tagName === 'VIDEO') record.media.pause();
    }
  }

  function updateView({ focus = false } = {}) {
    const nextView = window.location.hash === '#galeria' ? 'gallery' : 'tree';
    if (view === nextView) return;
    closeMenu({ restoreFocus: false });
    view = nextView;
    document.body.dataset.view = view;
    gallery.hidden = view !== 'gallery';
    document.getElementById('canvas-container').setAttribute('aria-hidden', String(view !== 'tree'));
    for (const [id, selectedView] of [['tree-link', 'tree'], ['gallery-btn', 'gallery']]) {
      const link = document.getElementById(id);
      if (view === selectedView) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (view === 'tree') pauseVideos();
    if (view === 'gallery') {
      for (const record of records.values()) observeCard(record);
      if (focus) document.getElementById('gallery-heading').focus({ preventScroll: true });
    } else if (focus) {
      menuToggle.focus({ preventScroll: true });
    }
    onViewChange?.(view);
  }

  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting || view !== 'gallery') continue;
        const record = records.get(entry.target.dataset.id);
        if (record) loadPreview(record);
      }
    }, { root: gallery, rootMargin: '180px' })
    : null;

  function observeCard(record) {
    if (view !== 'gallery' || record.card.hidden || record.previewLoaded || record.loading || record.previewFailed || record.item.status === 'deleting') return;
    if (observer) observer.observe(record.card);
    else loadPreview(record);
  }

  function showPreviewError(record, message) {
    if (destroyed || records.get(record.item.id) !== record) return;
    record.previewLoaded = false;
    record.previewFailed = true;
    record.placeholder.hidden = false;
    record.placeholder.dataset.error = 'true';
    record.previewMessage.textContent = message;
    record.previewRetry.hidden = false;
    observer?.unobserve(record.card);
  }

  async function loadPreview(record) {
    if (destroyed || view !== 'gallery' || record.loading || record.previewLoaded || record.card.hidden || record.item.status === 'deleting') return;
    observer?.unobserve(record.card);
    record.loading = true;
    record.previewFailed = false;
    const generation = ++record.generation;
    record.placeholder.hidden = false;
    record.placeholder.dataset.error = 'false';
    record.previewMessage.textContent = record.item.type === 'video' ? 'Cargando video…' : 'Cargando foto…';
    record.previewRetry.hidden = true;
    try {
      const source = onLoadMedia ? await onLoadMedia(record.item) : record.item.dataUrl;
      if (destroyed || records.get(record.item.id) !== record || generation !== record.generation) return;
      const expectedPrefix = `data:${record.item.type}/`;
      if (typeof source !== 'string' || !source.startsWith(expectedPrefix) || !source.includes(';base64,')) {
        throw new Error('No se pudo abrir este archivo.');
      }
      record.media.src = source;
      if (record.media.tagName === 'VIDEO') record.media.load();
    } catch (error) {
      if (generation === record.generation) showPreviewError(record, error?.message || 'No se pudo cargar el archivo.');
    } finally {
      if (generation === record.generation) record.loading = false;
    }
  }

  function removeRecord(id) {
    const record = records.get(id);
    if (!record) return;
    record.generation++;
    observer?.unobserve(record.card);
    if (record.media.tagName === 'VIDEO') record.media.pause();
    record.media.removeAttribute('src');
    if (record.media.tagName === 'VIDEO') record.media.load();
    record.card.remove();
    records.delete(id);
  }

  function createCard(item) {
    const card = element('article', 'media-card');
    card.dataset.id = item.id;
    const preview = element('div', 'media-preview');
    const media = element(item.type === 'video' ? 'video' : 'img');
    if (item.type === 'video') {
      media.controls = true;
      media.playsInline = true;
      media.preload = 'metadata';
      media.setAttribute('aria-label', item.name);
    } else {
      media.alt = item.name;
      media.decoding = 'async';
    }
    const placeholder = element('div', 'preview-placeholder');
    const symbol = element('span', 'preview-symbol', item.type === 'video' ? '▷' : '✧');
    symbol.setAttribute('aria-hidden', 'true');
    const previewMessage = element('span', '', 'Vista previa');
    const previewRetry = element('button', 'preview-retry', 'Reintentar');
    previewRetry.type = 'button';
    previewRetry.hidden = true;
    placeholder.append(symbol, previewMessage, previewRetry);
    preview.append(media, placeholder);

    const info = element('div', 'media-info');
    const description = element('div', 'media-description');
    const name = element('h2', 'media-name', item.name);
    name.title = item.name;
    const details = element('p', 'media-details');
    description.append(name, details);
    const deleteButton = element('button', 'delete-media-btn', 'Eliminar');
    deleteButton.type = 'button';
    deleteButton.setAttribute('aria-label', `Eliminar ${item.name}`);
    deleteButton.setAttribute('aria-expanded', 'false');
    info.append(description, deleteButton);

    const confirmation = element('div', 'delete-confirmation');
    confirmation.id = `delete-confirm-${item.id}`;
    confirmation.setAttribute('role', 'group');
    confirmation.setAttribute('aria-label', `Confirmar eliminación de ${item.name}`);
    deleteButton.setAttribute('aria-controls', confirmation.id);
    confirmation.hidden = true;
    const question = element('p', '', '¿Eliminar este archivo de la galería y del árbol?');
    const deletionError = element('p', 'delete-error');
    deletionError.hidden = true;
    deletionError.setAttribute('role', 'alert');
    const actions = element('div', 'delete-actions');
    const confirmButton = element('button', 'confirm-delete-btn', 'Eliminar archivo');
    confirmButton.type = 'button';
    const cancelButton = element('button', '', 'Cancelar');
    cancelButton.type = 'button';
    actions.append(confirmButton, cancelButton);
    confirmation.append(question, deletionError, actions);
    card.append(preview, info, confirmation);

    const record = { item, card, media, details, name, deleteButton, placeholder, previewMessage, previewRetry, generation: 0, loading: false, previewLoaded: false, previewFailed: false, deleting: false };
    const loaded = () => {
      if (destroyed || records.get(record.item.id) !== record) return;
      record.previewLoaded = true;
      record.placeholder.hidden = true;
    };
    media.addEventListener(item.type === 'video' ? 'loadedmetadata' : 'load', loaded);
    media.addEventListener('error', () => {
      if (!media.getAttribute('src')) return;
      showPreviewError(record, item.type === 'video'
        ? 'Este video no se puede reproducir en este navegador.'
        : 'Este formato de imagen no se puede mostrar.');
    });
    previewRetry.addEventListener('click', () => loadPreview(record));
    deleteButton.addEventListener('click', () => {
      confirmation.hidden = false;
      deleteButton.setAttribute('aria-expanded', 'true');
      deletionError.hidden = true;
      confirmButton.focus();
    });
    cancelButton.addEventListener('click', () => {
      if (record.deleting) return;
      confirmation.hidden = true;
      deleteButton.setAttribute('aria-expanded', 'false');
      deleteButton.focus();
    });
    confirmButton.addEventListener('click', async () => {
      if (record.deleting) return;
      record.deleting = true;
      deleteButton.disabled = true;
      confirmButton.disabled = true;
      cancelButton.disabled = true;
      confirmButton.textContent = 'Eliminando…';
      deletionError.hidden = true;
      try {
        if (!onDelete) throw new Error('No se pudo eliminar el archivo.');
        await onDelete(record.item);
        if (destroyed) return;
        items = items.filter(current => current.id !== record.item.id);
        removeRecord(record.item.id);
        updateCounts();
        if (view === 'gallery' && (record.card.contains(document.activeElement) || document.activeElement === document.body)) {
          const nextCard = [...records.values()].find(current => !current.card.hidden);
          (nextCard?.deleteButton || document.getElementById('gallery-heading')).focus({ preventScroll: true });
        }
      } catch (error) {
        if (destroyed || records.get(record.item.id) !== record) return;
        deletionError.textContent = error?.message || 'No se pudo eliminar. Inténtalo de nuevo.';
        deletionError.hidden = false;
      } finally {
        record.deleting = false;
        deleteButton.disabled = false;
        confirmButton.disabled = false;
        cancelButton.disabled = false;
        confirmButton.textContent = 'Eliminar archivo';
        deleteButton.textContent = record.item.status === 'deleting' ? 'Reintentar eliminación' : 'Eliminar';
      }
    });
    return record;
  }

  function updateCounts() {
    const photos = items.filter(item => item.type === 'image').length;
    const videos = items.filter(item => item.type === 'video').length;
    document.getElementById('count-all').textContent = String(items.length);
    document.getElementById('count-images').textContent = String(photos);
    document.getElementById('count-videos').textContent = String(videos);
    document.getElementById('gallery-count').textContent = items.length
      ? `${photos} ${photos === 1 ? 'foto' : 'fotos'} y ${videos} ${videos === 1 ? 'video' : 'videos'}`
      : 'Sin archivos';
    let visible = 0;
    for (const record of records.values()) {
      record.card.hidden = filter !== 'all' && record.item.type !== filter;
      if (record.card.hidden) {
        observer?.unobserve(record.card);
        if (record.media.tagName === 'VIDEO') record.media.pause();
      } else {
        visible++;
        observeCard(record);
      }
    }
    empty.hidden = visible !== 0 || busy;
    if (!empty.hidden) {
      empty.querySelector('h2').textContent = items.length ? 'Todavía no hay archivos en esta categoría' : 'Aquí comienzan tus recuerdos';
      empty.querySelector('p').textContent = filter === 'video' ? 'Añade un video para verlo aquí.' : 'Añade fotos o videos para verlos en tu galería.';
    }
  }

  function setItems(nextItems) {
    if (destroyed) return;
    items = nextItems.filter(item => item && (item.type === 'image' || item.type === 'video'));
    const incomingIds = new Set(items.map(item => item.id));
    for (const id of records.keys()) if (!incomingIds.has(id)) removeRecord(id);
    for (const [index, item] of items.entries()) {
      let record = records.get(item.id);
      if (record && record.item.type !== item.type) {
        removeRecord(item.id);
        record = null;
      }
      if (!record) {
        record = createCard(item);
        records.set(item.id, record);
      }
      record.item = item;
      record.name.textContent = item.name;
      record.name.title = item.name;
      record.deleteButton.setAttribute('aria-label', `Eliminar ${item.name}`);
      const metadata = [MEDIA_LABELS[item.type], formatSize(item.size)];
      if (item.status === 'local') metadata.push('Vista previa');
      if (item.status === 'deleting') {
        metadata.push('Eliminación pendiente');
        record.generation++;
        record.loading = false;
        record.previewLoaded = false;
        observer?.unobserve(record.card);
        if (record.media.tagName === 'VIDEO') record.media.pause();
        record.media.removeAttribute('src');
        record.placeholder.hidden = false;
        record.placeholder.dataset.error = 'false';
        record.previewMessage.textContent = 'Eliminación pendiente. Vuelve a intentarlo.';
        record.previewRetry.hidden = true;
      }
      record.deleteButton.textContent = item.status === 'deleting' ? 'Reintentar eliminación' : 'Eliminar';
      record.details.textContent = metadata.filter(Boolean).join(' · ');
      const currentNode = grid.children[index];
      if (currentNode !== record.card) grid.insertBefore(record.card, currentNode || null);
    }
    updateCounts();
  }

  function setStatus({ message = '', error = false, busy: nextBusy = false } = {}) {
    if (destroyed) return;
    busy = nextBusy;
    statusMessage.textContent = message || (typeof error === 'string' ? error : '');
    status.dataset.error = String(Boolean(error));
    status.hidden = !statusMessage.textContent;
    retryButton.hidden = !error || typeof onRetry !== 'function';
    retryButton.disabled = busy;
    gallery.setAttribute('aria-busy', String(busy));
    for (const button of fileButtons) button.disabled = busy;
    updateCounts();
  }

  function setUploadProgress(message = '') {
    if (destroyed) return;
    uploadProgress.textContent = message;
    uploadProgress.hidden = !message;
  }

  listen(menuToggle, 'click', () => menu.open ? closeMenu() : openMenu());
  listen(menuClose, 'click', () => closeMenu());
  listen(menu, 'cancel', event => {
    event.preventDefault();
    event.stopPropagation();
    closeMenu();
  });
  listen(menu, 'close', () => {
    document.body.dataset.menuOpen = 'false';
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Abrir menú');
  });
  listen(menu, 'click', event => {
    if (event.target !== menu) return;
    const rect = menu.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeMenu();
  });
  listen(document, 'keydown', event => {
    if (event.key !== 'Escape') return;
    if (menu.open) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    } else if (view === 'gallery') {
      event.stopPropagation();
    }
  }, true);
  listen(window, 'hashchange', () => updateView({ focus: true }));
  for (const link of menu.querySelectorAll('a[href]')) listen(link, 'click', () => closeMenu({ restoreFocus: false }));
  for (const control of menu.querySelectorAll('#cam-btn, #audio-btn')) listen(control, 'click', () => {
    if (control.id === 'cam-btn' && view === 'gallery') window.location.hash = '#arbol';
    closeMenu();
  });
  for (const button of fileButtons) listen(button, 'click', () => {
    if (button.hasAttribute('data-open-folder')) folderInput.click();
    else fileInput.click();
  });
  const handleFiles = async event => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    closeMenu();
    try {
      await onFiles?.(files);
    } catch (error) {
      setStatus({ message: error?.message || 'No se pudieron guardar los archivos.', error: true });
    }
  };
  listen(fileInput, 'change', handleFiles);
  listen(folderInput, 'change', handleFiles);
  for (const button of filters) listen(button, 'click', () => {
    filter = button.dataset.filter;
    for (const other of filters) other.setAttribute('aria-pressed', String(other === button));
    updateCounts();
  });
  listen(retryButton, 'click', () => {
    Promise.resolve().then(() => onRetry?.()).catch(error => {
      setStatus({ message: error?.message || 'No se pudo conectar. Inténtalo de nuevo.', error: true });
    });
  });

  updateView();
  updateCounts();

  return {
    setItems,
    setStatus,
    setUploadProgress,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      closeMenu();
      observer?.disconnect();
      for (const cleanup of listeners) cleanup();
      for (const id of records.keys()) removeRecord(id);
    }
  };
}
