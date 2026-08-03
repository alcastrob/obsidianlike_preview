# Obsidian-like Preview

Extensión de VS Code que muestra la nota Markdown activa, renderizada en un panel lateral, reutilizando **directamente** el motor de renderizado (CodeMirror 6, "live preview" estilo Obsidian) de la extensión hermana `obsidianlike` (`../obsidianlike`) — sin copiar ni reimplementar ese código: carga en tiempo de ejecución el mismo `out/editor.bundle.js` desde la instalación de esa extensión.

## Requisito

Esta extensión **depende** de que `obsidianlike` (`angelCastro.obsidian-like`) esté instalada y activa (`extensionDependencies` en `package.json`). Si no lo está, el panel muestra un mensaje pidiendo instalarla en vez de fallar.

## Funcionalidad

- **Panel "Obsidian-like Preview"** (icono en la barra de actividad, se puede arrastrar a la barra lateral secundaria/derecha): muestra la nota Markdown de la pestaña activa, renderizada con el mismo "live preview" que `obsidianlike` (encabezados, listas, tablas, callouts, código, imágenes, `[[wikilinks]]` con clic para abrir/crear, transclusiones `![[nota]]`).
- **Sincronizado en ambas direcciones**: como el motor de `obsidianlike` no tiene un modo solo-lectura (es CodeMirror 6 siempre editable, y su estado interno no se expone fuera del bundle), este panel es en realidad una **vista secundaria en vivo** de la misma nota — editar en el panel edita el documento real, y cualquier cambio hecho en otro editor de esa misma nota se refleja aquí automáticamente.
- **Comando "Obsidian-like Preview: Actualizar panel"** (icono de refresco en el título del panel): fuerza una reconstrucción completa, útil si algo quedó desincronizado.
- **Consultas en vivo `\`\`\`tasks\`\`\`** (requiere la extensión hermana `angelCastro.obsidian-like-tasks` instalada): igual que en `obsidianlike`, se listan/marcan/editan tareas de todo el vault, y el listado se refresca solo cuando una tarea cambia en cualquier otro editor.
- **Fijar una nota concreta** (en vez de seguir la pestaña activa), de dos formas equivalentes — ambas leen/escriben la misma opción `obsidianlikePreview.pinnedNote`:
  1. **Botón/comando "Fijar la nota activa en el panel"** (📌, en el título del panel): fija la nota que tengas abierta en el editor principal en ese momento.
  2. **Editar la opción directamente** en la configuración: `obsidianlikePreview.pinnedNote`, admite tanto una ruta relativa a la raíz del workspace (p. ej. `Proyectos/Idea.md`) como una ruta absoluta.
  Mientras hay una nota fijada aparece un botón "Dejar de fijar" (📌) en el título del panel, que la vacía y hace que el panel vuelva a seguir la pestaña activa. Vaciar la opción a mano tiene el mismo efecto.

  Se intentó también soportar **arrastrar una pestaña sobre el panel** para fijarla, pero se comprobó (probando en un VS Code real) que VS Code no entrega ningún evento `drop` dentro del contenido de un `WebviewView` para un arrastre *interno* (ni desde una pestaña del editor ni desde el Explorer) — a diferencia de soltar un archivo real desde el explorador de archivos del sistema operativo, que sí funciona con normalidad como adjunto/imagen. Ese código se retiró; los dos mecanismos de arriba son los únicos soportados.

### Fuera de alcance (v1)

Para mantener el panel simple, deliberadamente **no** se implementa:
- Consultas en vivo `\`\`\`dataview\`\`\`` (ese bloque se queda en su estado "cargando" indefinidamente — el widget en sí sigue siendo el de `obsidianlike`, solo que este panel no responde a esa petición). Los bloques `\`\`\`tasks\`\`\`` sí están soportados, ver más arriba.
- Renombrar la nota desde el título (H1) del panel.
- El *round-trip* `get-content`/`onWillSaveTextDocument` que usa `obsidianlike` para capturar el último tecleo justo antes de guardar: si guardas (Ctrl+S) en otro editor a menos de ~400 ms del último carácter escrito en este panel, ese último tecleo podría no llegar a tiempo al documento real.

## Estructura del proyecto

```
src/
  extension.ts               Punto de entrada: registra el panel y los comandos (refresh/pinActive/unpin)
  activeMarkdownDocument.ts  Rastrea el documento Markdown de la pestaña activa (copiado de obsidianlike_links)
  noteUtils.ts                Resolución de wikilinks/transclusiones, encabezados, índice de notas, mapa de imágenes
  views/
    panelViewProvider.ts      El panel (WebviewView): construye el HTML que carga out/editor.bundle.js de `obsidianlike`,
                               el protocolo postMessage de sincronización (sync/external-update/get-transclusion/...)
                               y la lógica de nota fijada (pinActiveNote/setPinnedNote/resolvePinnedNotePath)
media/
  icon.svg                    Icono del contenedor en la barra de actividad
```

## Desarrollo

Requisitos: Node.js 20+, VS Code, y la extensión `obsidianlike` instalada en el mismo perfil (para tener `out/editor.bundle.js` compilado — ver `../obsidianlike/make.bat` o `npm run package` en ese proyecto).

```bash
npm install
npm run compile   # o npm run watch
```

Para probar, abre este proyecto en VS Code y pulsa `F5`. En la ventana "Extension Development Host", abre una carpeta con notas `.md` y arrastra el panel "Obsidian-like Preview" a donde prefieras (p. ej. la barra lateral secundaria/derecha).

## Empaquetar e instalar

```bash
npm run package    # genera obsidianlike-preview-<version>.vsix con vsce
```

Este proyecto es parte del monorepo de extensiones "Obsidian like"; se puede añadir a `../obsidianlike/make.bat` para que lo compile/instale junto con las demás.

## Estado

Primera versión, en uso real (instalada como `.vsix` en el perfil "Obsidian like"). Confirmado por el usuario: el panel carga correctamente y sigue la pestaña Markdown activa, y el fijado de nota (botón "Fijar la nota activa" y la opción `obsidianlikePreview.pinnedNote`) funciona de punta a punta tras el fix del bug de resolución de rutas (barra invertida y rutas absolutas). El arrastrar-y-soltar sobre el panel se intentó y se descartó (ver arriba), confirmado con dos pruebas reales (pestaña del editor e ítem del Explorer): VS Code no entrega el evento `drop` dentro de un `WebviewView` para arrastres internos.
