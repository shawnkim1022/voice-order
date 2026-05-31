#!/usr/bin/env node
/**
 * voice-order 일일 측정 보고서 생성기.
 *
 * 입력:
 *   results/nightly-matrix/<date>/summary.json   ← Agent #1 (nightly-matrix-r3.sh) 가 매일 생성
 *
 * 출력:
 *   docs/diagnose/reports/NIGHTLY_<date>.md       ← 일일 보고서 (markdown)
 *   docs/diagnose/trends/trend.json               ← 누적 추세 (7일 / 30일 rolling)
 *   /tmp/nightly-alert.txt                        ← regression 감지 시만 생성
 *
 * Regression 룰:
 *   · 셀별 오늘 vs 어제 < -5pp → ALERT
 *   · 셀별 오늘 vs 7일 평균 < -7pp → ALERT
 *   · 임의 셀 staffMsgRate > 1% → ALERT (직원 호출률은 0 을 목표로 하는 핵심 지표)
 *
 * 사용:
 *   node scripts/nightly-report.mjs                          # 오늘 (KST) 자동
 *   node scripts/nightly-report.mjs --date=2026-05-26
 *   node scripts/nightly-report.mjs --input=path/to/summary.json --date=2026-05-26
 *   node scripts/nightly-report.mjs --notify                 # macOS osascript notification
 *
 * 입력 schema (defensive — Agent #1 출력 기준 + 보정):
 *   {
 *     "date": "2026-05-26",
 *     "cells": {
 *       "normal_1-2_low":     { "label": "normal × 1-2 잔 × low", "passRate": 0.95, "total": 500, "staffMsgRate": 0, "qtyMismatchRate": 0.02, "stuckRate": 0.01, "topFailures": [...] },  // 값은 schema 예시
 *       "normal_3_low":       { ... },
 *       "normal_medium":      { ... },
 *       "hard_1-2":           { ... },
 *       "recommendation":     { ... },
 *       "allergy":            { ... }
 *     },
 *     "overall": { "passRate": ..., "staffMsgRate": ..., "qtyMismatchRate": ..., "stuckRate": ... }    // 선택
 *   }
 *
 * Native shape (nightly-matrix-r3.sh aggregate):
 *   {
 *     "date": "...", "generatedAt": "...", "outDir": "...",
 *     "dimensions": { "<dim>": { passRate, total, stuckRate, staffMsgRate, qtyMismatchRate, ... } },
 *     "summary": { "totalRuns": N, "overallPassRate": f, "totalStuck": N, "totalStaffMsg": N, "totalQtyMismatch": N, "perDimPassRate": {...} }
 *   }
 *   → dimensions = cells, summary = overall (rate 환산).
 *
 * Fallback: top-level 자체를 cells dict 로 처리 (key 의 value 가 passRate 가지면 cell).
 *
 * 제약 (단일 프로세스 / 외부 의존성 0):
 *   · 단일 process (read + write)
 *   · 외부 의존성 0 (Node builtin only)
 *   · production NLU 코드 접근 X
 *   · trend.json append-only (sliding window cap 90)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// ─── 상수 ───────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// REPO_ROOT — 환경변수 override 지원 (테스트용). default = scripts/.. = repo root.
const REPO_ROOT = process.env.VOICE_ORDER_REPO_ROOT
  ? path.resolve(process.env.VOICE_ORDER_REPO_ROOT)
  : path.resolve(__dirname, '..');

const PATHS = {
  matrixDir: path.join(REPO_ROOT, 'results', 'nightly-matrix'),
  reportDir: path.join(REPO_ROOT, 'docs', 'diagnose', 'reports'),
  trendDir: path.join(REPO_ROOT, 'docs', 'diagnose', 'trends'),
  trendFile: path.join(REPO_ROOT, 'docs', 'diagnose', 'trends', 'trend.json'),
  alertFile: process.env.VOICE_ORDER_ALERT_FILE || '/tmp/nightly-alert.txt',
};

const ALERT_THRESHOLDS = {
  vsYesterdayDeltaPp: -5,
  vsRollingDeltaPp: -7,
  staffMsgRateMax: 0.01,
};

const TREND_HISTORY_CAP = 90; // sliding window — 30일 보다 여유

// ─── arg 파싱 ───────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    date: null,
    input: null,
    notify: false,
    dryRun: false,
    output: null, // 보고서 출력 override (dry-run 용)
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a.startsWith('--input=')) args.input = a.slice('--input='.length);
    else if (a.startsWith('--output=')) args.output = a.slice('--output='.length);
    else if (a === '--notify') args.notify = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'nightly-report.mjs — voice-order 일일 보고서 생성',
          '',
          '사용:',
          '  node scripts/nightly-report.mjs [--date=YYYY-MM-DD] [--input=PATH] [--output=DIR] [--notify] [--dry-run]',
          '',
          '입력 (default): results/nightly-matrix/<today>/summary.json',
          '출력 (default): docs/diagnose/reports/NIGHTLY_<date>.md  +  trends/trend.json',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return args;
}

// ─── date utils (KST) ─────────────────────────────────────────────────────
function todayKST() {
  // KST = UTC+9. 현 시각 UTC + 9h → ISO YYYY-MM-DD.
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function daysBefore(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ─── 입력 로드 ──────────────────────────────────────────────────────────
function loadSummary(date, override) {
  const candidates = [];
  if (override) candidates.push(override);
  candidates.push(path.join(PATHS.matrixDir, date, 'summary.json'));
  // Agent #1 이 merged-summary.json 형식을 쓸 가능성 대비
  candidates.push(path.join(PATHS.matrixDir, date, 'merged-summary.json'));

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return { path: p, data: raw };
      } catch (err) {
        console.error(`[nightly-report] failed to parse ${p}: ${err.message}`);
        return null;
      }
    }
  }
  return null;
}

// ─── 정규화: 어떤 shape 가 와도 cells dict 로 통일 ────────────────────
/**
 * 정규화된 형태:
 * {
 *   date: "YYYY-MM-DD",
 *   cells: { <key>: { label, passRate, total?, stuckRate?, staffMsgRate?, qtyMismatchRate?, topFailures? } },
 *   overall?: { passRate, stuckRate, staffMsgRate, qtyMismatchRate }
 * }
 */
