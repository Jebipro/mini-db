# Mini DB — SPEC

언어(SQL-like)의 문법, 타입, NULL 논리, 실행 의미론, 한도, 오류 코드의 명세.

> 출처: `DESIGN_REVIEW.md` rev1의 해당 섹션을 그대로 옮겼다(섹션 번호 유지). 변경은 `DECISIONS.md`에 기록한 뒤 두 문서를 함께 고친다.

## F.1 어휘 규칙과 토큰

| 토큰 | 규칙 |
|---|---|
| 공백 | U+0020, `\t`, `\n`, `\r`. `\n`만 줄을 바꾼다 |
| 주석 | `--`부터 `\n` 또는 입력 끝까지. 따라서 `5--3`은 `5` 뒤 주석이다 |
| `KEYWORD` | 대소문자 무시, 전부 예약어: `AND ASC BEGIN BOOLEAN BY COMMIT CREATE DELETE DESC DROP EXPLAIN FALSE FROM INDEX INSERT INTEGER INTO IS KEY LIMIT NOT NULL OFFSET ON OR ORDER PRIMARY ROLLBACK SELECT SET TABLE TEXT TRUE UNIQUE UPDATE VALUES WHERE` (37개) |
| `IDENT` | `[A-Za-z_][A-Za-z0-9_]*` 중 키워드가 아닌 것, 소문자로 정규화. 64바이트 초과 → `LimitError IDENTIFIER_TOO_LONG` |
| `INTEGER` | `[0-9]+`. 값 > 9007199254740991 → `LimitError INTEGER_OUT_OF_RANGE`. 바로 뒤에 `[A-Za-z_]`가 오면 `SqlSyntaxError SYNTAX_INVALID_NUMBER` |
| `STRING` | `'` … `'`, 내부 `''` = 작은따옴표 1개. 줄바꿈 포함 가능. 닫히지 않음 → `SYNTAX_UNTERMINATED_STRING`(여는 따옴표 위치). lone surrogate 포함 → `SYNTAX_INVALID_STRING`. UTF-8 길이 > 4000 → `LimitError TEXT_TOO_LARGE` |
| 구두점 | `(` `)` `,` `;` `*` `+` `-` `=` `<>` `!=` `<` `<=` `>` `>=` |
| `EOF` | 입력 끝 |
| 기타 문자 | `SqlSyntaxError SYNTAX_INVALID_CHARACTER` |

모든 토큰은 시작 위치 `{offset, line, column}`을 가진다(DC-55).

## F.2 EBNF (SPEC.md의 문법 원본)

```ebnf
script            = [ statement ] , { ";" , [ statement ] } ;
statement         = select_stmt | explain_stmt | insert_stmt | update_stmt | delete_stmt
                  | create_table_stmt | drop_table_stmt | create_index_stmt | drop_index_stmt
                  | "BEGIN" | "COMMIT" | "ROLLBACK" ;

explain_stmt      = "EXPLAIN" , select_stmt ;
select_stmt       = "SELECT" , select_list , "FROM" , IDENT ,
                    [ "WHERE" , expr ] ,
                    [ "ORDER" , "BY" , order_item , { "," , order_item } ] ,
                    [ "LIMIT" , INTEGER , [ "OFFSET" , INTEGER ] ] ;
select_list       = "*" | IDENT , { "," , IDENT } ;
order_item        = IDENT , [ "ASC" | "DESC" ] ;

insert_stmt       = "INSERT" , "INTO" , IDENT , [ "(" , IDENT , { "," , IDENT } , ")" ] ,
                    "VALUES" , value_row , { "," , value_row } ;
value_row         = "(" , expr , { "," , expr } , ")" ;
update_stmt       = "UPDATE" , IDENT , "SET" , assignment , { "," , assignment } , [ "WHERE" , expr ] ;
assignment        = IDENT , "=" , expr ;
delete_stmt       = "DELETE" , "FROM" , IDENT , [ "WHERE" , expr ] ;

create_table_stmt = "CREATE" , "TABLE" , IDENT , "(" , column_def , { "," , column_def } , ")" ;
column_def        = IDENT , type_name , { column_constraint } ;
type_name         = "INTEGER" | "TEXT" | "BOOLEAN" ;
column_constraint = "NOT" , "NULL" | "PRIMARY" , "KEY" ;
drop_table_stmt   = "DROP" , "TABLE" , IDENT ;
create_index_stmt = "CREATE" , [ "UNIQUE" ] , "INDEX" , IDENT , "ON" , IDENT , "(" , IDENT , ")" ;
drop_index_stmt   = "DROP" , "INDEX" , IDENT ;

expr              = or_expr ;
or_expr           = and_expr , { "OR" , and_expr } ;
and_expr          = not_expr , { "AND" , not_expr } ;
not_expr          = "NOT" , not_expr | cmp_expr ;
cmp_expr          = add_expr , [ cmp_op , add_expr | "IS" , [ "NOT" ] , "NULL" ] ;
cmp_op            = "=" | "<>" | "!=" | "<" | "<=" | ">" | ">=" ;
add_expr          = mul_expr , { ( "+" | "-" ) , mul_expr } ;
mul_expr          = unary_expr , { "*" , unary_expr } ;
unary_expr        = "-" , unary_expr | primary ;
primary           = INTEGER | STRING | "TRUE" | "FALSE" | "NULL" | IDENT | "(" , expr , ")" ;
```

