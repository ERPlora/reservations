# WORKFLOW — Reservas · El libro de reservas

Prefijo: RESERVATIONS

## Flujos

### RESERVATIONS-F06 Tomar una reserva a mano (teléfono o mostrador)
Estado: parcial — el formulario no pide correo, notas ni mesa (el sistema los acepta); el rechazo por antelación no dice el motivo
Actor: empleado
Pantalla: Reservas
Pasos:
1. Pulsa «Nueva reserva».
2. Escribe Cliente, Teléfono, Fecha (dd/mm/aaaa), Hora (hh:mm) y Pax (2 por defecto).
3. Pulsa «Reservar».
4. Antes de apuntarla, la reserva se liga a su ficha de **Clientes**: la que ya lleva ese teléfono, comparado como número del país del negocio (`600 111 222` es la ficha `+34600111222`, CUSTOMERS-F10); si varias lo llevan, la del nombre escrito (sin mirar mayúsculas ni acentos) y, si ninguna, la primera. Si ninguna lleva el número, o no se escribió teléfono, se crea una ficha nueva con el nombre y el teléfono escritos y origen «Teléfono». Si la reserva se rechaza y se vuelve a pulsar «Reservar» sin cambiar nombre ni teléfono, se usa la misma ficha (no se crea otra).
5. El panel se cierra y la reserva aparece en su día como Pendiente (o Confirmada si se confirman solas); suben los cubiertos y baja lo libre de su franja.
Entra: los datos del cliente que da por teléfono o en persona.
Sale: la reserva ligada a su ficha (avisa: reservations.reservation.created) y, si no existía, la ficha nueva en Clientes (avisa: customer.created). Ocupa sitio en su franja hasta que se cancele o sea no-show. Por la ficha le alcanza el borrado de datos personales (RESERVATIONS-F22).
Si falla: si Clientes no acepta el teléfono, dentro del formulario: «No es un teléfono válido de su país: revisa las cifras o escríbelo con su prefijo internacional (+44…).»; si la ficha no se puede buscar ni guardar (también sin permiso para ver o crear clientes): «No se ha podido encontrar ni guardar la ficha del cliente, así que no se ha apuntado nada. Vuelve a intentarlo.». En los dos casos no se apunta nada y lo tecleado se conserva. Si la reserva se rechaza, la ficha ya creada se queda en Clientes. El resto, dentro del formulario: teléfono o correo obligatorios, comensales fuera de límites, fecha bloqueada, «No hay servicio a esa hora: ninguna franja abierta la cubre.», «Esa franja está completa para esa fecha.». Demasiado pronto o demasiado lejos, o la franja llenándose en el mismo instante, sale con un aviso que no dice el motivo (texto sin confirmar). Fecha u hora ilegibles: aviso propio. Con la franja llena, apúntalo en la lista de espera (RESERVATIONS-F14).
Implicados: FLOWS-F04, REC_RESTAURANTE-F04, ONLINE_BOOKING-F01, CUSTOMERS-F10
QA: R-02

### RESERVATIONS-F07 Confirmar una reserva
Estado: parcial — confirmar retiene la mesa en el plano solo si la reserva ya tiene mesa, y desde la pantalla no se le puede poner (solo con el asistente); una reserva que nace Confirmada (confirmación automática) nunca retiene mesa; y la mesa se pinta Reservada desde que se confirma, aunque la reserva sea para otro día
Actor: responsable
Pantalla: Reservas
Pasos:
1. Busca la reserva Pendiente en su día.
2. Pulsa «Confirmar» en su fila.
3. Pasa a Confirmada.
4. Si tenía mesa, Mesas la pinta Reservada en el plano desde el momento de confirmar, aunque la reserva sea para otro día, hasta que la retención se gasta, se suelta o caduca después de su ventana (TABLES-F25, TABLES-F29). La mesa solo se le pone a la reserva con el asistente: las pantallas de Reservas no tienen campo de mesa. Es el único camino que retiene mesa: una reserva que nace Confirmada no pasa por aquí (no se puede volver a «Confirmar») y editarla tampoco crea la retención.
Entra: la reserva elegida.
Sale: estado Confirmada y hora de confirmación (avisa: reservations.reservation.status_changed, con mesa, hora, duración, pax y nombre); Mesas retiene la mesa.
Si falla: arriba de la tabla: «Ese cambio de estado no es posible desde el estado actual de la reserva (el flujo es pendiente → confirmada → sentada → completada).» (p. ej. ya confirmada: los cuatro botones salen en todas las filas, sea cual sea su estado). Un empleado no tiene permiso para confirmar.
Implicados: TABLES-F25, WHATSAPP_INBOX-F26, REC_RESTAURANTE-F04, REC_WA_MESA-F06
QA: R-02 (discrepa)

