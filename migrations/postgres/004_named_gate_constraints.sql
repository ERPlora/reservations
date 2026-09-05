-- Reservations · 004 — cada gate se niega CON SU NOMBRE (reservations#42).
--
-- La 002 creó `reservations__gate` con un único CHECK ANÓNIMO de columna, `CHECK (ok = 1)`, que
-- Postgres auto-nombra `reservations__gate_ok_check`. Los TRES gates del módulo
-- (`reservation_available`, `status_transition_valid`, `waitlist_promoted`) fallan por tanto con el
-- MISMO mensaje primario, y cuál se negó viaja en el campo DETAIL del protocolo:
--
--     ERROR:   new row for relation "reservations__gate" violates check constraint "reservations__gate_ok_check"
--     DETAIL:  Failing row contains (reservation_available, 0, ).
--
-- Esa segunda línea no llega nunca al llamante: el rechazo sube como `sqlx::Error::Database` sobre
-- `PgDatabaseError`, cuyo `Display` escribe solo el mensaje primario y cuyo `message()` descarta
-- DETAIL. Así que cualquier código que intente decir CUÁL guarda saltó mirando el texto no puede
-- casar nunca — ni el log, ni el asistente, ni la pantalla.
--
-- La `reason` de la 003 (reservations#31) no cierra esto: la fila que aborta revierte con la
-- transacción, así que el motivo tampoco sale de la base de datos. Es diagnóstico para quien
-- reproduzca el SELECT a mano, no información que viaje con el error.
--
-- El arreglo mueve la identidad del gate de la FILA al NOMBRE DE LA RESTRICCIÓN, que sí forma parte
-- del mensaje primario: una CHECK nombrada por gate, acotada a su propio valor, de modo que para
-- una fila dada solo UNA pueda violarse. Postgres no promete orden de evaluación entre
-- restricciones, y esto deja de necesitar que lo prometa.
--
-- Por eso la anónima se RETIRA en vez de quedarse de cinturón: mientras coexistieran, un `ok = 0`
-- violaría las dos y el nombre reportado podría ser cualquiera de ellas.
--
-- `reservations__gate_is_declared` es lo que permite retirarla sin abrir un agujero. Con una
-- constraint por gate, una fila cuyo `gate` no case con ninguna no viola NADA: un gate mal escrito
-- en un assert fallaría ABIERTO y el command commitearía. La lista blanca lo rechaza. Un gate nuevo
-- se da de alta en las DOS listas y en la MISMA migración; olvidarlo falla CERRADO y ruidoso, que
-- es la única dirección admisible en una tabla guardia.
--
-- Declarada `contract` en el manifest por ese único DROP. Es un SWAP ATÓMICO, no una limpieza
-- diferida: el reemplazo va en este mismo fichero, así que no hay ventana con la tabla
-- desguarnecida. La tabla está vacía entre comandos (`_gate_clear.sql` la vacía, y un assert
-- fallido revierte su propia fila), así que validar las constraints nuevas no tiene nada que
-- escanear. Append-only: la 002 y la 003 no se tocan.
--
-- Referencia: `verifactu/migrations/postgres/012_named_gate_constraints.sql` (verifactu#40).

ALTER TABLE reservations__gate DROP CONSTRAINT IF EXISTS reservations__gate_ok_check;

ALTER TABLE reservations__gate ADD CONSTRAINT reservation_available
    CHECK (gate <> 'reservation_available' OR ok = 1);

ALTER TABLE reservations__gate ADD CONSTRAINT status_transition_valid
    CHECK (gate <> 'status_transition_valid' OR ok = 1);

ALTER TABLE reservations__gate ADD CONSTRAINT waitlist_promoted
    CHECK (gate <> 'waitlist_promoted' OR ok = 1);

ALTER TABLE reservations__gate ADD CONSTRAINT reservations__gate_is_declared
    CHECK (gate IN (
        'reservation_available',
        'status_transition_valid',
        'waitlist_promoted'
    ));
