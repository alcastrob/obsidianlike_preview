# CLAUDE.md

Guía para Claude Code al trabajar en este repositorio.

## Qué es este proyecto

Extensión de VS Code (TypeScript) que muestra la nota Markdown activa en un panel lateral (`WebviewView`), reutilizando **en tiempo de ejecución, sin copiar código**, el bundle del renderer CodeMirror 6 de la extensión hermana `obsidianlike` (`../obsidianlike`, `out/editor.bundle.js`). Es una dependencia dura: `package.json` declara `extensionDependencies: ["angelCastro.obsidian-like"]`.

## Comandos

```bash
npm install
npm run compile     # tsc -p ./
npm run watch
npm run lint         # eslint src --no-color
```

Probar manualmente: `F5` abre un "Extension Development Host" (requiere `obsidianlike` instalada en ese mismo perfil, con `out/editor.bundle.js` ya compilado — `npm run compile && npm run build-webview` en `../obsidianlike`, o simplemente tenerla instalada como `.vsix`). En la práctica, hasta ahora se ha probado siempre instalando el `.vsix` empaquetado (`npm run package`) en el perfil real "Obsidian like" (`code --profile "Obsidian like" --install-extension ...`), no con F5 — ver "Estado" al final.

## Por qué el panel es editable, no de solo lectura

El motor de `obsidianlike` (`webview-src/editor.js`, ~8760 líneas) es CodeMirror 6 **siempre editable** — no existe ningún `EditorState.readOnly`/`EditorView.editable.of(false)` en ese código, y su `EditorView` interno no se expone en `window`, así que no hay forma de forzarlo a solo-lectura desde fuera sin modificar ese archivo fuente. El usuario de este proyecto pidió explícitamente **no duplicar/parchear ese código** (la dependencia dura hace innecesaria la duplicación). La decisión tomada, con el usuario, fue: aceptar que el panel es una **vista secundaria en vivo, totalmente editable**, sincronizada bidireccionalmente con el documento real — como tener la nota abierta dos veces. Si en el futuro se quiere un modo solo-lectura de verdad, las únicas rutas son (a) parchear `editor.js` en el build de `obsidianlike` para soportar un flag `readOnly` (fork mínimo, ver la conversación que originó este proyecto), o (b) un bloqueo de teclado a nivel DOM en este proyecto (imperfecto: no cubre clics que mutan el documento, p. ej. un checkbox de tarea).

## Arquitectura