function normalize(rawSummary, fallbackDate) {
  if (!rawSummary || typeof rawSummary !== 'object') return null;

  // case 1: 명시적 cells 키
  if (rawSummary.cells && typeof rawSummary.cells === 'object') {
    return {
      date: rawSummary.date || fallbackDate,
      cells: normalizeCells(rawSummary.cells),
      overall: rawSummary.overall || null,
    };
  }

  // case 1b: dimensions + summary 키 (nightly-matrix-r3.sh aggregate 형식)
  // shape: { date, generatedAt, outDir, dimensions: { <dim>: { passRate, ... } }, summary: { totalRuns, overallPassRate, totalStuck, totalStaffMsg, totalQtyMismatch, ... } }
  if (rawSummary.dimensions && typeof rawSummary.dimensions === 'object') {
    const sum = rawSummary.summary || {};
    const totalRuns = typeof sum.totalRuns === 'number' && sum.totalRuns > 0 ? sum.totalRuns : null;
    const ratio = (n) =>
      typeof n === 'number' && totalRuns ? n / totalRuns : null;
    return {
      date: rawSummary.date || fallbackDate,
      cells: normalizeCells(rawSummary.dimensions),
      overall: {
        passRate: typeof sum.overallPassRate === 'number' ? sum.overallPassRate : null,
        stuckRate: ratio(sum.totalStuck),
        staffMsgRate: ratio(sum.totalStaffMsg),
        qtyMismatchRate: ratio(sum.totalQtyMismatch),
      },
    };
  }

  // case 2: top-level 이 cells 처럼 보임 (value 가 passRate 가짐)
  const looksLikeCellMap = Object.entries(rawSummary).some(
    ([, v]) => v && typeof v === 'object' && typeof v.passRate === 'number',
  );
  if (looksLikeCellMap) {
    const cells = {};
    const meta = {};
    for (const [k, v] of Object.entries(rawSummary)) {
      if (v && typeof v === 'object' && typeof v.passRate === 'number') {
        cells[k] = v;
      } else {
        meta[k] = v;
      }
    }
    return {
      date: meta.date || fallbackDate,
      cells: normalizeCells(cells),
      overall: meta.overall || null,
    };
  }

  // case 3: 단일 merged-summary (corpus-matrix-runner 형식)
  if (typeof rawSummary.passRate === 'number') {
    const label = rawSummary.config
      ? `${rawSummary.config.personaGroup || '?'} × ${
          rawSummary.config.itemCount || '?'
        } × ${rawSummary.config.intensity || '?'}`
      : 'single_cell';
    const key = (rawSummary.config &&
      [
        rawSummary.config.personaGroup,
        rawSummary.config.itemCount,
        rawSummary.config.intensity,
      ]
        .filter(Boolean)
        .join('_')) || 'single_cell';
    return {
      date: fallbackDate,
      cells: normalizeCells({ [key]: { label, ...rawSummary } }),
      overall: {
        passRate: rawSummary.passRate,
        stuckRate: rawSummary.stuckRate || 0,
        staffMsgRate: rawSummary.staffMsgRate || 0,
        qtyMismatchRate: rawSummary.qtyMismatchRate || 0,
      },
    };
  }

  return null;
}

