# WORKFLOW — Reservas · Lista de espera

Prefijo: RESERVATIONS

## Flujos

### RESERVATIONS-F14 Apuntar en la lista de espera
Estado: parcial — no avisa al cliente ni da tiempo de espera estimado; no comprueba si el día está cerrado
Actor: responsable
Pantalla: Lista de espera
Pasos:
1. Pulsa «Añadir cliente».
2. Escribe Cliente, Teléfono (obligatorio), Fecha, Hora y Pax.
3. Pulsa «Añadir a la lista de espera».
4. La entrada sale en la tabla con Contactado «No».
Entra: cliente, teléfono, fecha, hora preferida y comensales.
Sale: la entrada (avisa: reservations.waitlist.created). No ocupa sitio en ninguna franja.
Si falla: el motivo sale dentro del formulario. Un empleado no tiene permiso para apuntar.
Implicados: pendiente
Pendiente de enlazar: whatsapp_inbox — la receta «WhatsApp → mesa reservada» apunta en la lista de espera cuando el cliente lo pide
QA: R-02, WR-03

### RESERVATIONS-F15 Marcar contactado o quitar de la lista de espera
Estado: hecho
Actor: responsable
Pantalla: Lista de espera
Pasos:
1. Tras llamar al cliente, pulsa «Contactado» en su fila; la columna pasa a «Sí».
2. Si ya no quiere mesa, pulsa «Quitar»; la entrada desaparece.
Entra: la entrada elegida.
Sale: la entrada marcada o retirada (avisa: reservations.waitlist.updated / .deleted).
Si falla: el aviso sale arriba de la tabla (texto sin traducir, sin confirmar).
Implicados: ninguno
QA: qa-hub-restaurant §05

### RESERVATIONS-F16 Convertir una entrada de la lista de espera en reserva
Estado: parcial — si no se puede convertir, el aviso no dice el motivo
Actor: responsable
Pantalla: Lista de espera
Pasos:
1. Cuando queda sitio, pulsa «Convertir» en la fila.
2. Se crea la reserva con los datos de la propia entrada (no los de la pantalla), sin mesa, Pendiente o Confirmada según la confirmación automática.
3. La entrada queda enlazada a esa reserva y la reserva aparece en Reservas.
Entra: la entrada de espera.
Sale: la reserva nueva y la entrada convertida, las dos o ninguna (avisa: reservations.reservation.created y reservations.waitlist.updated). No exige la antelación mínima: suele ser para hoy.
Si falla: franja llena, día bloqueado, sin franja a esa hora o ya convertida: no se crea nada y sale un aviso arriba de la tabla (texto sin confirmar).
Implicados: ninguno
QA: R-02
