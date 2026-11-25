---
source: 2633a75241365106
title: Instalar
description: Descarga Infinitary estable para Mac, Linux o Windows, o pide una invitación privada de TestFlight para iPhone y iPad.
---

Descarga la versión estable de Infinitary para [Mac](https://getinfinitary.com/downloads/#macos), [Linux](https://getinfinitary.com/downloads/#linux) o [Windows](https://getinfinitary.com/downloads/#windows).
Si quieres verificar una descarga, compara su suma de comprobación SHA-256 con la que aparece junto a ese archivo en la página de descargas.

## En una Mac {#on-a-mac}

Descarga la **Imagen de disco (.dmg)** para una Mac con Apple silicon o con Intel.
Ábrela y arrastra Infinitary a **Aplicaciones**.
Si eliges el **ZIP**, ábrelo y mueve la app Infinitary extraída a **Aplicaciones**.

## En Linux {#on-linux}

Elige el paquete **.deb** para Ubuntu o Debian, o el paquete **.rpm** para Fedora, y ábrelo con el instalador de software de tu sistema.
Para Arch u Omarchy, usa la receta del paquete de Arch; para NixOS, usa la receta de Nix.
En otros sistemas Linux x64, descarga la **AppImage**, permite que se ejecute como programa en las propiedades del archivo y luego ábrela.

## En Windows {#on-windows}

Infinitary para Windows es experimental.
Descarga el **instalador (.exe)** para una PC con Windows 11 y un procesador Intel o AMD de 64 bits.
El instalador todavía no está firmado con un certificado que Microsoft verifique, así que Windows no conoce a su editor y avisa dos veces antes de instalar:

1. Si tu navegador dice que el archivo no se descarga con frecuencia, elige **Conservar** y luego **Conservar de todos modos**.
2. Cuando lo abras, Windows dice «Windows protegió su PC» con un editor desconocido.
   Elige **Más información** y luego **Ejecutar de todas formas**.

Si el Control inteligente de aplicaciones está activado, Windows bloquea esta versión y no ofrece ninguna forma de ejecutarla.
Mantén el Control inteligente de aplicaciones activado y espera la versión firmada.

El instalador instala Infinitary solo para ti, lo agrega al menú Inicio y lo abre.
Si tu PC no tiene Git for Windows, Infinitary ofrece instalarlo en su primer inicio, porque tu tripulación lo necesita.

## En iPhone y iPad {#on-iphone-and-ipad}

Infinitary para iPhone y iPad está en TestFlight privado.
[Escribe a help@getinfinitary.com para pedir una invitación](mailto:help@getinfinitary.com?subject=Infinitary%20TestFlight%20request).
Consulta [iPhone y iPad](/es/iphone-and-ipad/) para ver cómo unirte a tu computadora.

## Lo que necesitas {#what-you-need}

- **Una computadora.**
  Una Mac con macOS 12 o posterior, una computadora Linux con procesador x64, o una PC con Windows 11 y procesador x64 (experimental).
- **Una suscripción de IA.**
  Tu primer oficial necesita al menos una suscripción que pueda responder: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter con una clave de API, o Amazon Bedrock con tu inicio de sesión de AWS.
- **Claude Code, para Claude.**
  Si usas una suscripción de Claude, instala primero Claude Code en esa computadora.
  Infinitary usa el Claude Code que instalaste.

## Tu primer inicio {#your-first-launch}

1. Abre Infinitary.
   La ventana te da la bienvenida y muestra un botón para cada proveedor.
2. Elige tu proveedor e inicia sesión como te lo pida: en tu navegador, con un código o con una clave que pegas.
3. Cuando una suscripción puede responder, se abre el cuadro de mensaje y tu primer oficial está listo.

Configura tu primer oficial en una computadora que permanezca encendida tanto como sea posible.
Tus otros dispositivos necesitan que tu primer oficial esté despierto.

Para actualizar o quitar Infinitary más adelante, consulta [Actualizar y quitar Infinitary](/es/update-and-remove/).
Si algo no funciona, consulta [Obtener ayuda](/es/get-help/).
