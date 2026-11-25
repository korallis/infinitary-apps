---
source: 3e0fd8cde41ac0cf
title: Tus otras computadoras
description: Agrega tus otras computadoras para controlar a tu primer oficial desde cualquiera de ellas, dejar que hagan el trabajo de tus proyectos y guardar una copia que pueda tomar el relevo.
---

Tu primer oficial vive en una computadora.
Sus tareas, tarjetas y conversación se quedan ahí.
Desde cualquier computadora que agregues puedes controlar a tu primer oficial, y cualquier computadora que agregues puede hacer el trabajo de un proyecto.

Encuentras todo esto en Configuración → **Dispositivos**, en **Tus dispositivos**.
Abre Configuración con ⌘, (Ctrl+, en Linux y Windows).

## La computadora donde vive tu primer oficial {#the-computer-where-your-first-mate-lives}

Elige una computadora que permanezca encendida tanto como sea posible.
Tus otras computadoras y tu teléfono la necesitan despierta, con Infinitary abierto.

Mientras está en reposo o fuera de alcance:

- Otra computadora muestra lo último que vio, y dice «Los cambios están desactivados».
  Un mensaje que escribes ahí no se envía, y tus palabras se quedan en el cuadro de mensaje hasta que esa computadora vuelva.
- Automatización solo se ejecuta mientras Infinitary está abierto ahí y la computadora está despierta.
  Una ejecución perdida mientras tanto ocurre una vez cuando vuelve.

## Agregar una computadora {#add-a-computer}

1. En la computadora donde vive tu primer oficial, abre Configuración → **Dispositivos**.
2. Presiona **+ Una computadora**.
3. Escribe la dirección de la otra computadora y presiona **Agregar**.

Agregar una computadora por su dirección es la forma de empezar: esta computadora mantiene actualizada a la otra y la alcanza por sí sola, sin que tengas que ir allí después de configurarla.
Escribe la dirección que usas con SSH para la otra computadora, como `you@mini.local`.
Sesión remota debe estar activada ahí; en Linux, su servidor SSH.
Las computadoras de la misma red aparecen en **En esta red**, para que puedas elegir una.
También puedes pedirle a tu primer oficial que agregue una computadora, y te recomienda la dirección.

En una Mac nueva o una computadora Linux x64 nueva, el primer inicio de Infinitary muestra la dirección que hay que escribir: elige **Configurar desde la computadora de tu primer oficial**.
Muestra primero la dirección de esta computadora en la red privada, como la de Tailscale, y luego su dirección en la red local, cada una con **Copiar**.
Cuando la computadora donde vive tu primer oficial la agrega, esa ventana abre a tu primer oficial por sí sola, siempre que todavía no se haya configurado nada en ella.
Una ventana en la que ya iniciaste sesión, agregaste un proyecto o hablaste con su primer oficial conserva su propio primer oficial, y lo mismo pasa con una ventana junto a un Infinitary que iniciaste tú mismo desde Terminal.
Si Infinitary estaba cerrado en esa computadora cuando se agregó, abre a tu primer oficial la próxima vez que se inicie, sin importar lo que se haya configurado en él.
Una PC con Windows y una computadora Linux Arm se unen con **Pegar su enlace** en su lugar.

Debajo de la dirección, **¿No puedes activar la Sesión remota allí?** ofrece otras dos formas.
Cada una agrega el mismo tipo de computadora.

**Pegar un enlace en Infinitary allí**, cuando estás en esa computadora o es una PC con Windows.
Copia el enlace y luego abre Infinitary por primera vez en la otra computadora.
En **Tu primer oficial está en otra computadora**, elige **Pegar su enlace**, pégalo y presiona **Continuar**.
Infinitary pregunta una vez si quieres controlar a tu primer oficial desde ahí; presiona **Controlarlo desde aquí**.

**Ejecutar un comando allí**, cuando puedes escribir en Terminal ahí pero Sesión remota está desactivada.
Copia el comando y ejecútalo una vez en Terminal en la otra computadora, como el usuario que debe hacer su trabajo.
Obtiene Infinitary desde esta computadora, así que ambas necesitan la misma red.

Cuando tu primer oficial vive en una PC con Windows, **+ Una computadora** ofrece solo el enlace y el comando.