function normalizeCells(cells) {
  const out = {};
  for (const [k, v] of Object.entries(cells)) {
    if (!v || typeof v !== 'object') continue;
    out[k] = {
      label: v.label || labelFromKey(k),
      passRate: numOrNull(v.passRate),
      total: numOrNull(v.total),
      stuckRate: numOrNull(v.stuckRate),
      staffMsgRate: numOrNull(v.staffMsgRate),
      qtyMismatchRate: numOrNull(v.qtyMismatchRate),
      topFailures: Array.isArray(v.topFailures) ? v.topFailures : null,
    };
  }
  return out;
}

function numOrNull(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function labelFromKey(k) {
  // "normal_1-2_low" → "normal × 1-2 × low"
  return k.replace(/_/g, ' × ');
}

// ─── 추세 (trend.json) 로드 + 갱신 ──────────────────────────────────────
function loadTrend() {
  if (!fs.existsSync(PATHS.trendFile)) {
    return { history: [], rolling: { '7day_avg': {}, '30day_avg': {} } };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.trendFile, 'utf-8'));
    if (!raw || typeof raw !== 'object') {
      return { history: [], rolling: { '7day_avg': {}, '30day_avg': {} } };
    }
    return {
      history: Array.isArray(raw.history) ? raw.history : [],
      rolling: raw.rolling || { '7day_avg': {}, '30day_avg': {} },
    };
  } catch (err) {
    console.error(`[nightly-report] trend.json parse error: ${err.message}`);
    return { history: [], rolling: { '7day_avg': {}, '30day_avg': {} } };
  }
}

function toMetricsRecord(summary) {
  const metrics = {};
  for (const [k, v] of Object.entries(summary.cells)) {
    metrics[`${k}_passRate`] = v.passRate;
    if (v.staffMsgRate !== null) metrics[`${k}_staffMsgRate`] = v.staffMsgRate;
    if (v.qtyMismatchRate !== null) metrics[`${k}_qtyMismatchRate`] = v.qtyMismatchRate;
    if (v.stuckRate !== null) metrics[`${k}_stuckRate`] = v.stuckRate;
  }
  if (summary.overall) {
    if (typeof summary.overall.passRate === 'number')
      metrics.overall_passRate = summary.overall.passRate;
    if (typeof summary.overall.staffMsgRate === 'number')
      metrics.overall_staffMsgRate = summary.overall.staffMsgRate;
    if (typeof summary.overall.qtyMismatchRate === 'number')
      metrics.overall_qtyMismatchRate = summary.overall.qtyMismatchRate;
    if (typeof summary.overall.stuckRate === 'number')
      metrics.overall_stuckRate = summary.overall.stuckRate;
  }
  return metrics;
}

function appendHistory(trend, date, metrics) {
  // 같은 날짜 중복 = 마지막 record 덮어쓰기 (재실행 안전)
  const idx = trend.history.findIndex((h) => h.date === date);
  const record = { date, metrics };
  if (idx >= 0) trend.history[idx] = record;
  else trend.history.push(record);
  trend.history.sort((a, b) => a.date.localeCompare(b.date));
  // 90개 cap (sliding window)
  if (trend.history.length > TREND_HISTORY_CAP) {
    trend.history = trend.history.slice(trend.history.length - TREND_HISTORY_CAP);
  }
}

function computeRollingAvg(trend, date, windowDays) {
  const earliest = daysBefore(date, windowDays - 1);
  const window = trend.history.filter((h) => h.date >= earliest && h.date <= date);
  if (window.length === 0) return {};
  const keys = new Set();
  for (const h of window) {
    for (const k of Object.keys(h.metrics || {})) keys.add(k);
  }
  const avg = {};
  for (const k of keys) {
    let sum = 0;
    let n = 0;
    for (const h of window) {
      const v = h.metrics?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
        n += 1;
      }
    }
    if (n > 0) avg[k] = sum / n;
  }
  return avg;
}

