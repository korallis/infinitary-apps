---
source: 6bc810f8c25a2b9e
title: Lo que sale de tu computadora
description: Lo que envía Infinitary, adónde va, y el único interruptor que nos envía algo a nosotros.
---

Infinitary se ejecuta en tu computadora, a través de las suscripciones que ya tienes.
No necesita ninguna cuenta con nosotros, y tu trabajo no pasa por nosotros.
Esta página enumera lo que envía la app, y adónde.

## Tu trabajo va al proveedor que elegiste {#your-work-goes-to-the-provider-you-chose}

Tu primer oficial y tu tripulación piensan a través de las suscripciones de IA en las que iniciaste sesión.
Tus mensajes, y lo que un tripulante lee de tu proyecto para hacer su tarea, van a ese proveedor a través de tu suscripción.
Con Claude, Infinitary usa el Claude Code que instalaste, con la sesión iniciada en tu propia cuenta.
Con un proveedor personalizado, va a la dirección que escribiste.

Tus inicios de sesión se quedan en tu computadora.

## Tus proyectos van donde se alojan {#your-projects-go-where-they-live}

Un tripulante trabaja en una copia de trabajo de tu proyecto en tu computadora.
Cuando una tarea se ofrece como solicitud de incorporación de cambios, su rama se inserta donde se aloja tu proyecto, como GitHub, GitLab o Bitbucket, y la solicitud de incorporación de cambios se abre ahí.
Un proyecto que solo se guarda en esta computadora se queda en esta computadora.

Cuando un tripulante prepara una copia de trabajo o hace su tarea, puede obtener lo que tu proyecto necesita, como lo harías a mano.

## Tus otras computadoras y tu teléfono {#your-other-computers-and-your-phone}

Las computadoras y los teléfonos que agregas hablan con la computadora donde vive tu primer oficial.
Configuración → **Dispositivos** dice cómo la encuentran.
**Por internet** dice «Nunca. Infinitary no abre esta computadora a internet».

Un inicio de sesión que escribes para otra computadora va a esa computadora una vez.
La computadora donde vive tu primer oficial no guarda ninguna copia.
Consulta [Tus otras computadoras](/es/your-other-computers/).

## Las integraciones que conectas {#integrations-you-connect}

A una integración que conectas en Configuración → **Integraciones**, como Google, se llega con su propio inicio de sesión, que se queda en la computadora en la que iniciaste sesión.
Tu primer oficial y tu tripulación solo la leen cuando la conectas.
Consulta [Integraciones](/es/integrations/).

## Los informes de uso de tu empresa {#your-companys-usage-reporting}

Si tu archivo de ajustes de Claude Code o tu shell configura informes de uso para tu empresa, como describe la guía de Claude Code, Infinitary envía el uso de todo el trabajo hecho aquí al mismo lugar.
El trabajo de Claude va como los registros que el propio Claude Code enviaría allí.
El trabajo de cualquier otro modelo va con los mismos nombres, con su modelo, proveedor, tokens, costo estimado, si lo hizo tu primer oficial o un tripulante, el tipo de trabajo y el correo de tu inicio de sesión de Claude Code, nunca tus palabras, títulos de tareas ni nombres de proyectos.
Configuración → **Uso** dice a dónde va.
Si ese lugar sigue rechazando el trabajo de Claude, o no se puede llegar a él, esa línea lo dice en su lugar.
Una configuración que el administrador de tu empresa gestiona para toda la computadora llega a Claude Code directamente, como siempre, e Infinitary también envía allí el trabajo de cualquier otro modelo, del mismo modo.
Cualquiera de las dos configuraciones recibe solo el trabajo de Claude si envía su uso por gRPC, y Configuración → **Uso** lo indica entonces.

## Búsqueda de actualizaciones {#update-checks}

Infinitary busca una versión más reciente cada pocas horas, en el lugar donde se publican sus versiones.
Esa búsqueda no envía ningún contenido tuyo ni ningún identificador.
La primera búsqueda de cada día, y la primera de cada mes, también dicen que son la primera, para que Infinitary Labs pueda contar cuántas computadoras usan Infinitary.
Esto ocurre diga lo que diga el interruptor **Diagnósticos**, y una copia instalada con Homebrew no lo envía.
Solo descarga una versión nueva cuando eliges actualizar.
También puedes presionar **Buscar actualizaciones** tú mismo.
Consulta [Actualizar y quitar Infinitary](/es/update-and-remove/).

## Dictado {#dictation}

El dictado convierte tu voz en palabras en tu computadora.
La primera vez que lo usas, pregunta antes de una descarga única de su modelo de voz.

## Diagnósticos, el único interruptor que nos envía algo {#diagnostics-the-one-switch-that-sends-to-us}

Configuración → **General** → **Compartir** tiene el interruptor **Diagnósticos**.
Es el único interruptor que nos envía algo; lo único que nos llega sin él es el aviso de la primera búsqueda de actualizaciones del día y del mes descrito arriba, que **Compartir** también describe.
Está activado a menos que lo desactives, y nada en la app depende de él.

En tu primer inicio, un aviso debajo del cuadro de mensaje dice lo que envía, con **Desactivar** y **Aceptar**.
No se envía nada hasta que respondas.

Diagnósticos envía eventos de uso anónimos:

- que se abrió la app,
- que tu primer oficial terminó o falló un turno, solo con el tipo de fallo,
- hasta dónde ha avanzado la configuración inicial,
- y, desde un iPhone o iPad que agregaste, que se abrió la app, que se configuró, que se envió un mensaje y que se respondió una tarjeta.

Cada evento lleva la versión de la app y un identificador de instalación aleatorio.
El identificador no está ligado a nada sobre ti ni sobre tu computadora, y se reemplaza cada vez que Diagnósticos se desactiva y se vuelve a activar.
No se envía ningún texto que hayas escrito, ningún nombre ni ninguna ruta: nunca una conversación, código ni una tarjeta.
Tu teléfono no envía nada por sí mismo; tu computadora envía sus eventos bajo el mismo interruptor.

Para ver exactamente lo que se enviaría, abre **Lo que saldría de esta computadora** en **Compartir**.
Muestra el identificador de instalación, lo que espera para enviarse, lo que se envió y cada evento que Diagnósticos puede enviar.
Desactiva **Diagnósticos**, y no se registra ni se envía nada más.

## Secretos {#secrets}

Los valores que guardas en Configuración → **Secretos** se quedan en tu computadora.
Cada valor va directamente a Secretos: Infinitary nunca vuelve a mostrarlo, y ni el primer oficial ni la tripulación lo reciben.
Consulta [Secretos](/es/secrets/).
