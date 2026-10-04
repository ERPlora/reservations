# WORKFLOW — Reservas · El libro de reservas

Prefijo: RESERVATIONS

## Flujos

### RESERVATIONS-F06 Tomar una reserva a mano (teléfono o mostrador)
Estado: parcial — el formulario no pide correo, notas, mesa ni ficha de cliente (el sistema los acepta); el rechazo por antelación no dice el motivo
Actor: empleado
Pantalla: Reservas
Pasos:
1. Pulsa «Nueva reserva».
2. Escribe Cliente, Teléfono, Fecha (dd/mm/aaaa), Hora (hh:mm) y Pax (2 por defecto).
3. Pulsa «Reservar».
4. El panel se cierra y la reserva aparece en su día como Pendiente (o Confirmada si se confirman solas); suben los cubiertos y baja lo libre de su franja.
Entra: los datos del cliente que da por teléfono o en persona.
Sale: la reserva (avisa: reservations.reservation.created). Ocupa sitio en su franja hasta que se cancele o sea no-show.
Si falla: el motivo sale dentro del formulario: teléfono o correo obligatorios, comensales fuera de límites, fecha bloqueada, «No hay servicio a esa hora», «Esa franja está completa para esa fecha». Demasiado pronto o demasiado lejos, o la franja llenándose en el mismo instante, sale con un aviso que no dice el motivo (texto sin confirmar). Fecha u hora ilegibles: aviso propio. Con la franja llena, apúntalo en la lista de espera (RESERVATIONS-F14).
Implicados: pendiente
Pendiente de enlazar: REC_RESTAURANTE — reservar, sentar y servir en el día del restaurante
QA: R-02

### RESERVATIONS-F07 Confirmar una reserva
Estado: parcial — confirmar retiene la mesa en el plano solo si la reserva tiene mesa, y desde la pantalla no se le puede poner
Actor: responsable
Pantalla: Reservas
Pasos:
1. Busca la reserva Pendiente en su día.
2. Pulsa «Confirmar» en su fila.
3. Pasa a Confirmada.
4. Si tenía mesa, Mesas la pinta reservada en el plano para su hora y su duración.
Entra: la reserva elegida.
Sale: estado Confirmada y hora de confirmación (avisa: reservations.reservation.status_changed, con mesa, hora, duración, pax y nombre); Mesas retiene la mesa.
Si falla: arriba de la tabla: «Ese cambio de estado no es posible desde el estado actual…» (p. ej. ya confirmada). Un empleado no tiene permiso para confirmar.
Implicados: WHATSAPP_INBOX-F26, REC_WA_MESA-F06
Pendiente de enlazar: tables — retener la mesa de una reserva confirmada y pintarla reservada
QA: R-02 (discrepa)

### RESERVATIONS-F08 Modificar una reserva (hora, comensales, mesa)
Estado: parcial — no hay botón de editar en Reservas (solo por el asistente); cambiar la hora no mueve la retención de la mesa en el plano
Actor: responsable, asistente
Pantalla: asistente
Pasos:
1. Pide al asistente el cambio («pasa la reserva de Ana a las 22:00», «son 6», «ponle la mesa 4», «quítale la mesa»).
2. El cambio se comprueba como una reserva nueva: comensales, antelación, día bloqueado y hueco en la franja (sin contarse a sí misma).
3. La reserva aparece cambiada en su día; si estaba confirmada con mesa, Mesas mueve la retención a la mesa nueva o la suelta.
Entra: los campos que cambian; lo que no se nombra se queda igual.
Sale: la reserva cambiada (avisa: reservations.reservation.updated, con los campos enviados).
Si falla: «No se ha podido guardar el cambio: la franja está completa, el día está bloqueado…» y la reserva queda como estaba.
Implicados: pendiente
Pendiente de enlazar: tables — mover o soltar la retención cuando cambia la mesa de la reserva
QA: R-02, qa-hub-restaurant §05 (discrepa)

### RESERVATIONS-F09 Cancelar una reserva
Estado: parcial — la pantalla no pide motivo
Actor: responsable
Pantalla: Reservas
Pasos:
1. Busca la reserva (Pendiente o Confirmada).
2. Pulsa «Cancelar» en su fila (si pide confirmación: sin confirmar).
3. Pasa a Cancelada; deja de contar en cubiertos y libera su sitio en la franja.
4. Si tenía la mesa retenida, vuelve libre al plano al momento.
Entra: la reserva y, por el asistente, un motivo.
Sale: estado Cancelada, hora y motivo (avisa: reservations.reservation.status_changed); Mesas suelta la mesa.
Si falla: una Sentada, Completada o ya cancelada no se puede cancelar: aviso arriba de la tabla.
Implicados: pendiente
Pendiente de enlazar: tables — soltar la mesa retenida al cancelar o al no presentarse
QA: R-02