- `execute()`는 `script`가 정확히 1개의 statement를 가질 때만 허용(DC-59). 빈 statement(`;;`)는 `executeScript`에서 건너뛴다.
- 같은 column_constraint 반복(`NOT NULL NOT NULL`) → `SemanticError DUPLICATE_CONSTRAINT`.

## F.3 연산자 우선순위 (높음 → 낮음)

| 단계 | 연산자 | 결합 |
|---|---|---|
| 1 | 리터럴, 컬럼, `( … )` | — |
| 2 | 단항 `-` | 오른쪽 (`- -5` 허용) |
| 3 | `*` | 왼쪽 |
| 4 | `+` `-` | 왼쪽 |
| 5 | `= <> != < <= > >=`, `IS [NOT] NULL` | **비결합**: `a = b = c`, `a = b IS NULL` → `SYNTAX_UNEXPECTED_TOKEN` |
| 6 | `NOT` | 오른쪽(전위). `NOT a = b` = `NOT (a = b)` |
| 7 | `AND` | 왼쪽 |
| 8 | `OR` | 왼쪽 |

구현: `parseExpr(minPrec)` precedence climbing, 위 표가 유일한 근거.

## F.4 타입 규칙

정적 타입 집합: `INTEGER`, `TEXT`, `BOOLEAN`, `NULLTYPE`(NULL 리터럴 및 NULLTYPE만으로 된 연산의 타입).

| 식 | 피연산자 조건 | 결과 타입 | 위반 시 |
|---|---|---|---|
| 정수/문자열/TRUE·FALSE/NULL 리터럴 | — | INTEGER / TEXT / BOOLEAN / NULLTYPE | |
| 컬럼 참조 | 테이블에 존재 | 컬럼 타입 | `COLUMN_NOT_FOUND` |
| 단항 `-` | INTEGER 또는 NULLTYPE | INTEGER | `TYPE_MISMATCH` |
| `+ - *` | 양쪽 각각 INTEGER 또는 NULLTYPE | INTEGER | `TYPE_MISMATCH` |
| 비교 6종 | 같은 타입이거나 한쪽 이상 NULLTYPE (BOOLEAN끼리도 6종 모두 허용, FALSE < TRUE) | BOOLEAN | `TYPE_MISMATCH` |
| `AND` `OR` `NOT` | BOOLEAN 또는 NULLTYPE | BOOLEAN | `TYPE_MISMATCH` |
| `IS [NOT] NULL` | 아무 타입 | BOOLEAN (값은 NULL이 될 수 없음) | |
| `WHERE` 조건 | BOOLEAN 또는 NULLTYPE | — | `TYPE_MISMATCH` |
| INSERT 값 / SET 값 | 컬럼 타입과 같거나 NULLTYPE | — | `TYPE_MISMATCH` |

## F.5 NULL 3값 논리와 평가 규칙

`T`=TRUE, `F`=FALSE, `U`=UNKNOWN(NULL).

| a | b | a AND b | a OR b |
|---|---|---|---|
| T | T | T | T |
| T | F | F | T |
| T | U | U | T |
| F | T | F | T |
| F | F | F | F |
| F | U | F | U |
| U | T | U | T |
| U | F | F | U |
| U | U | U | U |

| a | NOT a | a IS NULL | a IS NOT NULL |
|---|---|---|---|
| T | F | F | T |
| F | T | F | T |
| U | U | T | F |

- 비교·산술에서 한쪽이라도 NULL이면 결과 NULL. `NULL = NULL` → U.
- **단락 평가**: `AND`는 왼쪽이 F면 오른쪽을 평가하지 않고 F. `OR`는 왼쪽이 T면 평가하지 않고 T. 그 외에는 왼쪽 → 오른쪽 순서로 둘 다 평가.
- 산술 피연산자는 왼쪽 → 오른쪽 평가. 각 연산 결과 범위 검사(DC-35). 판정은 `Number.isSafeInteger(result)`.
- WHERE는 결과가 T인 행만 통과.
- 정렬 비교: INTEGER 수치, TEXT UTF-8 바이트(DC-39), BOOLEAN F < T, NULL 최소(DC-34).

## F.6 평가(논리 처리) 순서

`SELECT`: FROM(스캔) → WHERE → ORDER BY → OFFSET/LIMIT → SELECT 목록(투영).
`UPDATE`: 대상 수집(WHERE, 옛 행 기준) → 모든 대상의 SET 식을 **옛 행 기준으로 동시 평가**(`SET a = b, b = a`는 교환) → 검사 → 적용.
`DELETE`: 대상 수집 → 적용.
`INSERT`: VALUES 행 순서대로, 행 하나를 완전히(검사 → 힙 → 인덱스) 끝낸 뒤 다음 행.

## F.7 분석 단계 검사 목록 (모두 실행 전, 상태 변경 없음)