### RESERVATIONS-F08 Modificar una reserva (hora, comensales, mesa)
Estado: parcial — no hay botón de editar en Reservas (solo por el asistente); cambiar la hora no mueve la retención de la mesa en el plano; poner mesa a una reserva ya confirmada no la retiene; dentro del margen de antelación no se puede cambiar nada, ni el teléfono
Actor: responsable, asistente
Pantalla: asistente
Pasos:
1. Pide al asistente el cambio («pasa la reserva de Ana a las 22:00», «son 6», «ponle la mesa 4», «quítale la mesa»).
2. Se comprueba con lo que la reserva va a quedar: comensales, antelación, día bloqueado y hueco en la franja (sin contarse a sí misma). No se comprueban el teléfono ni el correo obligatorios. La antelación se exige aunque solo cambien las notas o el teléfono: una reserva de dentro de menos de la antelación mínima (1 hora de fábrica), o ya pasada, no se puede editar.
3. La reserva aparece cambiada en su día. Si ya tenía la mesa retenida, Mesas mueve la retención a la mesa nueva o la suelta; si no la tenía, ponerle mesa no la retiene.
Entra: los campos que cambian; lo que no se nombra se queda igual.
Sale: la reserva cambiada (avisa: reservations.reservation.updated, con los campos enviados).
Si falla: «No se ha podido guardar el cambio: la franja está completa, el día está bloqueado…» y la reserva queda como estaba.
Implicados: TABLES-F26, REC_RESTAURANTE-F04
QA: R-02, qa-hub-restaurant §05 (discrepa)

### RESERVATIONS-F09 Cancelar una reserva
Estado: parcial — la pantalla no pide motivo
Actor: responsable
Pantalla: Reservas
Pasos:
1. Busca la reserva (Pendiente o Confirmada).
2. Pulsa «Cancelar» en su fila; no pide confirmación.
3. Pasa a Cancelada; deja de contar en cubiertos y libera su sitio en la franja.
4. Si tenía la mesa retenida, vuelve libre al plano al momento.
Entra: la reserva y, por el asistente, un motivo.
Sale: estado Cancelada, hora y motivo (avisa: reservations.reservation.status_changed); Mesas suelta la mesa.
Si falla: una Sentada, Completada o ya cancelada no se puede cancelar: arriba de la tabla, «Ese cambio de estado no es posible desde el estado actual de la reserva (el flujo es pendiente → confirmada → sentada → completada).»
Implicados: TABLES-F27, REC_RESTAURANTE-F04
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
Implicados: TABLES-F27, REC_RESTAURANTE-F04, REC_WA_MESA-F10
QA: R-02

### RESERVATIONS-F11 Sentar a la reserva
Estado: parcial — «Sentar» en Reservas y abrir la mesa en Mesas son dos acciones sueltas: una no hace la otra; y sentar en esa mesa a cualquier otro grupo, horas antes, gasta también esta reserva (TABLES-F28)
Actor: responsable
Pantalla: Reservas
Pasos:
1. Llega el grupo: en Reservas pulsa «Sentar» en su fila; pasa a Sentada.
2. En **Ventas → Vender**, con el botón de mesa («Elegir mesa», de Mesas), toca la mesa Reservada y siéntalos con sus comensales (TABLES-F10); abrirla gasta la retención de la reserva.
3. La mesa queda ocupada en el plano y se empieza a tomar comanda.
Entra: la reserva Pendiente o Confirmada.
Sale: estado Sentada y hora de llegada (avisa: reservations.reservation.status_changed). La retención solo la gasta abrir la mesa en Mesas, y la gasta cualquiera que se siente en esa mesa (también un grupo sin reserva horas antes), que además gasta todas las reservas retenidas en ella (TABLES-F28). Si nadie la abre, caduca después de su ventana (hora de la reserva más su duración, 120 minutos): en España, 1 hora tarde en invierno y 2 en verano, porque Mesas compara la hora del negocio con la del servidor en UTC, más hasta 15 minutos del repaso (TABLES-F29).
Si falla: arriba de la tabla, «Ese cambio de estado no es posible desde el estado actual de la reserva (el flujo es pendiente → confirmada → sentada → completada).» (p. ej. ya cancelada). Un empleado no tiene permiso.
Implicados: TABLES-F10, TABLES-F28, TABLES-F29, REC_RESTAURANTE-F05, REC_WA_MESA-F10
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
Si falla: si no estaba Sentada, arriba de la tabla, «Ese cambio de estado no es posible desde el estado actual de la reserva (el flujo es pendiente → confirmada → sentada → completada).»
Implicados: REC_RESTAURANTE-F13, REC_WA_MESA-F10
QA: qa-hub-restaurant §05

### RESERVATIONS-F13 Liberar las reservas pendientes que nadie confirmó
Estado: hecho
Actor: sistema
Pantalla: ninguna
Pasos:
1. Cada 15 minutos el sistema mira las reservas Pendientes cuya hora pasó hace más de los minutos de cortesía (15 de fábrica).
2. Las pasa a Cancelada y guarda como motivo `unconfirmed`, que ninguna pantalla enseña; dejan de ocupar su franja.
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
Sale: la reserva borrada (avisa: reservations.reservation.deleted). Mesas no lo oye: la mesa retenida sigue reservada en el plano hasta que la retención caduca después de su ventana (hora más duración): en España 1 o 2 horas tarde (hora del negocio comparada con UTC), más hasta 15 minutos del repaso de Mesas (TABLES-F29).
Si falla: solo el administrador puede borrar; el asistente lo dice.
Implicados: TABLES-F27, TABLES-F29, REC_RESTAURANTE-F04
QA: ninguno
