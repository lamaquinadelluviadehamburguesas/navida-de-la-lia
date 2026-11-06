# 🎄 Gesture-Controlled 3D Christmas Tree (Árbol de Navidad 3D Interactivo)

Proyecto interactivo 3D de alta fidelidad que replica exactamente el diseño, las animaciones y el control por gestos con IA mostrado en los videos de demostración.

---

## ✨ Características Principales

1. **Gráficos 3D de Lujo con Three.js & Post-procesado Cinematic**:
   - **Árbol de Navidad Cónico**: Compuesto por miles de elementos (cubos verde esmeralda, cubos de oro champán metalizado, esferas doradas reflectantes, esferas rojo rubí con capa transparente y bastones de caramelo en espiral).
   - **Estrella / Diamante Superior**: Diamante dorado brillante con emisión de luz en la punta del árbol.
   - **Partículas de Polvo Dorado**: Miles de destellos brillantes que flotan y titilan suavemente.
   - **Efecto Bloom Cinematográfico (`UnrealBloomPass`)**: Brillo resplandeciente idéntico al del video.

2. **3 Estados de Animación**:
   - 🎄 **TREE (Árbol Plegado)**: Todas las partículas y marcos de fotos se reúnen en un árbol de Navidad cónico en suave rotación.
   - ✨ **SCATTER (Nube Cósmica)**: El árbol explota y se dispersa en una galaxia esférica de gravedad cero.
   - 🔍 **FOCUS (Foto Ampliada)**: Una foto/tarjeta seleccionada viaja hacia el frente de la cámara, ampliada en su marco dorado brillante, mirando directamente al usuario.

3. **Control por Gestos con IA (Google MediaPipe Hands)**:
   - 🖐️ **Mano Abierta (5 dedos extendidos)**: Activa el estado **SCATTER** (dispersión).
   - ✊ **Puño Cerrado**: Activa el estado **TREE** (reúne el árbol).
   - 👌 **Pellizco / Agarre (Pulgar e Índice)**: Activa el estado **FOCUS** (acerca y amplía una foto).
   - 👋 **Movimiento de la Mano**: Rota la escena 3D en tiempo real según la posición de la mano.

4. **Interacción Total con Mouse / Táctil & Teclado**:
   - **Arrastrar (Drag)**: Rota la escena en 3D.
   - **Clic en una Foto**: Raycaster 3D que enfoca directamente la foto pulsada.
   - **Menú hamburguesa**: Navegación, cámara, sonido y carga de archivos.
   - **Barra de modos en la vista principal**: Botones `Árbol`, `Dispersar` y `Enfocar` siempre visibles en la parte inferior.
   - **[H]**: Oculta/Muestra la interfaz para grabaciones de video limpias (modo cinemático).
   - **[Espacio]**: Alterna entre los modos Tree -> Scatter -> Focus.
   - **[Esc]**: Regresa al modo Árbol.
   - **Galería**: Fotos y videos persistentes, filtros y eliminación individual con confirmación.
   - **Cargar Archivos Propios**: Selección de carpetas enteras o archivos individuales de fotos y videos.
   - **Efectos de Sonido Navideños**: Campanas y arpegios armónicos generados en tiempo real mediante Web Audio API.

---

## 🚀 Cómo Ejecutar el Proyecto

Desde la carpeta del proyecto `g:\lia\navidad\animacion-3d`:

```bash
npm run dev
```

Luego abre en tu navegador el enlace local que muestra la terminal (por ejemplo `http://localhost:5173`).

Para compilar la versión optimizada de producción:

```bash
npm run build
```

---

## 📁 Personalización de Fotos

El proyecto incluye por defecto las 9 tarjetas de alta resolución mostradas en los videos:
- `Magic, in FocuSee`
- `Auto Pan & Zoom`
- `Smart Spotlight`
- `Voice Enhancement`
- `Cursor Effects`
- `Noise Reduction`
- `Cut Filler Words`
- `AI Avatars`
- `Dynamic Layout`

Abre **Menú → Seleccionar carpeta** o **Seleccionar fotos y videos**. También puedes usar **Añadir archivos** en la galería.

Los archivos se guardan en Firebase y se recuperan al volver a abrir la página. Las fotos aparecen también en el árbol; los videos se reproducen con controles en la galería. Cada archivo incluye **Eliminar**, con confirmación y reintento si ocurre un error. Se admiten archivos de hasta **20 MiB**; que un video pueda reproducirse depende de sus códecs y del navegador.