| # | 검사 | 오류 |
|---|---|---|
| A1 | 참조 테이블 존재 (SELECT/INSERT/UPDATE/DELETE/DROP TABLE/CREATE INDEX) | `TABLE_NOT_FOUND` |
| A2 | 참조 인덱스 존재 (DROP INDEX) | `INDEX_NOT_FOUND` |
| A3 | 컬럼 존재 (SELECT 목록, WHERE, ORDER BY, INSERT 컬럼 목록, SET 대상, CREATE INDEX) | `COLUMN_NOT_FOUND` |
| A4 | F.4 타입 규칙 | `TYPE_MISMATCH` |
| A5 | CREATE TABLE/INDEX 이름이 테이블·인덱스 이름 공간에 없음 | `OBJECT_EXISTS` |
| A6 | 이름이 `mdb_`로 시작하지 않음 | `RESERVED_NAME` |
| A7 | CREATE TABLE 컬럼 이름 중복 없음 | `DUPLICATE_COLUMN` |
| A8 | PRIMARY KEY 컬럼 ≤ 1 | `MULTIPLE_PRIMARY_KEYS` |
| A9 | 컬럼 수 ≤ 64 | `LimitError TOO_MANY_COLUMNS` |
| A10 | 같은 제약 반복 없음 | `DUPLICATE_CONSTRAINT` |
| A11 | INSERT 컬럼 목록 중복 없음 / UPDATE SET 대상 중복 없음 | `DUPLICATE_COLUMN` |
| A12 | INSERT 각 행 값 개수 = 대상 컬럼 수 | `COLUMN_COUNT_MISMATCH` |
| A13 | INSERT 값에 컬럼 참조 없음 | `NOT_CONSTANT` |
| A14 | DROP INDEX 대상이 자동 PK 인덱스가 아님 | `CANNOT_DROP_PK_INDEX` |

검사 순서는 문장 구문 순서(왼쪽 → 오른쪽)이며 첫 위반에서 중단. 오류 위치 = 위반 토큰.

## F.8 플래너 규칙 (규칙 기반, 결정적)

입력: Bound SELECT/UPDATE/DELETE, 옵션 `forceSeqScan`.

1. WHERE가 없거나 `forceSeqScan`이면 `SeqScan`.
2. WHERE를 최상위 `AND`로 평탄화해 conjunct 목록을 만든다(`OR`, `NOT` 내부로 들어가지 않음).
3. **인덱스 가능 conjunct**: `col op c` 또는 `c op col`(뒤쪽은 연산자를 뒤집어 정규화), `op ∈ {=, <, <=, >, >=}`, `col`에 인덱스가 하나 이상 있음, `c`는 NULL이 아닌 리터럴 또는 `-정수리터럴`. (`<>`, `!=`, `IS NULL`, 컬럼끼리 비교, 그 밖의 식은 불가.)
4. 인덱스 선택 우선순위: (a) `=` conjunct가 있는 **유일** 인덱스, (b) `=` conjunct가 있는 비유일 인덱스, (c) 범위 conjunct가 있는 인덱스. 같은 순위에서는 **인덱스 이름 오름차순** 첫 번째.
5. 선택한 인덱스 컬럼의 모든 인덱스 가능 conjunct로 범위를 계산: `=` → `[c, c]`. 하한은 가장 큰 값, 같은 값이면 배타가 이김. 상한은 가장 작은 값, 같은 값이면 배타가 이김. `=`가 여러 개고 값이 다르면 빈 범위(하한 > 상한)가 되어 결과 0행.
6. 플랜: `IndexScan(range)` + **WHERE 전체**를 담은 `Filter`(DC-70).
7. SELECT 플랜 모양(위에서 아래로): `Project` → `Limit`(있으면) → `Sort`(ORDER BY가 있으면) → `Filter`(WHERE가 있으면) → `SeqScan` | `IndexScan`.
8. UPDATE/DELETE 플랜: `Filter`(있으면) → `SeqScan` | `IndexScan`. 그 위에서 DML 연산자가 대상을 수집.

## F.9 연산자별 동작

| 연산자 | open | next | close | 비고 |
|---|---|---|---|---|
| `SeqScan(table)` | 커서를 (head, slot 0)에 | 체인을 따라 다음 살아 있는 slot의 행 복사본 반환 | — | pin을 `next()` 사이에 보유하지 않음 |
| `IndexScan(table, index, range)` | B+tree 커서를 하한에 seek | 다음 항목 → 범위 밖이면 끝 → RID로 힙 행 조회(없으면 `CorruptionError INDEX_HEAP_MISMATCH`) | — | 키 순서 반환 |
| `Filter(pred)` | child.open | T인 행이 나올 때까지 child.next | child.close | |
| `Sort(keys)` | child 전체 수집 후 안정 정렬 | 배열 순회 | 배열 해제 | 메모리 정렬 |
| `Limit(n, m)` | n = 0이면 child를 열지 않음 | 처음 m행 버림, n행 반환 후 끝 | | |
| `Project(cols)` | | 선택 컬럼만 새 배열로 | | `*`는 테이블 순서 전체 |
| `Insert` / `Update` / `Delete` | G.14 절차 | — | — | 결과 `changes` |

- 반환하는 행 값은 복사본이다(페이지 버퍼 뷰 금지).
- 연산자 `close()`는 오류 경로에서도 `finally`로 호출한다.