function refreshRolling(trend, date) {
  trend.rolling = {
    '7day_avg': computeRollingAvg(trend, date, 7),
    '30day_avg': computeRollingAvg(trend, date, 30),
  };
}

// ─── 회귀 alert 판정 ───────────────────────────────────────────────────
function detectAlerts(summary, trend, date) {
  const alerts = [];
  const yesterday = trend.history.find((h) => h.date === daysBefore(date, 1));
  const rolling7 = trend.rolling?.['7day_avg'] || {};

  for (const [cellKey, cell] of Object.entries(summary.cells)) {
    const today = cell.passRate;
    if (today === null) continue;

    // 1. staffMsgRate > 1% — 사용자 명시 우선순위
    if (
      cell.staffMsgRate !== null &&
      cell.staffMsgRate > ALERT_THRESHOLDS.staffMsgRateMax
    ) {
      alerts.push({
        type: 'STAFF_MSG',
        cell: cellKey,
        label: cell.label,
        value: cell.staffMsgRate,
        message: `[STAFF] ${cell.label} staffMsgRate=${pct(cell.staffMsgRate)} (>1%) — 사용자 명시 우선순위 위반`,
      });
    }

    // 2. vs yesterday
    if (yesterday?.metrics?.[`${cellKey}_passRate`] !== undefined) {
      const yMetric = yesterday.metrics[`${cellKey}_passRate`];
      const deltaPp = (today - yMetric) * 100;
      if (deltaPp < ALERT_THRESHOLDS.vsYesterdayDeltaPp) {
        alerts.push({
          type: 'REGRESSION_VS_YESTERDAY',
          cell: cellKey,
          label: cell.label,
          deltaPp,
          today,
          yesterday: yMetric,
          message: `[REGRESSION] ${cell.label} ${deltaPp.toFixed(1)}pp vs 어제 (오늘 ${pct(today)} vs 어제 ${pct(yMetric)})`,
        });
      }
    }

    // 3. vs 7일 평균
    if (rolling7[`${cellKey}_passRate`] !== undefined) {
      const r = rolling7[`${cellKey}_passRate`];
      const deltaPp = (today - r) * 100;
      if (deltaPp < ALERT_THRESHOLDS.vsRollingDeltaPp) {
        alerts.push({
          type: 'REGRESSION_VS_7DAY',
          cell: cellKey,
          label: cell.label,
          deltaPp,
          today,
          rolling7: r,
          message: `[REGRESSION] ${cell.label} ${deltaPp.toFixed(1)}pp vs 7일 평균 (오늘 ${pct(today)} vs 7일 ${pct(r)})`,
        });
      }
    }
  }

  return alerts;
}

