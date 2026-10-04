-- syntax and lexical errors with positions
SELECT * FROM t WHERE (a, b);
SELEC * FROM t;
SELECT * FROM;
SELECT * FROM t WHERE a = b = c;
SELECT * FROM t WHERE x = 123abc;
SELECT ? FROM t;
INSERT INTO t VALUES (9007199254740992);
CREATE TABLE t (a REAL);
EXPLAIN DELETE FROM t;
SELECT 'unterminated