## F.10 EXPLAIN 형식

- 결과: `{ kind: 'rows', columns: ['plan'], rows: [[line], …] }`, 한 줄 = 플랜 노드 하나, 루트부터 전위 순회, 깊이마다 공백 2칸.
- 노드 형식(정확히):

| 노드 | 줄 형식 |
|---|---|
| Project | `Project columns=<c1>, <c2>, …` |
| Limit | `Limit limit=<n> offset=<m>` (OFFSET 생략 시 0) |
| Sort | `Sort keys=<c1> ASC, <c2> DESC` |
| Filter | `Filter predicate=<expr>` |
| SeqScan | `SeqScan table=<t>` |
| IndexScan | `IndexScan table=<t> index=<i> column=<c> range=<lb><lo>, <hi><ub>` |

- 범위 표기: `<lb>`는 `[`(포함) 또는 `(`(배타), `<ub>`는 `]` 또는 `)`. 무한은 `-inf`/`+inf`이고 항상 배타 괄호. 예: `range=[30, +inf)`, `range=[5, 5]`, `range=(-inf, 10)`.
- 식 표기(`sql/printer.ts`): 이항식 `(<l> <op> <r>)`(`!=`는 `<>`로), `(NOT <e>)`, `(-<e>)`, `(<e> IS NULL)`, `(<e> IS NOT NULL)`, 정수는 10진, 문자열은 `'…'`(내부 `'`는 `''`), `TRUE`/`FALSE`/`NULL`, 컬럼은 정규화 이름.
- 예:

```text
EXPLAIN SELECT name FROM users WHERE age >= 30 AND name <> 'x' ORDER BY name LIMIT 10

Project columns=name
  Limit limit=10 offset=0
    Sort keys=name ASC
      Filter predicate=((age >= 30) AND (name <> 'x'))
        IndexScan table=users index=idx_age column=age range=[30, +inf)
```

## F.11 결과 형태

| 문장 | ExecResult |
|---|---|
| SELECT, EXPLAIN | `rows` (컬럼 이름 = 정규화된 컬럼 이름, 0행이어도 columns 채움) |
| INSERT | `changes` = 삽입 행 수 |
| UPDATE | `changes` = 대상 행 수(값이 안 바뀌어도 셈) |
| DELETE | `changes` = 삭제 행 수 |
| DDL, BEGIN/COMMIT/ROLLBACK | `ok` + command 태그 |

## F.12 CLI

- 사용법: `minidb <file> [-c <sql> | -f <script.sql>]`, `minidb --help`.
- 모드: `-c` → `executeScript(sql)`; `-f` → 파일 내용을 `executeScript`; 둘 다 없으면 REPL. `-c`와 `-f` 동시 → 사용법 오류.
- REPL: 프롬프트 `minidb> `, 이어지는 줄 `   ...> `. 입력을 누적하다가 문자열·주석 밖의 `;`로 끝나면 실행. 줄이 `.`으로 시작하고 누적 입력이 비어 있으면 도트 명령.
- 도트 명령: `.help`, `.tables`(이름순 한 줄씩), `.schema [table]`(정규화된 CREATE 문: 테이블 이름순, 각 테이블 뒤에 자동이 아닌 인덱스 이름순), `.indexes [table]`, `.stats`(`JSON.stringify(stats, null, 2)`), `.integrity`(`ok` 또는 이슈마다 `CODE page=<n|-> object=<name|-> <message>`), `.checkpoint`, `.quit`/`.exit`. 모르는 명령 → `Error: unknown command .xyz`.
- 출력 형식(결정적):
  - rows: 첫 줄 컬럼 이름을 ` | `로 연결, 이어서 각 행을 같은 구분자로. NULL은 `NULL`, BOOLEAN은 `TRUE`/`FALSE`, TEXT는 원문 그대로. 마지막 줄 `(N rows)`, N=1이면 `(1 row)`.
  - changes: `INSERT 3`, `UPDATE 0`, `DELETE 2`.
  - ok: command 태그 그대로(`CREATE TABLE`, `BEGIN` …).
  - 오류: stderr에 `err.format()`(H.3).
- 종료 코드: `0` 성공 / `1` SQL 문장 오류(`-c`/`-f`는 첫 오류에서 중단) / `2` 사용법 오류 / `3` 오픈 실패(락·손상·I/O) 또는 종료 시 핸들이 FAILED. REPL에서 문장 오류는 출력 후 계속하고 종료 코드에 영향 없음.
- 구현: `runCli(argv: string[], io: { stdin: string | AsyncIterable<string>; stdout: (s: string) => void; stderr: (s: string) => void }): Promise<number>` — 테스트가 입출력을 주입한다(엔진 호출은 동기, REPL 입력 읽기만 비동기).

