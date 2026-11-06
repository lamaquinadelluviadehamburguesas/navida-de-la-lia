import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleMediaData, BASE64_CHUNK_SIZE, encodeMediaFile, MAX_FILE_SIZE,
  resolveMediaMimeType, splitBase64, validateMediaFile
} from '../src/database/media-codec.js';

function metadata(file, encoded) {
  return {
    type: encoded.type, mimeType: encoded.mimeType, size: file.size,
    chunkCount: encoded.chunks.length, base64Length: encoded.base64Length
  };
}

test('video larger than one Firestore document round-trips across ordered chunks', async () => {
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 5 }, (_, index) => index % 251);
  const file = new File([bytes], 'holiday.mp4', { type: 'video/mp4' });
  const encoded = await encodeMediaFile(file);
  assert.equal(encoded.type, 'video');
  assert.ok(encoded.chunks.length > 1);
  assert.ok(encoded.chunks.every(chunk => chunk.data.length <= BASE64_CHUNK_SIZE));
  const dataUrl = assembleMediaData(metadata(file, encoded), [...encoded.chunks].reverse());
  const restored = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.deepEqual(restored, Buffer.from(bytes));
  assert.ok(dataUrl.startsWith('data:video/mp4;base64,'));
});

test('image sizes with each Base64 padding variant round-trip', async () => {
  for (const size of [1, 2, 3, 32765, 32766, 32767]) {
    const file = new File([new Uint8Array(size).fill(213)], 'photo.jpg', { type: 'image/jpeg' });
    const encoded = await encodeMediaFile(file);
    const result = assembleMediaData(metadata(file, encoded), encoded.chunks);
    assert.equal(Buffer.from(result.split(',')[1], 'base64').length, size);
  }
});

test('missing or repeated chunks never return a partial media URL', async () => {
  const file = new File([new Uint8Array(1024 * 1024)], 'clip.webm', { type: 'video/webm' });
  const encoded = await encodeMediaFile(file);
  const item = metadata(file, encoded);
  assert.throws(() => assembleMediaData(item, encoded.chunks.slice(1)), /incompleto/);
  const repeated = encoded.chunks.map(chunk => ({ ...chunk, index: 0 }));
  assert.throws(() => assembleMediaData(item, repeated), /fragmentos/);
});

test('unsafe MIME, mismatched size and invalid Base64 are rejected', async () => {
  const file = new File(['hello'], 'photo.png', { type: 'image/png' });
  const encoded = await encodeMediaFile(file);
  const item = metadata(file, encoded);
  assert.throws(() => assembleMediaData({ ...item, mimeType: 'text/html' }, encoded.chunks));
  assert.throws(() => assembleMediaData({ ...item, size: item.size + 1 }, encoded.chunks));
  assert.throws(() => splitBase64('<script>'));
  assert.throws(() => splitBase64('AA=A'));
});

test('type inference handles folders that omit MIME and rejects other files', () => {
  assert.equal(resolveMediaMimeType({ name: 'PHOTO.JPEG', type: '' }), 'image/jpeg');
  assert.equal(resolveMediaMimeType({ name: 'video.webm', type: 'application/octet-stream' }), 'video/webm');
  assert.equal(resolveMediaMimeType({ name: 'photo.jpg', type: 'image/jpg' }), 'image/jpeg');
  assert.throws(() => resolveMediaMimeType({ name: 'notes.txt', type: 'text/plain' }));
});

test('empty files and files over the 20 MiB limit fail before reading', () => {
  assert.throws(() => validateMediaFile(new File([], 'empty.jpg', { type: 'image/jpeg' })), /vacío/);
  assert.throws(() => validateMediaFile({ size: MAX_FILE_SIZE + 1, type: 'video/mp4', name: 'large.mp4', arrayBuffer() {} }), /20 MB/);
});
