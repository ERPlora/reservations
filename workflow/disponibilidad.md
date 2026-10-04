# WORKFLOW — Reservas · Disponibilidad y reglas

Prefijo: RESERVATIONS

> Franjas, días bloqueados, reglas de reserva, confirmación automática y ocupación.
> Índice, pantallas, datos y reglas: [`../WORKFLOW.md`](../WORKFLOW.md); `Pantalla:` nombra
> una entrada de su apartado «Pantallas».

## Flujos

### RESERVATIONS-F01 Crear y quitar franjas horarias
Estado: hecho
Actor: encargado
Pantalla: Disponibilidad
Pasos:
1. En Franjas horarias pulsa «Añadir franja».
2. Elige el Día, escribe Desde y Hasta (hh:mm) y Máx (reservas que caben en esa franja; 10 por defecto).
3. Pulsa «Crear franja».
4. La franja aparece en la tabla y en Ocupación de los días de esa semana; para retirarla, «Quitar».
Entra: día de la semana, horas y máximo que escribe el encargado.
Sale: la franja de ese día de la semana (avisa: reservations.timeslot.created / .deleted). Quitar una franja no toca las reservas ya hechas.
Si falla: el motivo sale dentro del formulario; una hora ilegible pide «hh:mm». Repetir la misma franja (mismo día, inicio y fin) se rechaza, también si es igual a una que se quitó (sin confirmar en banco).
Implicados: ninguno
QA: R-02

### RESERVATIONS-F02 Bloquear un día
Estado: parcial — la pantalla solo bloquea el día completo (bloquear unas horas solo por el asistente) y no avisa de las reservas que ya hay ese día
Actor: encargado
Pantalla: Disponibilidad
Pasos:
1. En Fechas bloqueadas pulsa «Añadir fecha bloqueada».
2. Escribe la Fecha y, si quieres, el Motivo.
3. Pulsa «Bloquear fecha».
4. La fecha sale en la tabla; ese día la barra de Reservas dice «Cerrado este día» y no se acepta ninguna reserva nueva. «Quitar» lo desbloquea.
Entra: fecha y motivo.
Sale: el bloqueo (avisa: reservations.blocked_date.created / .deleted); lo lee también la reserva por WhatsApp para decir que ese día se cierra.
Si falla: el motivo sale en el formulario. Bloquear dos veces el mismo día completo no se rechaza (sin confirmar en banco).
Implicados: ninguno
Pendiente de enlazar: whatsapp_inbox — la receta «WhatsApp → mesa reservada» consulta los días bloqueados antes de ofrecer horas
QA: R-02

### RESERVATIONS-F03 Ajustar las reglas de reserva
Estado: parcial — no hay pantalla de Ajustes; solo se cambian por el asistente del hub; cuatro ajustes se guardan pero no hacen nada (duración de franja y los tres de correo)
Actor: encargado
Pantalla: ninguna
Pasos:
1. Pide al asistente el cambio («acepta grupos de hasta 12», «exige teléfono»).
2. El asistente guarda los valores que nombras y deja el resto como estaba.
3. La siguiente reserva ya se decide con las reglas nuevas.
Entra: comensales mínimo y máximo, antelación mínima (horas) y máxima (días), duración por defecto, minutos de cortesía antes de liberar una pendiente, confirmación automática, teléfono y correo obligatorios.
Sale: los ajustes del restaurante (avisa: reservations.settings.updated).
Si falla: el asistente cuenta que no se pudo guardar; nada cambia.
Implicados: ninguno
QA: ninguno

### RESERVATIONS-F04 Elegir si las reservas se confirman solas
Estado: hecho
Actor: administrador
Pantalla: ninguna
Pasos:
1. En los ajustes de WhatsApp, tarjeta «Reservar mesa», elige «Las reservas se confirman solas» o «Las reviso yo antes».
2. Desde ese momento cada reserva nueva (a mano, por WhatsApp o desde la lista de espera) nace Confirmada o Pendiente.
Entra: la elección, desde el módulo WhatsApp.
Sale: solo ese ajuste (avisa: reservations.settings.updated); el resto de reglas no se toca.
Si falla: la tarjeta dice «No se pudo guardar cómo se confirman las reservas. Inténtalo otra vez.».
Implicados: ninguno
Pendiente de enlazar: whatsapp_inbox — tarjeta «Reservar mesa» de sus Ajustes, que guarda esta elección
Pendiente de enlazar: REC_WA_MESA — política de confirmación de la reserva por WhatsApp
QA: WR-01, WR-02

### RESERVATIONS-F05 Consultar cuánto queda libre en un día
Estado: hecho
Actor: empleado
Pantalla: Disponibilidad
Pasos:
1. Abre Disponibilidad; la Ocupación sale en hoy.
2. Escribe otra fecha si la llamada es para otro día.
3. Lee por franja Reservadas, Máx y Disponibles; la franja llena sale atenuada con «Lleno».
4. En Reservas, la barra del día da lo mismo resumido: cubiertos, reservas y próxima franja.
Entra: la fecha elegida.
Sale: nada; solo lectura. Cuenta exactamente lo que cuenta la puerta de reserva (sin canceladas ni no-show).
Si falla: la sección muestra el error con reintento; el resto de la pantalla sigue.
Implicados: ninguno
QA: R-02