La galería usa las rutas `#galeria` y `#arbol`. El menú y los atajos respetan la vista activa, y los videos se pausan al regresar al árbol.

## Conexión con Firebase

`src/database/firebase.js` configura el proyecto Firebase `polinitech` y exporta:

- `app`: la aplicación Firebase inicializada.
- `db`: la instancia de Cloud Firestore de la base de datos predeterminada.
- `auth`: la instancia de Firebase Authentication.
- `ensureGalleryUser()`: restaura una sesión existente o inicia una sesión anónima antes de acceder a la galería.

La biblioteca multimedia usa esta conexión al arrancar. Desde otros módulos dentro de `src/` puedes usar:

```js
import { app, db } from './database/firebase.js';
```

Para leer o guardar datos, Cloud Firestore debe estar creado en el proyecto y sus reglas deben permitir las operaciones correspondientes. Consulta la [guía oficial de Cloud Firestore](https://firebase.google.com/docs/firestore/quickstart).

### Activar acceso a la galería

Las reglas de `observations`, `products` y `plants` no autorizan otras colecciones. El archivo `firestore.rules` conserva esas reglas y añade el acceso de cada usuario a su propia galería y sus fragmentos.

1. En [Firebase Console](https://console.firebase.google.com/project/polinitech/authentication/providers), abre **Authentication → Métodos de acceso** y activa **Anónimo**.
2. Abre **Firestore Database → Reglas**, copia todo el contenido de `firestore.rules` y pulsa **Publicar**.
3. Recarga la aplicación o pulsa **Reintentar** en la galería.

El [proveedor anónimo](https://firebase.google.com/docs/auth/web/anonymous-auth) se activa para todo el proyecto. Las reglas existentes que usan `signedIn()` también reconocen una sesión anónima como autenticada.

La galería pertenece al UID de la sesión. La sesión anónima se conserva en el mismo navegador y origen; cambiar de dispositivo, borrar sus datos o cambiar entre `localhost` y `127.0.0.1` puede abrir otra galería. Para recuperar la misma galería entre dispositivos hay que usar o vincular una cuenta. Si ya hay un usuario autenticado, la aplicación conserva su sesión.

Si usas Firebase CLI, publica únicamente las reglas para conservar los índices existentes de las otras aplicaciones:

```bash
firebase deploy --only firestore:rules --project polinitech
```

La implementación local no activa proveedores ni publica reglas de forma automática. La configuración `firebase.json` referencia solo el archivo de reglas.

### Almacenamiento de fotos y videos

- `src/database/media.js` guarda los metadatos en `christmasMedia/{uid}/files/{id}` y el Base64 en `christmasMedia/{uid}/files/{id}/chunks/{fragmento}`. La ruta usa el UID autenticado, y las reglas verifican ese propietario en cada operación.
- Cada fragmento contiene hasta 650.000 caracteres. Las cargas se dividen en solicitudes menores que los [límites de Firestore](https://firebase.google.com/docs/firestore/quotas).
- Un archivo solo se anuncia como guardado cuando todos sus fragmentos y su estado final han sido confirmados por Firebase. Los errores de permisos o conexión se muestran en la galería.
- Las nueve fotos incluidas y `public/background.mp4` se importan automáticamente una sola vez. Para incorporar otros archivos predeterminados, añade su definición en la configuración de `src/main.js`.
- Eliminar un archivo borra sus fragmentos. Los archivos incluidos dejan un marcador sin contenido multimedia para impedir que vuelvan a importarse después de eliminarlos.
- Las reglas existentes de Firebase deben autorizar también la subcolección `chunks`; las reglas de un documento padre no se heredan automáticamente. Esta implementación no publica ni modifica reglas remotas.
- `firestore.indexes.json` incluye una exención opcional del índice del campo Base64 `data`, que no se consulta por contenido. Se puede desplegar desde el entorno de administración del proyecto.

Si Firebase no está disponible, las imágenes y el video incluidos se muestran como vistas previas locales. Los archivos seleccionados por el usuario no se anuncian como guardados hasta recibir confirmación del servidor.

### Verificación

```bash
npm test
npm run build
```

Las pruebas de almacenamiento usan Firestore simulado: verifican fragmentación, reconstrucción, errores y eliminación sin modificar datos reales. Para las pruebas de interfaz, inicia Vite y un navegador con depuración remota, configura `SMOKE_CDP_URL` y ejecuta `npm run test:browser`. Estas pruebas bloquean el arranque de Firebase y usan archivos de ejemplo aislados.