### 한도

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-10 | MAX_ROW_BYTES | 인코딩된 행 ≤ **4060** 바이트(= 4096 − 힙 헤더 32 − slot 4). 초과 시 `LimitError ROW_TOO_LARGE` | 4060 성공, 4061 실패 | 없음 |
| DC-11 | MAX_KEY_BYTES | 인코딩된 인덱스 키(RID 제외) ≤ **512** 바이트. 초과 시 `LimitError KEY_TOO_LARGE`. 내부 노드 최소 팬아웃 7 보장 | TEXT 512바이트 키 성공, 513 실패 | 없음 |
| DC-12 | MAX_TEXT_BYTES | TEXT 값(리터럴 포함) ≤ **4000** UTF-8 바이트. 렉서에서 검사 → `LimitError TEXT_TOO_LARGE` | `'한'`은 3바이트. 1334자 `'한…'` = 4002바이트 → 실패 | 없음 |
| DC-13 | 컬럼·식별자 | 테이블당 컬럼 ≤ **64**(`TOO_MANY_COLUMNS`). 식별자 1~**64** 바이트, ASCII `[A-Za-z_][A-Za-z0-9_]*`(`IDENTIFIER_TOO_LONG`) | 64 성공, 65 실패 | 없음 |
| DC-14 | INTEGER 범위 | −9007199254740991 ~ 9007199254740991. 디스크는 int64 LE. 디스크 값이 범위 밖이면 `CorruptionError RECORD_MALFORMED` | 리터럴 9007199254740992 → `LimitError INTEGER_OUT_OF_RANGE` | C.1.5 |

### 제약·의미론

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-31 | 유일성 검사 시점 | INSERT: 행마다 힙 쓰기 **전에** 검사(앞서 같은 문장에서 넣은 행 포함). UPDATE: **문장 수준** — 모든 새 행을 계산한 뒤 (a) 새 값끼리 중복, (b) 새 값과 비대상 행의 값 중복을 검사하고, 통과해야 적용. 위반 시 문장 롤백 | `UPDATE t SET id = id + 1`(id 1,2,3) 성공 | 없음 |
| DC-32 | NOT NULL | 행을 쓰기 직전 검사. PRIMARY KEY 컬럼은 암묵적 NOT NULL | `INSERT INTO t(id) VALUES (NULL)` → `NOT_NULL_VIOLATION` | 없음 |
| DC-33 | UNIQUE와 NULL | NULL은 여러 개 허용(색인 안 함) | `CREATE UNIQUE INDEX` 후 NULL 2행 성공 | 없음 |
| DC-34 | NULL 정렬 | NULL은 가장 작은 값: ASC면 맨 앞, DESC면 맨 뒤 | `ORDER BY x DESC` → NULL 마지막 | 없음 |
| DC-35 | 정수 오버플로 | `+ − *` 및 단항 `−`의 **각 연산 결과**가 안전 범위 밖이면 `LimitError INTEGER_OVERFLOW`(그 연산 노드 위치) | `9007199254740991 + 1` → 오류 | 없음 |
| DC-36 | VALUES | `VALUES ()` → `SqlSyntaxError`. 행의 값 개수 ≠ 대상 컬럼 수 → `SemanticError COLUMN_COUNT_MISMATCH`. 컬럼 목록 생략 시 전체 컬럼 순서. 목록에 없는 컬럼은 NULL | VALUES 안 컬럼 참조 → `NOT_CONSTANT` | 없음 |
| DC-37 | LIMIT/OFFSET | 정수 리터럴만. `LIMIT 0` → 빈 결과(하위 연산자를 당기지 않음). 음수는 문법상 불가(`SqlSyntaxError`). `OFFSET`은 `LIMIT` 뒤에만. OFFSET ≥ 행 수 → 빈 결과 | `LIMIT 5 OFFSET 100` → 0행 | 없음 |
| DC-38 | 타입 검사 | 분석 단계에서 검사. 암묵 변환 없음. NULL 리터럴은 어느 타입과도 호환 | `WHERE id = '1'` → `TYPE_MISMATCH` | 없음 |
| DC-39 | 문자열 비교 | UTF-8 바이트 사전식(= 코드 포인트 순서). JS `<`, `localeCompare` 금지 | U+FF61 < U+1F600 | 없음 |
| DC-40 | 식별자 | 대소문자 무시, ASCII 소문자로 정규화. 키워드는 전부 예약어. 따옴표 식별자 없음 | `Users`와 `USERS`는 같은 테이블 | 없음 |
| DC-41 | SELECT 목록 | `*` 또는 컬럼 이름 목록(중복 허용). ORDER BY 항목은 테이블 컬럼 이름(목록에 없어도 됨) | `SELECT a, a FROM t` 허용 | 없음 |
| DC-42 | 결과 순서 | ORDER BY가 없으면 순서 미정. ORDER BY 동률 간 순서 미정 | 테스트는 다중집합 비교 | 없음 |
| DC-43 | 런타임 오류 범위 | 실제로 평가된 행·식에서만 오류. AND/OR 단락 평가(F.5). 어떤 행이 평가되는지는 플랜에 따라 다를 수 있음 | `WHERE a = 1 AND b * c > 0` | 없음 |
| DC-44 | 이름 공간 | 테이블과 인덱스는 하나의 이름 공간. 중복 → `SemanticError OBJECT_EXISTS` | `CREATE INDEX t ON …`(t가 테이블) → 오류 | 없음 |
| DC-45 | 예약 이름 | `mdb_`로 시작하는 이름은 사용자 생성 불가(`RESERVED_NAME`). PK 자동 인덱스 이름 = `mdb_pk_<table>`, `DROP INDEX` 불가(`CANNOT_DROP_PK_INDEX`) | | 없음 |
| DC-46 | DROP 페이지 회수 | DROP 문 안에서 즉시 freelist에 넣으며 같은 트랜잭션에서 바로 재사용 가능. 커밋 시 확정, 롤백 시 페이지 이미지 복원으로 원상태 | | 없음 |
| DC-47 | CREATE INDEX 실패 | 기존 행으로 구축 중 오류(유일성·키 크기·TXN_TOO_LARGE) → 문장 롤백: 카탈로그 행 없음, 할당 페이지 없음(누수 0) | | 없음 |
| DC-61 | 힙 삽입 위치 | head 페이지의 `tailPage`에 삽입 시도 → 공간 없으면 새 페이지 할당 후 체인 끝에 연결. 앞쪽 페이지의 빈 공간은 같은 페이지의 UPDATE·compaction으로만 재사용 | 삭제 위주 워크로드는 파일이 늘 수 있음(LIMITATIONS) | 벤치마크에서 심각한 팽창 확인 시 |
| DC-62 | UPDATE/DELETE 실행 | 대상 (rid, 기존 행) 목록을 먼저 전부 수집한 뒤 적용 | 행 이동이 있어도 각 행 정확히 1회 갱신 | 없음 |