Un enlace o un comando funciona una vez, durante diez minutos, y puedes presionar **Detenerlo** antes.
También puedes unirte desde la otra computadora: en su primer inicio, elige **Unirse por su dirección** y escribe la dirección de la computadora donde vive tu primer oficial.

## Controlar a tu primer oficial desde otra computadora {#control-your-first-mate-from-another-computer}

Cuando una computadora se ha unido, abrir Infinitary ahí muestra a tu primer oficial.
La parte superior de la ventana dice «Controlando tu primer oficial en» y el nombre de esa computadora.
Tus tarjetas, tareas y conversación se quedan en la computadora donde vive tu primer oficial.

Cada computadora conserva su propia Apariencia, Teclado y Paneles.
Las demás secciones de Configuración se leen y se cambian en la computadora donde vive tu primer oficial.

Para dejar de hacerlo, abre Configuración → **Dispositivos** en esa computadora y presiona **Salir**.
Para desconectar una computadora de la computadora donde vive tu primer oficial, abre su menú, los tres puntos de su fila, y elige **Quitar**.
Una computadora que solo controla a tu primer oficial necesita un enlace nuevo para volver.

## Una computadora que hace trabajo {#a-computer-that-runs-work}

Cualquier computadora que agregues puede hacer el trabajo de un proyecto, sin ninguna ventana abierta ahí.
Inicia sesión en sus propias suscripciones, y una tarea que se ejecuta ahí solo usa esas.
Inicia su sesión en una suscripción en Configuración → **Inteligencia**, donde los inicios de sesión de cada computadora aparecen bajo su nombre.
Luego dale un proyecto.

En Configuración → **Proyectos**, abre un proyecto y define **Se ejecuta en**: **Automático**, **Esta computadora**, o una de **Tus computadoras**.
Mientras esa computadora está fuera de alcance, las tareas del proyecto esperan, y nunca se ejecutan en esta computadora en su lugar.

Una computadora también puede hacer trabajo como otro usuario en la computadora donde vive tu primer oficial.
Presiona **+ Como otro usuario** para crear su comando.

Quitar una computadora que hace trabajo trae primero de vuelta su trabajo sin fusionar.

## Mover una tarea a otra computadora {#move-a-task-to-another-computer}

Una tarea iniciada puede pasar a otra computadora que hace trabajo.
Abre su registro y presiona **Mover a una computadora**, y luego elige adónde va.
Conserva su clave, su rama, sus archivos y su registro.
La tarea se mueve cuando su tripulante termina lo que está haciendo; hasta entonces puedes presionar **Cancelar el traslado**.

## Archivos en otra computadora {#files-on-another-computer}

Un tripulante puede copiar un archivo de otra de tus computadoras a su tarea, para leerlo.
Solo lee: no se escribe nada en otra computadora.
Cada copia agrega una línea a la Actividad de la tarea, que nombra el archivo y la computadora de la que vino.

## Mudar a tu primer oficial {#move-your-first-mate}

En el menú de una computadora que hace trabajo, los tres puntos de su fila, **Mudar aquí a tu primer oficial** muda a tu primer oficial ahí.
Primero una lista muestra cualquier cosa que lo impida.
Los [Secretos](/es/secrets/) se quedan en la computadora que deja, y vuelves a iniciar sesión ahí en tus suscripciones.

## Guardar una copia en otra computadora {#keep-a-copy-on-another-computer}

