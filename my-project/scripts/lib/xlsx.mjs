// FREESIS(및 비슷한 한국 통계 포털) 다운로드 파일을 행렬(rows of cells)로 읽는다.
// 의존성 없음. xlsx(zip)는 Windows 내장 tar(bsdtar)로 풀고 XML을 직접 읽는다.
//
// 세 형식을 자동 판별한다: 진짜 xlsx(zip), HTML 표에 .xls 확장자가 붙은 형식, CSV/TSV.
//
// scripts/ingest-split.mjs 에 있던 파서를 scripts/ingest-lending.mjs 와 공유하기 위해
// 이 공용 모듈로 뽑아냈다. ingest-split.mjs의 동작(출력)은 그대로 유지된다.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const unesc = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))) // 숫자 문자 참조(&#45824; 등)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const colIndex = letters => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** 진짜 xlsx: zip 안의 sharedStrings.xml + sheet1.xml 을 읽는다. */
function fromXlsx(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freesis-'));
  try {
    // Git Bash의 tar는 GNU tar라 gzip/xz 만 읽고 ZIP(xlsx 컨테이너)은 못 연다.
    // Windows 내장 tar.exe(System32, bsdtar 기반)는 zip 을 읽으므로 절대경로로 그걸 쓴다.
    const bsdtar = process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    execFileSync(bsdtar, ['-xf', file, '-C', tmp], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`xlsx 압축 해제 실패(tar). ${e.message}`);
  }

  const sstPath = path.join(tmp, 'xl', 'sharedStrings.xml');
  let shared = [];
  if (fs.existsSync(sstPath)) {
    const xml = fs.readFileSync(sstPath, 'utf8');
    shared = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
      [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => unesc(t[1])).join(''));
  }

  const sheetDir = path.join(tmp, 'xl', 'worksheets');
  const sheetFile = fs.readdirSync(sheetDir).filter(f => f.endsWith('.xml')).sort()[0];
  const sx = fs.readFileSync(path.join(sheetDir, sheetFile), 'utf8');

  const rows = [];
  for (const rm of sx.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1], inner = cm[2];
      const col = colIndex((attrs.match(/r="([A-Z]+)/) ?? [, 'A'])[1]);
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) ?? [])[1];
      const isStr = /t="s"/.test(attrs);
      const inlineT = (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) ?? [])[1];
      let val = inlineT != null ? unesc(inlineT)
        : v == null ? ''
          : isStr ? (shared[Number(v)] ?? '') : v;
      cells[col] = String(val).trim();
    }
    rows.push([...cells].map(c => c ?? ''));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return rows;
}

/** 한국 포털이 흔히 내주는 'HTML 표에 .xls 확장자' 형식. */
function fromHtmlTable(text) {
  const rows = [];
  for (const tr of text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(c => unesc(c[1].replace(/<[^>]+>/g, '')).replace(/ /g, ' ').trim());
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function fromDelimited(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  const sep = (lines[0].match(/\t/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? '\t' : ',';
  return lines.map(l => splitCsv(l, sep));
}

// 따옴표 안의 구분자를 지켜서 자른다.
function splitCsv(line, sep) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === sep && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(c => c.trim());
}

export function readMatrix(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4).toString('binary') === 'PK\x03\x04') return fromXlsx(file);
  const text = buf.toString('utf8');
  if (/<table|<TABLE|<tr[\s>]/i.test(text)) return fromHtmlTable(text);
  return fromDelimited(text);
}

export const toNum = s => {
  const t = String(s).replace(/[,\s원]/g, '');
  if (t === '' || t === '-' || t === 'null') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// 20260728 / 2026-07-28 / 2026.07.28 / 2026/07/28 을 모두 받는다.
export const toDate = s => {
  const t = String(s).trim();
  const m = t.match(/^(\d{4})[-./]?(\d{2})[-./]?(\d{2})$/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
};

/**
 * 여러 폴더(보통 data/ 와 프로젝트 루트 — 사용자가 다운로드 파일을 아무 데나 둔다)에서
 * 이름 조각(name fragment)에 맞는 가장 최근 파일을 찾는다.
 * @param {string[]} dirs 검색할 디렉터리 목록, 우선순위 순서 무관(mtime으로 정렬)
 * @param {string=} argPath 사용자가 직접 지정한 경로(있으면 이걸 그대로 쓴다)
 * @param {string=} nameHint 파일명에 포함되어야 할 문자열(없으면 필터링하지 않는다)
 */
export function pickFile(dirs, argPath, nameHint) {
  if (argPath) return path.resolve(argPath);
  const all = dirs.flatMap(dir => fs.existsSync(dir)
    ? fs.readdirSync(dir)
      .filter(f => /\.(xlsx|xls|csv|tsv|txt)$/i.test(f))
      .map(f => ({ f, dir, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    : []);
  const cands = (nameHint ? all.filter(x => x.f.includes(nameHint)) : all)
    .sort((a, b) => b.m - a.m);
  const pool = cands.length ? cands : all.sort((a, b) => b.m - a.m); // 이름 힌트로 못 찾으면 아무 파일이나
  if (!pool.length) return null;
  return path.join(pool[0].dir, pool[0].f);
}
