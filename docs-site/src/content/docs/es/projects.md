---
source: 8639808a6f4bc6d7
title: Proyectos
description: Cómo agregar un proyecto a Infinitary, centrar la ventana en uno, elegir cómo se fusionan sus cambios y quitarlo.
---

Un proyecto es aquello en lo que trabaja tu tripulación: una carpeta tuya, gestionada con git.
Cada tarea pertenece a un proyecto, y cada clave de tarea empieza con la clave de su proyecto, como `WEB-12`.
Tus proyectos aparecen en **Configuración → Proyectos**.

## Agregar un proyecto {#add-a-project}

Puedes agregar un proyecto de dos formas.

- **Pídeselo a tu primer oficial.**
  Di en qué proyecto trabajar, por ejemplo «Clona el proyecto en» seguido de su enlace.
  Tu primer oficial te trae una tarjeta que nombra el proyecto y sus ajustes.
  No se agrega nada hasta que presionas **Agregar proyecto** en esa tarjeta.
- **Agrégalo tú mismo.**
  Abre **Configuración → Proyectos** y usa la fila **Agregar proyecto** al pie de la lista.

La fila **Agregar proyecto** tiene tres botones:

1. **Carpeta en esta computadora** agrega una carpeta que ya tienes.
   Si la carpeta todavía no usa git, Infinitary inicia git ahí con una primera confirmación vacía.
2. **Repositorio de GitHub**, **Repositorio de GitLab** o **Repositorio de Bitbucket** clona un proyecto desde donde se aloja.
   Elígelo en **Tus repositorios de GitHub**, usa **Buscar un repositorio** para buscar, o pega su enlace.
   Con muchos repositorios, puede que algunos no se hayan revisado, y la lista lo dice; pega un enlace para agregar uno que falte.
3. **Proyecto nuevo** empieza un proyecto vacío con el nombre que escribas.

Un proyecto clonado o nuevo va a tu carpeta de proyectos.
La línea **Los proyectos nuevos van en** muestra esa carpeta, y **Elegir carpeta** la cambia.
Los proyectos que ya agregaste nunca se mueven cuando la cambias.

**Clave de tareas** es opcional.
Escribe hasta cuatro letras o dígitos, y las tareas del siguiente proyecto se numeran con ella.
Déjala vacía, e Infinitary crea una clave a partir del nombre del proyecto.

Para un proyecto alojado en otro sitio, pídeselo a tu primer oficial.

## Tu inicio de sesión de GitHub, GitLab o Bitbucket {#your-github-gitlab-or-bitbucket-sign-in}

Para clonar un proyecto y ofrecer sus cambios, Infinitary usa tu inicio de sesión de GitHub, GitLab o Bitbucket.

Si no has iniciado sesión cuando presionas **Repositorio de GitHub**, **Repositorio de GitLab** o **Repositorio de Bitbucket**, la fila muestra **Iniciar sesión en GitHub**, **Iniciar sesión en GitLab** o **Iniciar sesión en Bitbucket** en lugar de tus proyectos.
Ese botón abre **Configuración → Integraciones**, donde viven tus inicios de sesión; consulta [Integraciones](/es/integrations/).
Para GitHub, escribes un código en la página de GitHub en tu navegador.
Para GitLab, puedes iniciar sesión en tu navegador o pegar una clave, en gitlab.com o en tu propio servidor de GitLab.
Para Bitbucket, creas un token de API en tu cuenta de Atlassian y lo pegas, para proyectos en bitbucket.org.
El formulario de la clave nombra los permisos que debes marcar en la página de Atlassian.
Para tu propio servidor de Bitbucket Data Center, versión 8.19 o posterior, escribes su dirección y pegas un token de acceso HTTP con los permisos Project read y Repository write.
Los cambios de un proyecto de Data Center se ofrecen como solicitudes de incorporación de cambios, y la fusión se hace solo en la versión que aprobaste: si alguien inserta cambios mientras tanto, no se fusiona nada y la tarea lo dice.
Un proyecto de Data Center también puede elegir solicitudes de incorporación de cambios por lotes, y tu tripulación puede leer y escribir en el servidor, contribuir a través de tu bifurcación y despertar con los comentarios nuevos en su solicitud de incorporación de cambios y con una comprobación fallida en su rama principal.
Un servidor de Data Center no guarda registros de comprobaciones, ejecuciones ni archivos de versión propios: sus comprobaciones vienen de otro servicio, y cada una enlaza a dónde está su registro.
Tus proyectos de Bitbucket se enumeran a partir de los espacios de trabajo a los que perteneces; con muchos, puede que algunos no se hayan revisado, y la lista lo dice.
Los cambios de un proyecto de Bitbucket se ofrecen como solicitudes de incorporación de cambios, igual que en GitHub y GitLab; un proyecto que agregaste antes de esto funciona igual a partir de su próxima tarea.
La descripción de una solicitud de incorporación de cambios de Bitbucket lleva la historia como texto, y sus imágenes se quedan en la tarjeta.
Un proyecto de Bitbucket también puede elegir solicitudes de incorporación de cambios por lotes, y sus fusiones siguen las estrategias y la cola de fusión que su rama principal tiene en bitbucket.org.
En un proyecto de Bitbucket, tu tripulación también puede leer las canalizaciones del proyecto y el registro de un paso, poner un archivo de una versión en sus Descargas y despertarse con los comentarios nuevos en su solicitud de incorporación de cambios, igual que en GitHub y GitLab; Bitbucket no ofrece la descarga de los artefactos de una canalización.
Tu inicio de sesión se queda en esta computadora.