Una computadora que hace trabajo puede guardar una copia en vivo del registro de tu primer oficial.
Si luego se pierde la computadora donde vive tu primer oficial, o queda fuera de alcance mucho tiempo, esa computadora puede [tomar el relevo](#take-over).

1. En la computadora donde vive tu primer oficial, abre Configuración → **Dispositivos** y elige la otra computadora.
2. Abre su menú, los tres puntos de su fila, y elige **Guardar una copia aquí**.

Hace una copia completa, y luego cada cambio que guarda tu primer oficial.
Su fila dice en qué punto está la copia, como **Copia al día** o **Copia poniéndose al día · 3 cambios**, y mientras está fuera de alcance, **Copia de** una hora.
Puedes guardar una copia en más de una computadora.

La copia contiene las tareas, tarjetas, conversación, conocimiento y automatizaciones de tu primer oficial.
Esa computadora nunca la abre hasta que toma el relevo.
Por sí sola, la copia no contiene ninguno de tus proyectos, inicios de sesión ni Secretos:

- Cuando toma el relevo, cada proyecto se vuelve a clonar desde donde se aloja.
  Un proyecto que solo se guardaba en la computadora perdida empieza vacío ahí.
- **Listo para tomar el relevo**, en su menú, enumera lo que esa computadora todavía necesitaría, como un inicio de sesión propio en cada suscripción que usa tu primer oficial, y en el sitio donde se alojan tus proyectos.
  Un botón para cada uno, como **Iniciar sesión en GitHub allí**, empieza ese inicio de sesión desde esta ventana.
- **Guardar los Secretos allí**, en la misma lista, guarda tus Secretos con la copia cuando confirmas en esa misma computadora.
  Consulta [Secretos](/es/secrets/#when-your-first-mate-moves).

**Dejar de guardar una copia**, en esa lista, la termina, y esa computadora elimina su copia cuando está al alcance.

Antes de una fusión, una inserción o un uso de un secreto, tu primer oficial espera hasta que cada copia al alcance tenga todos los cambios hasta ese momento.
Una computadora que toma el relevo sabe entonces lo que ya se hizo, y no lo vuelve a hacer.

## Tomar el relevo {#take-over}

Mientras la computadora donde vive tu primer oficial está fuera de alcance, una computadora que guarda una copia puede tomar el relevo: tu primer oficial empieza ahí desde su copia.
Nada toma el relevo por sí solo, y ningún temporizador lo decide: solo tu clic.

Abre Infinitary en una computadora que guarda una copia, y abre Configuración → **Dispositivos**.
En **Controlando**, **Tomar el relevo** dice de cuándo es esta copia, y si la computadora de tu primer oficial dijo que iba a entrar en reposo o que Infinitary se cerró ahí.
También enumera cada otra copia, marcada como **puede ser más reciente** cuando puede tener más cambios.
Si hay una copia más reciente al alcance, esta computadora la trae primero.

1. Presiona **Tomar el relevo**.
2. Presiona **Tomar el relevo** otra vez para confirmar, o **Quedarse** para dejar las cosas como están.
3. En una Mac, confirma con Touch ID o tu contraseña; en una PC con Windows, con Windows Hello o tu contraseña de Windows.

Tu primer oficial empieza entonces en esta computadora, que pasa a ser la computadora donde vive tu primer oficial.
Tus otras computadoras y tu teléfono la encuentran ahí por sí solos, sin un enlace nuevo.
Una tarjeta ahí pide cada inicio de sesión que le falta, y vuelves a agregar tus Secretos a menos que los guardara.

Tu teléfono también puede pedirle a una computadora que tome el relevo.
Mientras tu computadora está fuera de alcance, toca el botón de la computadora a la derecha de la barra superior del teléfono.
Su hoja ofrece **Tomar el relevo** para cada computadora que guarda una copia, y luego pide Face ID o tu código.

### Si la computadora perdida vuelve {#if-the-lost-computer-comes-back}

La computadora que se perdió deja de ser la computadora de tu primer oficial cuando vuelve, y guarda una copia en su lugar.
En **Relevado**, su Configuración → **Dispositivos** enumera lo que guardó después de la copia, que nunca llegó a tu primer oficial.
Guarda ese registro aparte, y nada vuelve a abrirlo.

Si dos computadoras responden como tu primer oficial, Configuración → **Dispositivos** pregunta en **Dos primeros oficiales**: **Conservar este**, o conservar el otro.
Las fusiones, las inserciones y los usos de un secreto esperan hasta que elijas, y el que no conservas se detiene y guarda una copia del otro.

## Cómo se encuentran las computadoras {#how-computers-find-each-other}

Configuración → **Dispositivos** muestra **Cómo encuentran esta computadora otros dispositivos**: **En esta red** y **En tu red privada**.
**Por internet** dice «Nunca. Infinitary no abre esta computadora a internet».
Para controlar a tu primer oficial desde otro lugar, pon las dos computadoras en la misma red privada.

Consulta también [iPhone y iPad](/es/iphone-and-ipad/) y [Solución de problemas](/es/troubleshooting/).
