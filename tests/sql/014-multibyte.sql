CREATE TABLE m (id INTEGER PRIMARY KEY, s TEXT);
INSERT INTO m VALUES (1, '한글'), (2, 'a'), (3, '😀'), (4, 'ｱ'), (5, 'B'), (6, 'é'), (7, ''), (8, 'it''s');
SELECT id, s FROM m ORDER BY s;
SELECT id FROM m WHERE s > 'z' ORDER BY id;
SELECT s FROM m WHERE s = '😀';
SELECT id FROM m WHERE s < 'a' ORDER BY id;