- `src/activeMarkdownDocument.ts` (`ActiveMarkdownDocumentTracker`) — copiado tal cual de `../obsidianlike_links/src/activeMarkdownDocument.ts`. Deliberadamente NO usa `vscode.window.activeTextEditor` (ver el comentario en el propio archivo y `../obsidianlike_links/CLAUDE.md` para el historial completo del bug de timing que motivó el debounce + sondeo).
- `src/noteUtils.ts` — resolución de wikilinks/transclusiones (`resolveNoteUri`, `splitTarget`), encabezados (`parseHeadings`), índice de notas del workspace (`buildNoteIndex`) y mapa de imágenes para `![[imagen.png]]` (`getImageMap`/`getAttachmentRoots`). Reimplementación deliberada y pequeña (no algo que `obsidianlike` exponga: su `activate()` no hace `return {...}`, no hay API pública que reutilizar) — mismo patrón que ya usa `obsidianlike_links` con su propio `wikilinks.ts`. Si `obsidianlike` cambia sus reglas de resolución de wikilinks (`resolveNoteUri`/`splitDirHint` en su `src/extension.ts`), replicar el cambio aquí.
- `src/views/panelViewProvider.ts` (`PanelViewProvider`) es el núcleo:
  - `bindToActiveDocument()` se llama al abrir el panel, en cada cambio de pestaña activa (`tracker.onDidChange`) y al volver a hacer visible el panel. Comprueba que `angelCastro.obsidian-like` esté instalada/activa (si no, HTML de aviso) y que haya una nota Markdown activa (si no, HTML de diagnóstico vía `tracker.describeActiveTab()`). Si la nota activa ya es la misma que se está mostrando, no hace nada — evita recargas innecesarias del webview en eventos redundantes.
  - Al cambiar de nota, **reconstruye el HTML completo** del webview (no hay mensaje "cambiar de documento" en el protocolo de `editor.js` — cada nota es un montaje nuevo de CodeMirror). Esto reinicia el scroll/selección, igual que si `obsidianlike` abriera un panel nuevo para esa nota.
  - `buildHtml()` genera el wrapper HTML: CSP (sin `'unsafe-eval'` — a propósito, ver "Fuera de alcance" en `readme.md`, ya que sin él las consultas Dataview JS no funcionarían de todos modos porque no hay handler `run-dataview-query`/`dataview-script-result` aquí), la estructura de body **exactamente igual** a la de `resolveCustomTextEditor`/`buildHtml` en `../obsidianlike/src/extension.ts` (`#doc-breadcrumb`, `#doc-header > #doc-title` (contenteditable), `#doc-divider`, `#editor`) — **esto no es cosmético, es obligatorio**: `editor.js` hace `document.getElementById('doc-title').textContent = ...` sin comprobar null en su bootstrap (línea ~8423-8425 del bundle fuente); si falta ese elemento, la excepción no capturada rompe todo el script, incluido el montaje del propio editor. No quitar esos elementos del HTML aunque no se use su funcionalidad (rename/breadcrumb). Los valores de padding/margin de `#doc-breadcrumb`/`#doc-header` sí se apartaron deliberadamente de los de `obsidianlike` (más estrechos aquí) — ver el punto siguiente.
  - **Márgenes reducidos frente al editor principal**: `editor.js` fija `.cm-content` con `max-width: 780px; padding: 16px 28px 120px` vía `EditorView.theme()`, dimensionado para el editor principal a ancho completo. En este panel lateral (normalmente mucho más estrecho que 780px) ese padding era el margen visible más grande alrededor de la nota, así que `buildHtml()` lo sobreescribe con una regla `#editor .cm-content { max-width: none; padding: 6px 10px 24px; }` **con `!important`** — necesario porque la regla de `editor.js` se inyecta en un `<style>` propio después del nuestro, con la misma especificidad (una clase), y ganaría por orden en el DOM si no. El padding de `#doc-breadcrumb`/`#doc-header` (propios de este archivo, no del bundle) se redujo en la misma pasada, de `8px/14px 20px` a `4px/6px 8px`.
  - `<script src>` apunta a `webview.asWebviewUri(Uri.joinPath(obsidianlikeExt.extensionUri, 'out', 'editor.bundle.js'))` — el bundle real de la extensión instalada, nunca una copia local. `localResourceRoots` incluye esa carpeta `out` de `obsidianlike` (para poder cargar el script) más las raíces de adjuntos del vault (`getAttachmentRoots`, misma lógica que `obsidianlike`, lee la config `obsidianLike.attachmentsLocation`/`attachmentsFolder` — namespace de configuración de la OTRA extensión, deliberado, para que este panel respete lo que el usuario ya configuró allí).
  - **Protocolo postMessage implementado** (subconjunto de lo que soporta `editor.js` — ver `../obsidianlike/CLAUDE.md` para la tabla completa si hace falta añadir más):
    - Host → webview: HTML inicial vía `window.__vaultInitial` (contenido, fuentes, `noteIndex`, `imageMap`, colores de resaltador — todo lo que `editor.js` lee al arrancar), `theme-css` (mandado ~300ms después por `setTimeout`, igual que en `obsidianlike` — **nunca inlinear el CSS del tema en el HTML**, puede traer `<style>` embebido en SVGs data-URL de un theme.css real y rompería el parser), `note-index` (cuando cambia el vault), `external-update` (cuando el documento cambia desde OTRO editor), `tasks-query-result` (respuesta a `run-tasks-query`), `tasks-changed` (reenviado desde `onDidChangeTasks` de la extensión de tareas, para invalidar/refrescar cada bloque ```tasks``` visible).
    - Webview → host: `sync` (aplicado vía `WorkspaceEdit`, ver `applySync()`), `open-note`/`open-transclusion` (navega en el editor principal, nunca en este panel — ver `openInEditor()`), `get-transclusion`/`get-headings` (responden leyendo el archivo destino), `open-url`, `reveal-path`, `toggle-task`, `run-tasks-query`/`toggle-task-at-location`/`edit-task-at-location` (bloques ```tasks```, ver más abajo).
    - **No implementados a propósito**: `rename`, `get-content`/`content-for-save` (round-trip de guardado, ver limitación en `readme.md`), `run-dataview-query` y sus variantes, `paste-image`/`drop-files`, `check-external-file`, `open-external-file`. Los widgets correspondientes en `editor.js` simplemente no reciben respuesta — para dataview se quedan en su estado "cargando"; para el resto, degradan sin romper el resto del render.
  - **Bloques ```tasks``` (`run-tasks-query`/`toggle-task-at-location`/`edit-task-at-location`)**: mismo patrón de dependencia blanda con `angelCastro.obsidian-like-tasks` que `getTasksApi()`/el handler de `run-tasks-query` en `../obsidianlike/src/extension.ts` (ver su CLAUDE.md) — replicado en `panelViewProvider.ts` en vez de reutilizado, porque cada `CustomTextEditorProvider`/`WebviewViewProvider` resuelve la extensión de tareas por su cuenta (no hay un punto compartido entre ambos repos para esta lógica). Reportado como "el listado de un bloque ```tasks``` nunca carga, se queda en 'Cargando consulta de tareas'" — el bug real era que `handleMessage()` no tenía ningún `case` para `run-tasks-query`, así que `editor.js` mandaba la petición y nunca recibía `tasks-query-result` de vuelta; el widget (`TasksQueryWidget` en `editor.js`) no tiene timeout, así que se quedaba en su placeholder de carga para siempre. `toggle-task-at-location`/`edit-task-at-location` (checkbox y botón "editar" de cada fila del listado, que puede apuntar a cualquier fichero del vault, no solo a la nota abierta en el panel) y la suscripción a `onDidChangeTasks` (`ensureSubscribedToTasksChanges()`, reenvía `tasks-changed` para que un cambio de tarea en OTRO editor/archivo refresque el listado) se añadieron en el mismo arreglo, ya que sin ellos el listado cargaba pero quedaba de solo-lectura/desactualizado — mismo criterio que el resto de este panel (nota editable, sincronizada en vivo). `editTaskAtLocation` abre el diálogo propio de la extensión de tareas (`WebviewPanel` aparte, no algo que este panel renderice) tal cual hace `obsidianlike`.
  - **Bucle de eco evitado con `applyingOwnEdit` + `lastSyncedContent`**: mismo patrón que `applyingOwnEdit`/`lastOwnContent` en `resolveCustomTextEditor` de `obsidianlike` — sin esto, cada `sync` propio se reenviaría de vuelta como `external-update`, y cada `external-update` propio... en fin, ver el comentario largo en el `extension.ts` de `obsidianlike` sobre por qué el orden importa (`applyingOwnEdit = true` antes de `applyEdit`, `= false` en el `finally`, `lastSyncedContent` actualizado solo tras resolver).
  - **No hay temporizador de autoguardado propio aquí** (a diferencia de `obsidianlike`, que sí tiene uno de 3s configurable) — este panel no gestiona el guardado en absoluto; depende de que el usuario guarde desde donde sea (Ctrl+S en el editor principal si lo hay, `files.autoSave`, o el propio autoguardado de `obsidianlike` si la nota también está abierta ahí). Si la nota SOLO está abierta en este panel (sin pestaña en el editor principal), no hay ningún autoguardado activo — queda dirty hasta que algo la guarde explícitamente.

