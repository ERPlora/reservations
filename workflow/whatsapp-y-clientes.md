# WORKFLOW — Reservas · WhatsApp y fichas de cliente

Prefijo: RESERVATIONS

## Flujos

### RESERVATIONS-F17 Reserva que llega por WhatsApp
Estado: hecho
Actor: cliente, asistente
Pantalla: ninguna
Pasos:
1. El cliente escribe al WhatsApp del restaurante («mesa para 4 el sábado a las 21»).
2. Si no ha dicho cuántos son, el asistente se lo pregunta primero, sin ofrecer horas. Con los comensales, mira días bloqueados, franjas y huecos libres, y si falta el día o la hora le ofrece una lista de horas libres para tocar una.
3. Reserva con el teléfono del cliente y el nombre que dé en el mensaje (si no da ninguno, su teléfono hace de nombre); si ya tenía ficha en Clientes, la reserva queda ligada a esa ficha, pero el nombre escrito sigue siendo el del mensaje. Las peticiones del cliente van a las notas.
4. La reserva aparece en Reservas (Pendiente para que la confirme el responsable, o Confirmada) y el cliente recibe la respuesta.
Entra: el mensaje, el teléfono y la ficha del cliente (desde el módulo WhatsApp).
Sale: la reserva, que pasa por la misma puerta que la reserva a mano (y dura 120 minutos), o la entrada en lista de espera (avisa: reservations.reservation.created).
Si falla: el asistente le cuenta al cliente el motivo que dio el restaurante y qué puede hacer; si no puede mirar el libro, le dice que alguien le contesta y marca la conversación para atenderla.
Implicados: CUSTOMERS-F10, WHATSAPP_INBOX-F15, WHATSAPP_INBOX-F24, REC_WA_MESA-F03, REC_WA_MESA-F05
QA: WR-01, WR-02, WR-03, WR-04, L-12

### RESERVATIONS-F18 Cambiar o anular la reserva por WhatsApp
Estado: no hecho — Reservas ya acepta el cambio en nombre del cliente comprobando que la reserva es suya, pero la receta de WhatsApp no lo usa y responde que una persona se ocupa
Actor: cliente, asistente
Pantalla: ninguna
Pasos:
1. El cliente escribe «no vamos a poder ir» o «¿podemos ir a las nueve?».
   Hoy la receta le contesta que alguien del restaurante se ocupa, no toca la reserva y no marca la conversación «Necesita atención»: nadie recibe aviso. Lo que sigue es lo que tiene que hacer cuando exista.
2. Se comprueba que la reserva es de quien escribe; si no, se rechaza sin contar nada de ella.
3. Se anula o se cambia con las mismas reglas que a mano; el cliente no puede cambiar la mesa ni las notas internas.
4. La mesa retenida se suelta o se mueve y el cliente recibe la confirmación.
Entra: el mensaje y la ficha del cliente.
Sale: la reserva anulada o cambiada (avisa: reservations.reservation.status_changed / .updated).
Si falla: «Esa reserva es de otro comensal, así que no se puede gestionar en su nombre.», «La mesa y las notas internas del restaurante las pone el restaurante; no se pueden cambiar desde tu reserva.», o el rechazo de disponibilidad.
Implicados: WHATSAPP_INBOX-F25, REC_WA_MESA-F08
QA: WR-03 (discrepa)

### RESERVATIONS-F19 Avisar por WhatsApp cuando el restaurante confirma
Estado: no hecho — con «Las reviso yo antes» al cliente se le dice que se le confirmará en breve, y al pulsar «Confirmar» no le llega nada
Actor: responsable, cliente
Pantalla: Reservas
Pasos:
1. El responsable confirma una reserva que nació por WhatsApp.
2. El cliente recibe por el mismo WhatsApp que su mesa está confirmada.
Entra: la confirmación de la reserva y el teléfono del cliente.
Sale: el mensaje al cliente.
Si falla: sin confirmar (no existe).
Implicados: WHATSAPP_INBOX-F26, REC_WA_MESA-F07
QA: WR-02 (discrepa)

### RESERVATIONS-F21 Unir las reservas de dos fichas de cliente
Estado: hecho
Actor: sistema
Pantalla: ninguna
Pasos:
1. En Clientes se unen dos fichas duplicadas.
2. Todas las reservas y entradas de espera de la ficha absorbida pasan a la que queda, también las antiguas.
Entra: la ficha que queda y la absorbida (desde Clientes: customer.merged).
Sale: reservas y lista de espera re-apuntadas; el nombre y el teléfono escritos en cada reserva no se tocan.
Si falla: se reintenta solo; repetirlo no cambia nada.
Implicados: CUSTOMERS-F13
QA: ninguno

### RESERVATIONS-F22 Borrar los datos personales de un cliente (RGPD)
Estado: no hecho — al anonimizar una ficha en Clientes, su nombre, teléfono, correo y notas siguen escritos en sus reservas y en la lista de espera
Actor: sistema
Pantalla: ninguna
Pasos:
1. En Clientes se anonimiza la ficha a petición del cliente.
2. Sus reservas y entradas de espera pierden nombre, teléfono, correo y notas, y conservan fecha, hora y comensales.
Entra: la ficha anonimizada (desde Clientes).
Sale: reservas y entradas sin datos personales.
Si falla: sin confirmar (no existe).
Implicados: CUSTOMERS-F16, HUB-F250
QA: L-10
