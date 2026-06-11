-- Limpieza de la tabla guardia. Solo se alcanza si todos los asserts pasaron
-- (un assert fallido viola su CHECK y revierte la transacción antes de llegar aquí).
DELETE FROM reservations__gate;