Si un inicio de sesión deja de funcionar, una tarjeta te pide que vuelvas a iniciar sesión.
El trabajo que lo necesita espera hasta que lo hagas.

## Copias de trabajo {#working-copies}

Tu tripulación nunca trabaja directamente en la carpeta de tu proyecto.
Cada tripulante trabaja en su propia copia de trabajo de tu proyecto, en su propia rama.
Tus archivos se quedan como están hasta que fusionas un cambio.

## Centrarse en un proyecto {#focus-on-one-project}

Con dos proyectos o más, la barra superior muestra una píldora de proyecto.
Presiónala, o presiona ⇧⌘P (Ctrl+Shift+P en Linux y Windows), para abrir una fila con tus proyectos.
Cada píldora cuenta las tareas que te esperan y las tareas que están trabajando.
Elige un proyecto para centrar la ventana en él.

Mientras un proyecto está en el centro:

- El panel Tareas y el tablero de tareas solo muestran las tareas de ese proyecto.
- Actividad solo muestra las líneas sobre ese proyecto, y las líneas que no son de ninguna tarea.
- Las tarjetas de otros proyectos esperan hasta que cambie el centro.
  No se cierra nada, y todos los proyectos siguen enviando notificaciones.
- Una línea corta junto a la píldora dice cuántas tareas te esperan en otros lugares, como «2 esperando en otro lugar».
- Tu primer oficial pone el trabajo nuevo que pides en ese proyecto, a menos que nombres otro.

Presiona la **×** junto a la píldora (**Mostrar todos los proyectos**), o elige **Todos los proyectos** en la fila, para volver a ver todo.
Infinitary recuerda tu centro cuando lo reinicias.

## Cómo llegan los cambios a tu proyecto {#how-changes-reach-your-project}

Abre un proyecto en **Configuración → Proyectos** para elegir cómo se fusiona su trabajo terminado.
**Adónde van los cambios** ofrece:

- **solicitudes de incorporación de cambios**: cada cambio se ofrece como una solicitud de incorporación de cambios en GitHub, GitLab o Bitbucket.
- **solicitudes de incorporación de cambios por lotes**: tus cambios aprobados se combinan en una solicitud de incorporación de cambios del lote, con una confirmación por cada cambio, y se fusionan cuando se superan sus comprobaciones.
- **fusión local**: el cambio se fusiona en el proyecto en esta computadora, sin solicitud de incorporación de cambios.

Un proyecto que solo se aloja en esta computadora ofrece solo **fusión local**.

Cuando un cambio está listo, su tripulante te trae una tarjeta de fusión.
El botón de la tarjeta dice lo que hace, como **Fusionar la solicitud de incorporación de cambios**, **Fusionar la rama** o **Fusionar en el próximo lote**.
Si las comprobaciones todavía están en curso, el botón dice **Fusionar cuando se superen las comprobaciones**, e Infinitary fusiona cuando se superen.

**Preguntar antes de fusionar** decide quién fusiona.
Está activado para un proyecto nuevo, así que el trabajo terminado espera tu palabra.
Desactívalo, y el trabajo que supera las comprobaciones puede fusionarse sin preguntarte.

**Cuidado** define con qué minuciosidad se comprueba el trabajo: **Rápido**, **Predeterminado** o **Cuidadoso**.

## Quitar un proyecto {#remove-a-project}

1. Abre el proyecto en **Configuración → Proyectos**.
2. Presiona **Quitar** en su última línea.
3. Presiona **Quitar** de nuevo para confirmar.

Quitarlo saca el proyecto de la lista.
Su carpeta y sus tareas terminadas se quedan.
Si el proyecto todavía tiene tareas, Infinitary las nombra, y primero las terminas o las abandonas.

## Siguiente {#next}

- [Tareas y tripulantes](/es/tasks-and-crewmates/)
- [Tarjetas y decisiones](/es/cards-and-decisions/)