### RESERVATIONS-F10 Marcar que no se presentaron
Estado: parcial — no hay botón «No-show» en Reservas; solo por el asistente
Actor: responsable, asistente
Pantalla: asistente
Pasos:
1. Pasada la hora, pide al asistente marcar la reserva como no presentada.
2. Pasa a «No-show»; deja de contar y libera su sitio y su mesa.
Entra: la reserva Pendiente o Confirmada.
Sale: estado No-show (avisa: reservations.reservation.status_changed); Mesas suelta la mesa.
Si falla: desde Sentada o Completada no se puede; aviso de cambio de estado no posible.
Implicados: REC_WA_MESA-F10
Pendiente de enlazar: tables — soltar la mesa retenida al cancelar o al no presentarse
QA: R-02

### RESERVATIONS-F11 Sentar a la reserva
Estado: parcial — «Sentar» en Reservas y abrir la mesa en Mesas son dos acciones sueltas: una no hace la otra
Actor: responsable
Pantalla: Reservas
Pasos:
1. Llega el grupo: en Reservas pulsa «Sentar» en su fila; pasa a Sentada.
2. En Mesas, abre la mesa con los comensales; abrirla gasta la retención de la reserva.
3. La mesa queda ocupada en el plano y se empieza a tomar comanda.
Entra: la reserva Pendiente o Confirmada.
Sale: estado Sentada y hora de llegada (avisa: reservations.reservation.status_changed). La retención solo la gasta abrir la mesa en Mesas; si nadie la abre, caduca a su hora.
Si falla: aviso de cambio de estado no posible (p. ej. ya cancelada). Un empleado no tiene permiso.
Implicados: REC_WA_MESA-F10
Pendiente de enlazar: tables — abrir la mesa de una reserva gasta su retención
Pendiente de enlazar: REC_RESTAURANTE — reservar, sentar y servir en el día del restaurante
QA: R-02, R-03, qa-hub-restaurant §06

### RESERVATIONS-F12 Completar la reserva
Estado: hecho
Actor: responsable
Pantalla: Reservas
Pasos:
1. Cuando el grupo se va, pulsa «Completar» en su fila.
2. Pasa a Completada; sigue contando en los cubiertos del día.
Entra: una reserva Sentada.
Sale: estado Completada y su hora (avisa: reservations.reservation.status_changed). No cierra ni cobra la mesa.
Si falla: «…no se puede completar antes de sentarla», si no estaba Sentada.
Implicados: REC_WA_MESA-F10
QA: qa-hub-restaurant §05

### RESERVATIONS-F13 Liberar las reservas pendientes que nadie confirmó
Estado: hecho
Actor: sistema
Pantalla: ninguna
Pasos:
1. Cada 15 minutos el sistema mira las reservas Pendientes cuya hora pasó hace más de los minutos de cortesía (15 de fábrica).
2. Las pasa a Cancelada con el motivo «sin confirmar»; dejan de ocupar su franja.
Entra: hora actual y minutos de cortesía de los ajustes.
Sale: reservas canceladas (avisa en bloque, sin cuáles: reservations.reservations.unconfirmed_released). Nunca toca las Confirmadas ni las futuras. Al cliente no se le avisa: el que pidió mesa por WhatsApp y oyó «te la confirman» no se entera de que se ha liberado.
Si falla: se reintenta en la siguiente pasada; no deja nada a medias.
Implicados: REC_WA_MESA-F06
QA: WR-02

### RESERVATIONS-F20 Borrar una reserva
Estado: parcial — borrar una reserva confirmada no suelta su mesa en el plano
Actor: administrador, asistente
Pantalla: asistente
Pasos:
1. Pide al asistente borrar la reserva (no hay botón en pantalla).
2. Desaparece del libro y de las cifras; queda guardada como borrada.
Entra: la reserva.
Sale: la reserva borrada (avisa: reservations.reservation.deleted). Mesas no lo oye: la mesa retenida sigue reservada en el plano hasta que la retención caduca a su hora.
Si falla: solo el administrador puede borrar; el asistente lo dice.
Implicados: pendiente
Pendiente de enlazar: tables — la retención de una reserva borrada
QA: ninguno