### 오류·출력·API

| ID | 영역 | 확정 규칙 | 예시·경계 | 번복 조건 |
|---|---|---|---|---|
| DC-54 | 오류 체계 | `MiniDbError` 기반, 하위: `SqlSyntaxError`, `SemanticError`, `ConstraintError`, `TransactionError`, `LimitError`, `StorageError`, `CorruptionError`, `InternalError`, `UsageError`. 코드 목록은 H.2가 전부 | 코드 형식 `^[A-Z][A-Z0-9_]*$` | 없음 |
| DC-55 | 위치 | `{ offset, line, column }`, 1부터. `\n`만 줄 구분. column은 **코드 포인트** 단위 | 탭은 1칸 | 없음 |
| DC-56 | EXPLAIN | F.10 형식(결정적, 들여쓰기 2칸) | | 없음 |
| DC-57 | CLI | F.12 | 종료 코드 0/1/2/3 | 없음 |
| DC-58 | 진단 API | `db.stats()`/`db.resetStats()`/`db.integrityCheck()`는 E.4 형식. `integrityCheck()`와 `checkpoint()`는 명시적 트랜잭션 중 → `TransactionError TXN_ACTIVE` | | 없음 |
| DC-59 | 실행 API | `execute(sql, opts?)`는 정확히 1문장(끝 `;` 선택). 0문장 → `SYNTAX_EMPTY_STATEMENT`, 2문장 이상 → `SYNTAX_MULTIPLE_STATEMENTS`. `executeScript(sql)`은 문장 배열을 순서대로 실행하고 첫 오류에서 중단(오류에 `statementIndex` 부여, 이전 문장 효과는 유지). 옵션 `{ forceSeqScan?: boolean }`(테스트·학습용) | | 없음 |

## H.1 오류 계층

```text
Error
└── MiniDbError (code, position?, sourceLine?, statementIndex?, cause?)
    ├── SqlSyntaxError     — 렉서·파서
    ├── SemanticError      — 분석기(이름·타입·DDL 규칙)
    ├── ConstraintError    — NOT NULL, UNIQUE/PK
    ├── TransactionError   — 트랜잭션 상태 오류
    ├── LimitError         — 크기·범위 한도
    ├── StorageError       — I/O, 잠금, FAILED
    ├── CorruptionError    — 체크섬·포맷·구조 손상
    ├── InternalError      — 불변식 위반(버그)
    └── UsageError         — API 오용
```

- 모든 클래스는 `src/errors/errors.ts`에 있고 `name` 속성이 클래스 이름과 같다.
- `SimulatedCrash`(FaultVfs)는 `MiniDbError`가 아니며 감싸지 않는다(테스트가 크래시를 감지해야 하므로).

## H.2 오류 코드 (전체 목록, 안정)

