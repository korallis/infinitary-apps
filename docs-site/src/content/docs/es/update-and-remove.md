---
source: 8949d6275dea6548
title: Actualizar y quitar Infinitary
description: Cómo recibe cada tipo de instalación una nueva versión estable, y cómo quitar Infinitary conservando tu trabajo guardado.
---

Infinitary busca una nueva versión estable cada pocas horas.
Buscar no descarga nada, y no se instala nada hasta que lo eliges.
Una actualización conserva tu trabajo guardado.

## Cuando sale una nueva versión {#when-a-new-version-is-out}

Aparece un botón redondo con una flecha hacia abajo en la esquina superior derecha de la ventana.
Deja el puntero sobre él para leer «Actualización disponible» y el número de la nueva versión, y presiónalo para ver qué hacer a continuación.
Configuración → **General** muestra lo mismo, en **Versión**.

Para buscar tú mismo, usa cualquiera de estas opciones:

- **Buscar actualizaciones** en **Versión**, en Configuración → **General**.
- **Buscar actualizaciones** en la búsqueda de comandos.
- En una Mac, **Buscar actualizaciones…** en el menú Infinitary.

Lo que hay que hacer a continuación depende de cómo instalaste Infinitary.

## Una copia para Mac de la página de descargas {#a-mac-copy-from-the-downloads-page}

1. Presiona **Actualizar y reiniciar**.
2. Infinitary descarga la nueva versión y comprueba su suma de comprobación y su firma de Apple.
3. Guarda el trabajo de tu tripulación.
   El trabajo en curso termina primero lo que está ejecutando, así que no se pierde nada.
4. Infinitary se reinicia en la nueva versión y retoma el trabajo que la actualización pausó.

Mientras espera al trabajo en curso, **Actualizar más tarde** deja la actualización para cuando vuelvas a elegirla.
Tu trabajo sigue adelante.

Si Infinitary no pudo terminar de reiniciarse, el botón dice **Reiniciar**.
Vuelve a presionarlo cuando se detenga tu trabajo en curso.

Infinitary solo se actualiza a sí mismo desde Aplicaciones.
Si se ejecuta desde la imagen de disco, arrástralo a Aplicaciones, expulsa la imagen de disco y abre la copia de Aplicaciones.

## Una copia para Mac de Homebrew {#a-mac-copy-from-homebrew}

Una copia que instalaste con Homebrew se actualiza a través de Homebrew.
El aviso muestra el comando, con **Copiar comando**:

```sh wrap
brew update && brew upgrade --cask infinitary-labs/tap/infinitary
```

Ejecútalo en Terminal.
Homebrew cierra Infinitary mientras lo reemplaza, así que vuelve a abrir Infinitary cuando termine.

## Linux {#linux}

- **Ubuntu, Debian y Fedora**, desde el paquete .deb o .rpm: presiona **Instalar**.
  Infinitary descarga la nueva versión, la comprueba, guarda el trabajo de tu tripulación y te pide la contraseña, y luego vuelve a iniciarse.
- **Una AppImage**: presiona **Instalar**.
  Infinitary reemplaza el archivo AppImage por la nueva versión y vuelve a iniciarse, sin contraseña.
  Necesita poder cambiar la carpeta en la que está la AppImage.
- **Arch, Omarchy y NixOS** se actualizan a través de su propio gestor de paquetes.
  El aviso muestra el comando, con **Copiar comando**; ejecútalo en una terminal.

Si la instalación no puede terminar, no cambia nada y el trabajo de tu tripulación sigue adelante.
El aviso muestra entonces un comando que instala la misma versión a mano.

## Windows {#windows}

1. Presiona **Actualizar y reiniciar**.
2. Infinitary descarga el nuevo instalador, comprueba su suma de comprobación y guarda el trabajo de tu tripulación.
3. Infinitary se cierra, el instalador lo reemplaza e Infinitary vuelve a abrirse en la nueva versión.

Si la instalación no puede terminar, no cambia nada y el trabajo de tu tripulación sigue adelante.

## Tus otras computadoras y tu teléfono {#your-other-computers-and-your-phone}

Una computadora que agregaste se actualiza desde la computadora donde vive tu primer oficial.
En Configuración → **Dispositivos**, una computadora con otra versión muestra **Actualizar** en su fila.
Recibe la versión de esta computadora, y su trabajo en curso se detiene un momento y continúa después.

Desde una computadora que controla a tu primer oficial, Configuración → **General** tiene una fila para Infinitary en la computadora donde vive tu primer oficial.
Cuando esa computadora tiene una actualización lista, presiona **Actualizar** seguido de su nombre para iniciar la actualización desde donde estás.
Tu teléfono también puede iniciar esa actualización, después de preguntarte primero.
Consulta [Tus otras computadoras](/es/your-other-computers/) y [iPhone y iPad](/es/iphone-and-ipad/).

## Quitar Infinitary {#remove-infinitary}

Quitar la app deja tu trabajo guardado en su lugar, así que al volver a instalar Infinitary sigues donde lo dejaste.
Si esta computadora hace trabajo para otra, presiona primero **Salir** en Configuración → **Dispositivos**.

- **Una copia para Mac de la página de descargas**: cierra Infinitary y muévelo de Aplicaciones a la Papelera.
- **Una copia para Mac de Homebrew**: ejecuta `brew uninstall --cask infinitary` en Terminal.
  Nunca agregues `--zap`: borra tu trabajo guardado.
- **Linux**: quita el paquete con el instalador de software o el gestor de paquetes con el que lo instalaste.
  Para una AppImage, borra el archivo.
- **Windows**: en Configuración de Windows → **Aplicaciones** → **Aplicaciones instaladas**, elige **Desinstalar** en el menú de Infinitary.

Tu trabajo guardado se queda en `~/Library/Application Support/infinitary` en una Mac, en `~/.config/infinitary` en Linux, y en `%APPDATA%\infinitary` en Windows.

### Qué elimina tu trabajo guardado {#what-deletes-your-saved-work}

Esto elimina esa carpeta, y lo que Infinitary guardaba ahí se va con ella:

- `brew uninstall --zap`.
- Una app desinstaladora que también quita los archivos de soporte de una app.
- Mover la propia carpeta a la Papelera, o eliminarla.

En una computadora que hace trabajo para otra, esa carpeta contiene la clave propia de la computadora, sus copias de trabajo y los archivos de sus tareas.
Sin ella, la computadora se vuelve a unir como una entrada nueva, y el trabajo que no había traído se pierde.
Consulta [Una computadora aparece dos veces](/es/troubleshooting/#a-computer-is-listed-twice).
