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
4. Antes de apuntarla, la entrada se liga a su ficha de **Clientes** como en RESERVATIONS-F06 (la que ya lleva ese teléfono o, si no, una nueva con el nombre y el teléfono escritos), con origen «En el local».
5. La entrada sale en la tabla con Contactado «No».
Entra: cliente, teléfono, fecha, hora preferida y comensales.
Sale: la entrada ligada a su ficha (avisa: reservations.waitlist.created) y, si no existía, la ficha nueva (avisa: customer.created). No ocupa sitio en ninguna franja. Por la ficha le alcanza el borrado de datos personales (RESERVATIONS-F22).
Si falla: un teléfono que Clientes no acepta o una ficha que no se puede buscar ni guardar sale dentro del formulario con su aviso (los de RESERVATIONS-F06) y no se apunta nada. El resto de mensajes sale dentro del formulario tal como llega, sin traducir. Un empleado no tiene permiso para apuntar.
Implicados: WHATSAPP_INBOX-F24, REC_WA_MESA-F05, CUSTOMERS-F10
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
Si falla: el mensaje sale arriba de la tabla tal como llega, sin traducir.
Implicados: ninguno
QA: qa-hub-restaurant §05

### RESERVATIONS-F16 Convertir una entrada de la lista de espera en reserva
Estado: parcial — si no se puede convertir, el aviso sale sin traducir y no dice el motivo; la conversión no comprueba comensales, antelación ni contacto obligatorio
Actor: responsable
Pantalla: Lista de espera
Pasos:
1. Cuando queda sitio, pulsa «Convertir» en la fila.
2. Se crea la reserva con los datos de la propia entrada (no los de la pantalla), sin mesa, Pendiente o Confirmada según la confirmación automática.
3. La entrada queda enlazada a esa reserva y la reserva aparece en Reservas.
Entra: la entrada de espera.
Sale: la reserva nueva y la entrada convertida, las dos o ninguna (avisa: reservations.reservation.created y reservations.waitlist.updated). Solo comprueba que el día no esté bloqueado y que haya una franja con sitio a esa hora: no comprueba los comensales mínimo y máximo, la antelación (ni la mínima ni la máxima) ni el teléfono o el correo obligatorios. Es la única vía en la que se aplica la duración por defecto de los ajustes.
Si falla: franja llena, día bloqueado, sin franja a esa hora o ya convertida: no se crea nada y sale arriba de la tabla el mensaje tal como llega, sin traducir y sin decir cuál de esos motivos fue.
Implicados: ninguno
QA: R-02
