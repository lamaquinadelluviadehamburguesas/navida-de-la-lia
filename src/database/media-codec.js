export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const BASE64_CHUNK_SIZE = 650000;

const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  heif: 'image/heif', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', ogv: 'video/ogg', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  mpeg: 'video/mpeg', mpg: 'video/mpeg'
};
const MEDIA_MIME_PATTERN = /^(image|video)\/[a-z0-9][a-z0-9.+-]{0,79}$/;

export function mediaError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = `media/${code}`;
  return error;
}

export function resolveMediaMimeType(file) {
  const supplied = String(file.type || '').toLowerCase().trim();
  if (supplied === 'image/jpg') return 'image/jpeg';
  if (supplied === 'video/x-m4v') return 'video/mp4';
  if (MEDIA_MIME_PATTERN.test(supplied)) return supplied;
  const extension = String(file.name || '').split('.').pop().toLowerCase();
  const inferred = MIME_BY_EXTENSION[extension];
  if (inferred) return inferred;
  throw mediaError('unsupported-type', 'Selecciona una imagen o un video compatible.');
}

export function validateMediaFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1) {
    throw mediaError('empty-file', 'El archivo está vacío o no se puede leer.');
  }
  if (file.size > MAX_FILE_SIZE) {
    throw mediaError('file-too-large', 'El archivo supera el límite de 20 MB.');
  }
  const mimeType = resolveMediaMimeType(file);
  return { mimeType, type: mimeType.startsWith('video/') ? 'video' : 'image' };
}

export function splitBase64(base64) {
  if (typeof base64 !== 'string' || !base64.length || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw mediaError('invalid-data', 'El contenido del archivo no es Base64 válido.');
  }
  const chunks = [];
  for (let offset = 0; offset < base64.length; offset += BASE64_CHUNK_SIZE) {
    chunks.push({ index: chunks.length, data: base64.slice(offset, offset + BASE64_CHUNK_SIZE) });
  }
  return chunks;
}

export async function encodeMediaFile(file) {
  const format = validateMediaFile(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw mediaError('invalid-data', 'No se pudo leer el archivo completo.');
  // Each piece contains a multiple of three bytes, so only the final piece needs padding.
  const pieces = [];
  const step = 32766;
  for (let offset = 0; offset < bytes.length; offset += step) {
    pieces.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + step))));
  }
  const base64 = pieces.join('');
  return { ...format, base64Length: base64.length, chunks: splitBase64(base64) };
}

export function assembleMediaData(item, chunks) {
  const expectedLength = 4 * Math.ceil(item.size / 3);
  if (!MEDIA_MIME_PATTERN.test(item.mimeType || '') || item.type !== item.mimeType.split('/')[0]
    || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_FILE_SIZE
    || item.base64Length !== expectedLength
    || item.chunkCount !== Math.ceil(expectedLength / BASE64_CHUNK_SIZE)
    || chunks.length !== item.chunkCount) {
    throw mediaError('incomplete-data', 'El archivo está incompleto. Vuelve a cargar la galería.');
  }
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  for (let index = 0; index < ordered.length; index++) {
    const chunk = ordered[index];
    const expectedChunkLength = Math.min(BASE64_CHUNK_SIZE, expectedLength - index * BASE64_CHUNK_SIZE);
    if (chunk.index !== index || typeof chunk.data !== 'string' || chunk.data.length !== expectedChunkLength
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)
      || (index < ordered.length - 1 && chunk.data.includes('='))) {
      throw mediaError('incomplete-data', 'Faltan fragmentos del archivo o su contenido no es válido.');
    }
  }
  const base64 = ordered.map(chunk => chunk.data).join('');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  if ((base64.length / 4) * 3 - padding !== item.size) {
    throw mediaError('invalid-data', 'El tamaño del archivo guardado no coincide con su contenido.');
  }
  return `data:${item.mimeType};base64,${base64}`;
}