## Nota fijada (`obsidianlikePreview.pinnedNote`)

Por defecto el panel sigue la pestaña Markdown activa (`ActiveMarkdownDocumentTracker`). El usuario puede fijar una nota concreta (que el panel deje de seguir la pestaña activa) de dos formas, ambas leyendo/escribiendo la misma opción `obsidianlikePreview.pinnedNote`:

1. **`pinActiveNote()`** (comando `obsidianlikePreview.pinActive`, botón 📌 en el título del panel) — fija la nota que esté activa en ese momento (`tracker.getDocument()`).
2. **Editando la opción a mano** — `refreshPinnedUri()` la lee al arrancar y en cada `onDidChangeConfiguration` que la afecte.

`resolvePinnedNotePath()` acepta tanto rutas relativas al workspace como absolutas (Windows o POSIX), normalizando `\` → `/` — necesario porque `Uri.joinPath` (a diferencia de `path.join`) solo entiende `/`, y `asRelativePath()` devuelve separadores nativos del SO (`\` en Windows) al escribir. `setPinnedNote()` captura errores de `workspace.getConfiguration(...).update(...)` (p. ej. `ConfigurationTarget.Workspace` sin ninguna carpeta abierta como workspace) y los muestra con `showErrorMessage` — antes fallaban en silencio.

`getTargetDocument()` es el único punto que decide qué nota mostrar: la fijada si `pinnedUri` está definida, si no la de `tracker.getDocument()`. `bindToActiveDocument()` ya no llama a `tracker.getDocument()` directamente.

### Arrastrar-y-soltar sobre el panel: intentado y descartado

Se implementó (y luego se retiró) un mecanismo para fijar una nota arrastrando su pestaña sobre el panel. Requería que un script propio (inyectado en `buildHtml()`, antes de `<script src="editor.bundle.js">`) hablara con el host — pero `acquireVsCodeApi()` solo puede llamarse una vez por webview y `editor.js` ya la llama por su cuenta sin exponer la instancia en `window`. La solución (que llegó a funcionar a nivel de JS, y se dejó documentada aquí por si algún día vuelve a hacer falta el mismo truco para OTRA cosa) era envolver la función global ANTES de que `editor.js` se cargara:

```js
var original = window.acquireVsCodeApi;
var cachedApi = null;
var shim = function () { if (!cachedApi) { cachedApi = original(); } return cachedApi; };
window.acquireVsCodeApi = shim; // editor.js, al llamarla después, recibe la misma instancia cacheada — nunca lanza
```

El problema real no era ese bridge, sino algo más fundamental: **probado en un VS Code real, arrastrar una pestaña del editor O un ítem del Explorer sobre el panel no dispara ningún evento `drop` dentro del contenido del `WebviewView`** — ni siquiera con un listener en fase de captura sobre `window` (se verificó añadiendo un mensaje de diagnóstico incondicional en cada `drop`, y no llegó ninguno). Solo un archivo real soltado desde el explorador de archivos del *sistema operativo* llega como un `drop` de verdad (eso lo sigue manejando `editor.js` por su cuenta, sin relación con esto). Conclusión: VS Code no reenvía sus arrastres *internos* (pestañas, Explorer) al DOM de un `WebviewView` — al menos no como un evento `drop` de HTML5 estándar. Si se quisiera revisar esto en el futuro, habría que investigar si existe alguna API de VS Code específica para ello (más allá del estándar de navegador), no seguir por este camino.

## Convenciones

Mismas que el resto del monorepo "Obsidian like" (ver `../obsidianlike_links/CLAUDE.md`): UI en español, código/identificadores en inglés, comentarios solo cuando el porqué no es obvio, `activate()`/`deactivate()` como único punto de registro.

## Monorepo hermano

Repos hermanos bajo `c:\git\` (`obsidianlike`, `obsidianlike_links`, `obsidianlike_search`, `obsidianlike_tasks`, `obsidianlike_calendar`, ...). `obsidianlike/make.bat` compila, desinstala e instala cada uno en el perfil de VS Code "Obsidian like" — si se quiere que incluya también este proyecto, añadir el bloque correspondiente ahí (nombre del `.vsix`, id `angelCastro.obsidianlike-preview`).

## Estado

En uso real (instalada como `.vsix` en el perfil "Obsidian like", no solo probada con F5). Confirmado por el usuario, con logs reales de `View > Output > "Obsidian-like Preview"`: el panel carga el bundle de `obsidianlike`, activa la extensión correctamente y sigue la pestaña activa (`ActiveMarkdownDocumentTracker` funcionando: se ven sus eventos `onDidChangeTabs`/`sondeo`/`bindToActiveDocument` en el log real).

El fijado de nota se implementó en dos iteraciones: la primera versión de `setPinnedNote()`/`resolvePinnedNotePath()` tenía un bug real (rutas con `\` y rutas absolutas no se resolvían, `Uri.joinPath` solo entiende `/`) que el usuario detectó probándolo — corregido (ver más arriba), reempaquetado/reinstalado y **confirmado por el usuario que funciona de punta a punta**: tanto el botón "Fijar la nota activa" como editar `pinnedNote` directamente.

El arrastrar-y-soltar se intentó y se descartó (ver arriba) — confirmado con dos pruebas reales del usuario (una pestaña del editor, un ítem del Explorer), ninguna dejó traza del mensaje de diagnóstico que sí se había añadido para detectarlo, así que la ausencia de evento `drop` está bien verificada, no es solo una suposición.

Los bloques ```tasks``` (`run-tasks-query`/`toggle-task-at-location`/`edit-task-at-location`, ver más arriba) se implementaron tras reportarse que el listado se quedaba indefinidamente en "Cargando consulta de tareas…" — **confirmado por el usuario que funciona** tras el arreglo.

Pendiente de verificar a fondo: la sincronización bidireccional de ediciones (`sync`/`external-update`) en sesiones largas, y el resto de mensajes del protocolo (`get-transclusion`, `get-headings`, `open-note`, `toggle-task`) con casos reales.