| 클래스 | 코드 | 발생 조건 | 위치 |
|---|---|---|---|
| SqlSyntaxError | `SYNTAX_UNEXPECTED_TOKEN` | 기대와 다른 토큰 | 그 토큰 |
| SqlSyntaxError | `SYNTAX_UNEXPECTED_EOF` | 입력이 문장 중간에 끝남 | 입력 끝 |
| SqlSyntaxError | `SYNTAX_UNTERMINATED_STRING` | 닫히지 않은 문자열 | 여는 `'` |
| SqlSyntaxError | `SYNTAX_INVALID_STRING` | lone surrogate | 여는 `'` |
| SqlSyntaxError | `SYNTAX_INVALID_CHARACTER` | 허용되지 않은 문자 | 그 문자 |
| SqlSyntaxError | `SYNTAX_INVALID_NUMBER` | `123abc` | 숫자 시작 |
| SqlSyntaxError | `SYNTAX_EMPTY_STATEMENT` | `execute`에 문장 없음 | 입력 끝 |
| SqlSyntaxError | `SYNTAX_MULTIPLE_STATEMENTS` | `execute`에 2문장 이상 | 두 번째 문장 시작 |
| SemanticError | `TABLE_NOT_FOUND` | | 이름 토큰 |
| SemanticError | `INDEX_NOT_FOUND` | | 이름 토큰 |
| SemanticError | `COLUMN_NOT_FOUND` | | 이름 토큰 |
| SemanticError | `OBJECT_EXISTS` | 이름 공간 중복 | 이름 토큰 |
| SemanticError | `DUPLICATE_COLUMN` | CREATE/INSERT 목록/SET 중복 | 두 번째 등장 |
| SemanticError | `DUPLICATE_CONSTRAINT` | 같은 제약 반복 | 두 번째 등장 |
| SemanticError | `MULTIPLE_PRIMARY_KEYS` | | 두 번째 PRIMARY |
| SemanticError | `TYPE_MISMATCH` | F.4 위반 | 연산자 또는 값 식 |
| SemanticError | `COLUMN_COUNT_MISMATCH` | VALUES 행 길이 | 그 행의 `(` |
| SemanticError | `NOT_CONSTANT` | VALUES 안 컬럼 참조 | 그 식별자 |
| SemanticError | `RESERVED_NAME` | `mdb_` 접두사 | 이름 토큰 |
| SemanticError | `CANNOT_DROP_PK_INDEX` | | 이름 토큰 |
| ConstraintError | `NOT_NULL_VIOLATION` | | INSERT: 그 행의 `(`, UPDATE: 문장 시작 |
| ConstraintError | `UNIQUE_VIOLATION` | PK 포함 | INSERT: 그 행의 `(`, UPDATE/CREATE INDEX: 문장 시작 |
| TransactionError | `TXN_ALREADY_ACTIVE` | 중첩 BEGIN | `BEGIN` |
| TransactionError | `TXN_NOT_ACTIVE` | 트랜잭션 없이 COMMIT/ROLLBACK | 그 키워드 |
| TransactionError | `TXN_ACTIVE` | 트랜잭션 중 `checkpoint()`/`integrityCheck()` | 없음 |
| LimitError | `ROW_TOO_LARGE` | > 4060 | INSERT: 행 `(`, UPDATE: 문장 시작 |
| LimitError | `KEY_TOO_LARGE` | > 512 | 위와 같음 |
| LimitError | `TEXT_TOO_LARGE` | > 4000 | 문자열 리터럴 |
| LimitError | `TOO_MANY_COLUMNS` | > 64 | 65번째 컬럼 |
| LimitError | `IDENTIFIER_TOO_LONG` | > 64 | 식별자 |
| LimitError | `INTEGER_OUT_OF_RANGE` | 리터럴 범위 밖 | 리터럴 |
| LimitError | `INTEGER_OVERFLOW` | 연산 결과 범위 밖 | 그 연산자 노드 |
| LimitError | `TXN_TOO_LARGE` | DC-16 | 문장 시작 |
| StorageError | `IO_ERROR` | 읽기·checkpoint·생성 I/O 오류 | 없음 |
| StorageError | `IO_COMMIT_UNKNOWN` | 커밋 중 I/O 오류 | 없음 |
| StorageError | `DB_LOCKED` | G.15 | 없음 |
| StorageError | `DB_FAILED` | FAILED 이후 호출 | 없음 |
| CorruptionError | `NOT_A_DATABASE` | magic 불일치, 크기 < 4096 | 없음 |
| CorruptionError | `UNSUPPORTED_FORMAT_VERSION` | 버전·pageSize | 없음 |
| CorruptionError | `FILE_TRUNCATED` | 크기 < pageCount×4096 | 없음 |
| CorruptionError | `PAGE_CHECKSUM_MISMATCH` | | 없음(메시지에 pageId) |
| CorruptionError | `PAGE_ID_MISMATCH` | | 없음 |
| CorruptionError | `PAGE_TYPE_INVALID` | 알 수 없는 pageType | 없음 |
| CorruptionError | `PAGE_TYPE_MISMATCH` | 포인터가 예상과 다른 타입의 페이지를 가리킴 | 없음 |
| CorruptionError | `PAGE_OUT_OF_RANGE` | pageId ≥ pageCount 또는 파일 밖 | 없음 |
| CorruptionError | `FREELIST_INVALID` | | 없음 |
| CorruptionError | `RECORD_MALFORMED` | D.4 디코딩 실패, slot 범위 오류 | 없음 |
| CorruptionError | `BTREE_MALFORMED` | 노드 구조 위반(셀 범위 등) | 없음 |
| CorruptionError | `INDEX_HEAP_MISMATCH` | 인덱스가 없는 행을 가리킴 | 없음 |
| CorruptionError | `CATALOG_INVALID` | D.7 검증 실패 | 없음 |
| CorruptionError | `WAL_HEADER_INVALID` | DC-22 | 없음 |
| CorruptionError | `WAL_FRAME_INVALID` | 체인 유효·페이지 CRC 무효 | 없음 |
| CorruptionError | `WAL_MISMATCH` | dbId 불일치 | 없음 |
| InternalError | `INVARIANT_VIOLATION` | 불변식 위반, 비-MiniDb 예외 감싸기 | 없음 |
| UsageError | `DB_CLOSED` | 닫힌 핸들 사용 | 없음 |
| UsageError | `INVALID_OPTION` | 옵션 범위 밖 | 없음 |

