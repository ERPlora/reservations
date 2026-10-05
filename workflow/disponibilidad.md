# WORKFLOW — Reservas · Disponibilidad y reglas

Prefijo: RESERVATIONS

## Flujos

### RESERVATIONS-F01 Crear y quitar franjas horarias
Estado: hecho
Actor: responsable
Pantalla: Disponibilidad
Pasos:
1. En Franjas horarias pulsa «Añadir franja».
2. Elige el Día, escribe Desde y Hasta (hh:mm) y Máx (reservas que caben en esa franja; 10 por defecto).
3. Pulsa «Crear franja».
4. La franja aparece en la tabla y en Ocupación de los días de esa semana; para retirarla, «Quitar».
Entra: día de la semana, horas y máximo que escribe el responsable.
Sale: la franja de ese día de la semana (avisa: reservations.timeslot.created / .deleted). Quitar una franja no toca las reservas ya hechas.
Si falla: el motivo sale dentro del formulario; una hora ilegible pide «hh:mm». Repetir la misma franja (mismo día, inicio y fin) se rechaza, también si es igual a una que se quitó: una franja quitada no se puede volver a crear igual.
Implicados: WHATSAPP_INBOX-F24, REC_WA_MESA-F04
QA: R-02

### RESERVATIONS-F02 Bloquear un día
Estado: parcial — la pantalla solo bloquea el día completo (bloquear unas horas solo por el asistente) y no avisa de las reservas que ya hay ese día
Actor: responsable
Pantalla: Disponibilidad
Pasos:
1. En Fechas bloqueadas pulsa «Añadir fecha bloqueada».
2. Escribe la Fecha y, si quieres, el Motivo.
3. Pulsa «Bloquear fecha».
4. La fecha sale en la tabla; ese día la barra de Reservas dice «Cerrado este día» y no se acepta ninguna reserva nueva. «Quitar» lo desbloquea.
Entra: fecha y motivo.
Sale: el bloqueo (avisa: reservations.blocked_date.created / .deleted); lo lee también la reserva por WhatsApp para decir que ese día se cierra.
Si falla: el motivo sale en el formulario. Bloquear dos veces el mismo día completo no se rechaza: queda repetido en la tabla.
Implicados: WHATSAPP_INBOX-F24, REC_WA_MESA-F04
QA: R-02

### RESERVATIONS-F03 Ajustar las reglas de reserva
Estado: parcial — no hay pantalla de Ajustes; solo se cambian por el asistente del hub; cinco ajustes se guardan pero no hacen nada (duración de franja, los tres de correo y la duración por defecto, que solo se aplica al convertir desde la lista de espera: a mano o por WhatsApp toda reserva dura 120 minutos); el primer guardado vuelve obligatorio el teléfono
Actor: responsable, asistente
Pantalla: asistente
Pasos:
1. Pide al asistente el cambio («acepta grupos de hasta 12», «exige teléfono»).
2. El asistente guarda los valores que nombras. Si el restaurante nunca había guardado ajustes, este primer guardado crea los de fábrica y con ellos el teléfono pasa a ser obligatorio en toda reserva (hasta entonces no lo era); en los siguientes, el resto queda como estaba.
3. La siguiente reserva ya se decide con las reglas nuevas.
Entra: comensales mínimo y máximo, antelación mínima (horas) y máxima (días), duración por defecto, minutos de cortesía antes de liberar una pendiente, confirmación automática, teléfono y correo obligatorios.
Sale: los ajustes del restaurante (avisa: reservations.settings.updated).
Si falla: el asistente cuenta que no se pudo guardar; nada cambia.
Implicados: ninguno
QA: qa-hub-restaurant §05

### RESERVATIONS-F04 Elegir si las reservas se confirman solas
Estado: parcial — si el restaurante nunca había guardado ajustes, esta elección vuelve obligatorio el teléfono en toda reserva; y una reserva que nace Confirmada no retiene su mesa en el plano
Actor: administrador
Pantalla: WhatsApp: Ajustes
Pasos:
1. En los ajustes de WhatsApp, tarjeta «Reservar mesa», elige «Las reservas se confirman solas» o «Las reviso yo antes».
2. Desde ese momento cada reserva nueva (a mano, por WhatsApp o desde la lista de espera) nace Confirmada o Pendiente. A diferencia de Citas, donde el mismo interruptor solo vale para lo que reserva la clienta, aquí vale para todas.
Entra: la elección, desde el módulo WhatsApp.
Sale: ese ajuste (avisa: reservations.settings.updated). El primer guardado crea además los ajustes de fábrica, con teléfono obligatorio: desde entonces la pantalla Reservas rechaza una reserva sin teléfono. Una reserva que nace Confirmada no avisa a Mesas, así que no retiene mesa aunque se la pongan, y ya no se puede «Confirmar» para que la retenga.
Si falla: la tarjeta dice «No se pudo guardar cómo se confirman las reservas. Inténtalo otra vez.».
Implicados: TABLES-F25, WHATSAPP_INBOX-F16, REC_RESTAURANTE-F04, REC_WA_MESA-F06
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
Implicados: WHATSAPP_INBOX-F19, WHATSAPP_INBOX-F24, REC_WA_MESA-F04
QA: R-02