// ─── markdown 보고서 렌더 ─────────────────────────────────────────────
function pct(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * deltaCell — Δ 표기.
 *  - direction='higherIsBetter' (default — passRate 류):  +2pp 이상 ★, -2pp 이하 ▼
 *  - direction='lowerIsBetter'  (qty/staff/stuck 류):     -2pp 이하 ★ (개선), +2pp 이상 ▼ (악화)
 *  - direction='neutral': 태그 없이 숫자만
 */
function deltaCell(today, prev, thresholdPp = 2, direction = 'higherIsBetter') {
  if (today === null || prev === undefined || prev === null) return '—';
  const deltaPp = (today - prev) * 100;
  const sign = deltaPp >= 0 ? '+' : '';
  let tag = '';
  if (direction === 'higherIsBetter') {
    tag = deltaPp >= thresholdPp ? ' ★' : deltaPp <= -thresholdPp ? ' ▼' : '';
  } else if (direction === 'lowerIsBetter') {
    tag = deltaPp <= -thresholdPp ? ' ★' : deltaPp >= thresholdPp ? ' ▼' : '';
  }
  return `${sign}${deltaPp.toFixed(1)}pp${tag}`;
}

function renderReport(summary, trend, date, alerts) {
  const yesterday = trend.history.find((h) => h.date === daysBefore(date, 1));
  const rolling7 = trend.rolling?.['7day_avg'] || {};

  const lines = [];
  lines.push(`# voice-order 일일 측정 (${date})`);
  lines.push('');
  lines.push(`> 생성: \`scripts/nightly-report.mjs\``);
  lines.push(`> 입력: \`results/nightly-matrix/${date}/summary.json\``);
  lines.push('');

  // ── Regression alert (있으면 최상단) ──
  if (alerts.length > 0) {
    lines.push('## ⚠️ Regression Alert');
    lines.push('');
    for (const a of alerts) {
      lines.push(`- ${a.message}`);
    }
    lines.push('');
  }

  // ── R3 매트릭스 ──
  lines.push('## R3 매트릭스 (오늘 vs 어제 vs 7일 평균)');
  lines.push('');
  lines.push('| 차원 | 오늘 | 어제 | 7일 평균 | Δ (vs 어제) | Δ (vs 7일) |');
  lines.push('|---|---|---|---|---|---|');

  // 우선 정렬: 사용자 spec 순서 (있는 것만)
  const preferredOrder = [
    'normal_1-2_low',
    'normal_3_low',
    'normal_medium',
    'hard_1-2',
    'recommendation',
    'allergy',
  ];
  const presentKeys = new Set(Object.keys(summary.cells));
  const orderedKeys = [
    ...preferredOrder.filter((k) => presentKeys.has(k)),
    ...Object.keys(summary.cells)
      .filter((k) => !preferredOrder.includes(k))
      .sort(),
  ];

  for (const k of orderedKeys) {
    const cell = summary.cells[k];
    const today = cell.passRate;
    const yMetric = yesterday?.metrics?.[`${k}_passRate`];
    const rMetric = rolling7[`${k}_passRate`];

    lines.push(
      `| ${cell.label} | ${pct(today)} | ${pct(yMetric ?? null)} | ${pct(rMetric ?? null)} | ${deltaCell(
        today,
        yMetric,
      )} | ${deltaCell(today, rMetric)} |`,
    );
  }
  lines.push('');

  // ── 핵심 metric ──
  lines.push('## 핵심 metric');
  lines.push('');
  const overall = summary.overall || {};
  const allStaff = collectMetric(summary, 'staffMsgRate');
  const allQty = collectMetric(summary, 'qtyMismatchRate');
  const allStuck = collectMetric(summary, 'stuckRate');

  const staffOverall =
    typeof overall.staffMsgRate === 'number' ? overall.staffMsgRate : maxFinite(allStaff);
  const qtyOverall =
    typeof overall.qtyMismatchRate === 'number' ? overall.qtyMismatchRate : maxFinite(allQty);
  const stuckOverall =
    typeof overall.stuckRate === 'number' ? overall.stuckRate : maxFinite(allStuck);

  const yStaff = yesterday?.metrics?.overall_staffMsgRate ?? null;
  const yQty = yesterday?.metrics?.overall_qtyMismatchRate ?? null;
  const yStuck = yesterday?.metrics?.overall_stuckRate ?? null;

  lines.push(
    `- staff msg rate: ${pct(staffOverall)} (Δ ${deltaCell(staffOverall, yStaff, 0.5, 'lowerIsBetter')}) — 사용자 명시 우선순위 (목표 0%)`,
  );
  lines.push(
    `- qty mismatch: ${pct(qtyOverall)} (Δ ${deltaCell(qtyOverall, yQty, 0.5, 'lowerIsBetter')})`,
  );
  lines.push(
    `- stuck rate: ${pct(stuckOverall)} (Δ ${deltaCell(stuckOverall, yStuck, 0.5, 'lowerIsBetter')})`,
  );
  lines.push('');

  // ── Top failures ──
  const topFailures = [];
  for (const [k, cell] of Object.entries(summary.cells)) {
    if (Array.isArray(cell.topFailures)) {
      for (const f of cell.topFailures.slice(0, 3)) {
        topFailures.push({ cell: k, label: cell.label, ...f });
      }
    }
  }
  if (topFailures.length > 0) {
    lines.push('## Top failures (sample)');
    lines.push('');
    for (const f of topFailures.slice(0, 10)) {
      const utter = f.utterance || f.input || f.text || '?';
      const reason = f.reason || f.failureType || f.issue || '?';
      lines.push(`- [${f.cell}] \`${truncate(utter, 80)}\` — ${reason}`);
    }
    lines.push('');
  }

  // ── 추세 footer ──
  const histLen = trend.history.length;
  lines.push('---');
  lines.push('');
  lines.push(`추세 히스토리: ${histLen} 일 누적 / cap ${TREND_HISTORY_CAP}일.`);
  lines.push(`Δ 표기: passRate 매트릭스 = \`+2pp\` 이상 ★, \`-2pp\` 이하 ▼. 핵심 metric (staff/qty/stuck, 낮을수록 좋음) = \`-2pp\` 이하 ★, \`+2pp\` 이상 ▼.`);
  lines.push('');

  return lines.join('\n');
}

function truncate(s, n) {
  const str = String(s);
  if (str.length <= n) return str;
  return `${str.slice(0, n - 1)}…`;
}

function collectMetric(summary, key) {
  return Object.values(summary.cells)
    .map((c) => c[key])
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
}

function maxFinite(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => Math.max(a, b), -Infinity);
}

