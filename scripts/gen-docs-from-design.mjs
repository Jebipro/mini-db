// One-shot generator used in P0: extracts the normative sections of DESIGN_REVIEW.md
// into SPEC/FORMAT/ARCHITECTURE/DURABILITY/TESTING so the derived docs are verbatim copies.
// Re-running regenerates the docs; manual edits to those docs must go through DECISIONS.md.
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../DESIGN_REVIEW.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const lines = src.split('\n');

/** Returns the lines of the section whose heading line starts with `heading`, up to the next heading of the same or higher level. */
function section(heading) {
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) throw new Error(`heading not found: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  let end = lines.length;
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('```')) inFence = !inFence;
    if (inFence) continue;
    const m = l.match(/^(#+) /);
    if (m && m[1].length <= level) { end = i; break; }
    if (l === '---') { end = i; break; }
  }
  // demote by one level so each extracted section sits under the document title
  let fence = false;
  return lines.slice(start, end).map((l) => {
    if (l.startsWith('```')) fence = !fence;
    if (!fence && /^#{2,5} /.test(l)) return l.replace(/^(#+)/, (h) => h.slice(1) || '#');
    return l;
  }).join('\n').trimEnd();
}

function doc(title, intro, headings) {
  const body = headings.map(section).join('\n\n');
  return `# ${title}\n\n${intro}\n\n> 출처: \`DESIGN_REVIEW.md\` rev1의 해당 섹션을 그대로 옮겼다(섹션 번호 유지). 변경은 \`DECISIONS.md\`에 기록한 뒤 두 문서를 함께 고친다.\n\n${body}\n`;
}

const out = {
  'SPEC.md': doc('Mini DB — SPEC', '언어(SQL-like)의 문법, 타입, NULL 논리, 실행 의미론, 한도, 오류 코드의 명세.', [
    '### F.1', '### F.2', '### F.3', '### F.4', '### F.5', '### F.6', '### F.7', '### F.8', '### F.9', '### F.10', '### F.11', '### F.12',
    '#### 한도', '#### 제약·의미론', '#### 오류·출력·API',
    '### H.1', '### H.2', '### H.3', '### H.4', '### H.5',
  ]),
  'FORMAT.md': doc('Mini DB — FORMAT', '데이터 파일·WAL 파일의 바이트 단위 형식과 버전 정책. 오프셋 상수는 `src/storage/layout.ts` 한 곳에만 정의한다.', [
    '### D.0', '### D.1', '### D.2', '### D.3', '### D.4', '### D.5', '### D.6', '### D.7', '### D.8', '### D.9', '#### 파일 형식',
  ]),
  'ARCHITECTURE.md': doc('Mini DB — ARCHITECTURE', '모듈 책임, 의존 방향, 핵심 인터페이스, 데이터 흐름, 디렉터리 구조.', [
    '### E.1', '### E.2', '### E.3', '### E.4', '### E.5', '#### 스택·런타임',
  ]),
  'DURABILITY.md': doc('Mini DB — DURABILITY', 'Pager·WAL 프로토콜, fsync 지점(F1~F5), 크래시 관찰표, 불변식(I1~I16, D1~D7), 실패 상태, 힙·B+tree·DML 절차.', [
    '### G.1', '### G.2', '### G.3', '### G.4', '### G.5', '### G.6', '### G.7', '### G.8', '### G.9', '### G.10', '### G.11', '### G.12', '### G.13', '### G.14', '### G.15',
    '#### 캐시·버퍼·트랜잭션', '#### WAL·복구', '#### RID·인덱스', '#### 실패·잠금·플랫폼',
  ]),
  'TESTING.md': doc('Mini DB — TESTING', '테스트 계층, 테스트 ID(T-*) 정의, 참조 모델, 장애 주입, 재현 규칙, 실행 시간 예산, 스크립트.', [
    '### J.1', '### J.2', '### J.3', '### J.4', '### J.5', '### J.6', '### J.7', '### J.8', '### J.9',
  ]),
};

for (const [name, text] of Object.entries(out)) {
  writeFileSync(new URL(`../${name}`, import.meta.url), text);
  console.log(`wrote ${name} (${text.length} chars)`);
}