`src/errors/codes.ts`는 이 표와 같은 집합을 `as const`로 정의하고, `check-docs.mjs`가 SPEC.md의 표와 대조한다.

## H.3 메시지 형식

- `err.message`: 사람이 읽는 한 문장(위치 없음). 예: `expected ')' but found ','`.
- `err.format()`:

```text
<ClassName> <CODE> at <line>:<column>: <message>
  <line> | <source line>
       | <공백><^>
```

  - 위치가 없으면 첫 줄은 `<ClassName> <CODE>: <message>`이고 나머지 두 줄은 없다.
  - 소스 줄: 공백 2칸 + `<line>` + ` | ` + 소스 줄. 캐럿 줄: 공백 2칸 + `<line>` 자릿수만큼 공백 + ` | ` + (column−1개 코드 포인트를 탭은 탭, 나머지는 공백으로) + `^`.
  - `executeScript`/CLI에서 `statementIndex`가 있으면 첫 줄 끝에 ` (statement <n>)`(1부터).
- 예:

```text
SqlSyntaxError SYNTAX_UNEXPECTED_TOKEN at 1:25: expected ')' but found ','
  1 | SELECT * FROM t WHERE (a, b)
    |                         ^
ConstraintError UNIQUE_VIOLATION at 2:8: duplicate key in index mdb_pk_users (column id)
  2 |        (1, 'bob')
    |        ^
LimitError INTEGER_OVERFLOW at 1:20: integer result out of range
  1 | UPDATE t SET n = n * 9007199254740991
    |                    ^
StorageError DB_FAILED: database is in failed state; close and reopen (cause: IO_COMMIT_UNKNOWN)
```

## H.4 위치 규칙

1. 렉서·파서·분석기 오류는 H.2의 "위치" 토큰 시작 위치.
2. 런타임 오류는 바운드 노드가 보존한 소스 위치(파서가 모든 AST 노드에 `pos`를 넣고 분석기가 그대로 옮긴다).
3. `position`과 `sourceLine`은 항상 같이 있거나 같이 없다. `sourceLine`은 해당 줄 전체(줄바꿈 제외).
4. `executeScript`의 위치는 스크립트 전체 텍스트 기준(문장별 재계산 없음).

## H.5 오류 후 상태 보장

| 오류 | DB 상태 | 트랜잭션 | 핸들 |
|---|---|---|---|
| SqlSyntaxError, SemanticError | 변경 없음 | 그대로 | 사용 가능 |
| ConstraintError, LimitError(실행 중), TransactionError | 그 문장 이전 상태(문장 롤백) | 자동 커밋: 롤백 / 명시적: 유지(이전 문장 변경 유지) | 사용 가능 |
| StorageError IO_ERROR(읽기) | 문장 롤백 | 위와 같음 | 사용 가능 |
| StorageError IO_COMMIT_UNKNOWN / IO_ERROR(쓰기) | 디스크는 S 또는 S⁺ | 종료 | FAILED |
| CorruptionError, InternalError | 디스크는 마지막 durable 커밋(손상 부분 제외) | 종료 | FAILED |
| UsageError | 변경 없음 | 그대로 | 그대로 |

## 구현 반영 (DECISIONS.md)

- DEC-005: `executeScript`는 문장을 하나씩 파싱·실행한다. 구문 오류 문장 이전의 문장은 실행된 상태로 남고, 렉서 오류(닫히지 않은 문자열 등)는 스크립트 전체를 실행 전에 거부한다(`statementIndex` = 0).
- DEC-006: UTF-8 512바이트를 넘는 TEXT 리터럴과의 비교는 인덱스 경계로 쓰지 않는다(F.8 규칙 3 보충). 범위: 플래너 자신이 인덱스 유무에 따라 새 오류를 만들지 않게 하는 규칙이다. 행을 평가할 때 생기는 런타임 오류(예: `INTEGER_OVERFLOW`)는 DC-43에 따라 평가되는 행이 플랜마다 다를 수 있으므로 SeqScan/IndexScan 사이에 달라질 수 있다(DEC-007).
- DEC-008(T-ERR-005): `executeScript`의 `onResult`는 각 문장이 완료된 뒤(자동 커밋이면 커밋 후, 명시적 트랜잭션이면 문장 savepoint 해제 후) 호출된다. callback이 던진 예외는 원래 값 그대로 전파되고 스크립트는 그 지점에서 중단된다. 그 문장과 이전 문장의 효과는 유지되고(DC-59), 열린 명시적 트랜잭션은 그대로 열려 있으며, 핸들은 FAILED가 되지 않는다.
- 리뷰 L-1(T-ERR-004): `execute`/`executeScript`의 인수 타입 오용(비문자열 SQL, 객체가 아닌 옵션, boolean이 아닌 `forceSeqScan`, 함수가 아닌 `onResult`)은 `UsageError INVALID_OPTION`이며 H.5 표대로 트랜잭션·핸들 상태를 바꾸지 않는다.