// ─── macOS osascript notification (best-effort) ────────────────────────
function notifyMac(alerts) {
  if (process.platform !== 'darwin') return;
  if (alerts.length === 0) return;
  const title = `voice-order nightly alert (${alerts.length})`;
  const body = alerts
    .slice(0, 3)
    .map((a) => a.message)
    .join('\n')
    .replace(/"/g, '\\"');
  try {
    execSync(
      `osascript -e 'display notification "${body}" with title "${title}"'`,
      { stdio: 'ignore', timeout: 5000 },
    );
  } catch {
    // notification 실패 무시 (cron 환경 등)
  }
}

// ─── main ──────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv);
  const date = args.date || todayKST();
  console.log(`[nightly-report] date=${date}`);

  const loaded = loadSummary(date, args.input);
  if (!loaded) {
    const expected = path.join(PATHS.matrixDir, date, 'summary.json');
    console.error(
      `[nightly-report] FATAL: summary not found.\n  expected: ${expected}\n  (Agent #1 — nightly-matrix-r3.sh 가 먼저 실행되어야 합니다)`,
    );
    process.exit(1);
  }
  console.log(`[nightly-report] loaded: ${loaded.path}`);

  const summary = normalize(loaded.data, date);
  if (!summary || Object.keys(summary.cells).length === 0) {
    console.error(
      `[nightly-report] FATAL: summary normalize failed (cells empty). raw shape: ${Object.keys(loaded.data).join(',')}`,
    );
    process.exit(1);
  }
  console.log(`[nightly-report] cells: ${Object.keys(summary.cells).length}`);

  // 추세 갱신
  const trend = loadTrend();
  const metrics = toMetricsRecord(summary);
  appendHistory(trend, date, metrics);
  refreshRolling(trend, date);

  // 회귀 alert
  const alerts = detectAlerts(summary, trend, date);
  console.log(`[nightly-report] alerts: ${alerts.length}`);

  // 보고서 렌더
  const md = renderReport(summary, trend, date, alerts);
  const outDir = args.output || PATHS.reportDir;
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, `NIGHTLY_${date}.md`);
  fs.writeFileSync(reportPath, md);
  console.log(`[nightly-report] report: ${reportPath} (${md.length} bytes)`);

  // trend 저장
  if (!args.dryRun) {
    fs.mkdirSync(PATHS.trendDir, { recursive: true });
    fs.writeFileSync(PATHS.trendFile, `${JSON.stringify(trend, null, 2)}\n`);
    console.log(`[nightly-report] trend: ${PATHS.trendFile} (${trend.history.length} records)`);
  } else {
    console.log(`[nightly-report] (dry-run) trend NOT saved`);
  }

  // alert 파일
  if (alerts.length > 0) {
    const alertLines = [
      `voice-order nightly alert — ${date} — ${alerts.length} issue(s)`,
      '',
      ...alerts.map((a) => `- ${a.message}`),
      '',
      `Report: ${reportPath}`,
    ];
    if (!args.dryRun) {
      fs.writeFileSync(PATHS.alertFile, `${alertLines.join('\n')}\n`);
      console.log(`[nightly-report] alert: ${PATHS.alertFile}`);
    } else {
      console.log(`[nightly-report] (dry-run) alert NOT written`);
    }
    if (args.notify) notifyMac(alerts);
    process.stderr.write(`${alertLines.join('\n')}\n`);
  } else {
    // 이전 alert 있으면 정리
    if (!args.dryRun && fs.existsSync(PATHS.alertFile)) {
      try {
        fs.unlinkSync(PATHS.alertFile);
        console.log(`[nightly-report] cleared previous alert`);
      } catch {
        /* ignore */
      }
    }
    console.log(`[nightly-report] OK — no regression`);
  }

  console.log(`[nightly-report] done.`);
}

main();
