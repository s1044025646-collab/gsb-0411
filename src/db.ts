/**
 * SQLite 持久化（Node 内置 node:sqlite，无原生依赖）。
 * 保存原文、规则版本、逐句状态与报告；修改 HEAD 生成新版本，旧报告不可变。
 */
import { DatabaseSync } from "node:sqlite";
import {
  RULE_VERSION,
  Sentence,
  StructureError,
  Token,
  parseCorpus,
  validateStructure,
} from "./conllu";
import { ProjectivityReport, checkProjectivity, explainSubtree } from "./projective";

export type SentenceStatus = "invalid" | "projective" | "non_projective";

export interface Limits {
  maxSentences: number;
  maxTokensPerSentence: number;
}

export const DEFAULT_LIMITS: Limits = { maxSentences: 10000, maxTokensPerSentence: 500 };

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS corpora (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sentences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      corpus_id INTEGER NOT NULL REFERENCES corpora(id),
      sent_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      comments TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      report_json TEXT,
      current_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tokens (
      sentence_id INTEGER NOT NULL REFERENCES sentences(id),
      revision INTEGER NOT NULL,
      id INTEGER NOT NULL,
      form TEXT NOT NULL, lemma TEXT NOT NULL, upos TEXT NOT NULL,
      xpos TEXT NOT NULL, feats TEXT NOT NULL,
      head INTEGER NOT NULL, deprel TEXT NOT NULL,
      deps TEXT NOT NULL, misc TEXT NOT NULL,
      PRIMARY KEY (sentence_id, revision, id)
    );
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sentence_id INTEGER NOT NULL REFERENCES sentences(id),
      revision INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      report_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export interface ImportResult {
  corpusId: number;
  ruleVersion: string;
  total: number;
  invalid: number;
  projective: number;
  nonProjective: number;
  errors: { sentenceIndex: number; error: StructureError }[];
}

export function importCorpus(
  db: DatabaseSync,
  name: string,
  text: string,
  limits: Limits = DEFAULT_LIMITS
): ImportResult {
  const { sentences, errors } = parseCorpus(text);
  if (sentences.length > limits.maxSentences) {
    throw Object.assign(
      new Error(`句子数 ${sentences.length} 超过上限 ${limits.maxSentences}`),
      { code: "LIMIT_EXCEEDED" as const }
    );
  }
  const errorByIndex = new Map(errors.map((e) => [e.sentenceIndex, e.error]));

  const corpusId = Number(
    db.prepare("INSERT INTO corpora (name, rule_version) VALUES (?, ?)")
      .run(name, RULE_VERSION).lastInsertRowid
  );
  const insSent = db.prepare(
    "INSERT INTO sentences (corpus_id, sent_index, text, comments, status, report_json) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insTok = db.prepare(
    `INSERT INTO tokens (sentence_id, revision, id, form, lemma, upos, xpos, feats, head, deprel, deps, misc)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insRev = db.prepare(
    "INSERT INTO revisions (sentence_id, revision, note, status, report_json) VALUES (?, 0, ?, ?, ?)"
  );

  let invalid = 0, projective = 0, nonProjective = 0;
  const allErrors: ImportResult["errors"] = [];

  sentences.forEach((sent, i) => {
    const parseErr = errorByIndex.get(i);
    let status: SentenceStatus;
    let report: ProjectivityReport | { structureErrors: StructureError[] } | null = null;
    let tokens: Token[] = sent.tokens;

    if (parseErr) {
      status = "invalid";
      report = { structureErrors: [parseErr] };
      allErrors.push({ sentenceIndex: i, error: parseErr });
      invalid++;
    } else if (tokens.length > limits.maxTokensPerSentence) {
      status = "invalid";
      const e: StructureError = {
        code: "LIMIT_EXCEEDED",
        message: `句子 ${i} token 数 ${tokens.length} 超过上限 ${limits.maxTokensPerSentence}`,
      };
      report = { structureErrors: [e] };
      allErrors.push({ sentenceIndex: i, error: e });
      invalid++;
      tokens = [];
    } else {
      const structErrors = validateStructure(tokens);
      if (structErrors.length > 0) {
        status = "invalid";
        report = { structureErrors: structErrors };
        for (const e of structErrors) allErrors.push({ sentenceIndex: i, error: e });
        invalid++;
      } else {
        const proj = checkProjectivity(tokens);
        status = proj.projective ? "projective" : "non_projective";
        report = proj;
        if (proj.projective) projective++; else nonProjective++;
      }
    }

    const sid = Number(
      insSent.run(corpusId, i, sent.text, JSON.stringify(sent.comments), status,
        report ? JSON.stringify(report) : null).lastInsertRowid
    );
    for (const t of tokens) {
      insTok.run(sid, t.id, t.form, t.lemma, t.upos, t.xpos, t.feats, t.head, t.deprel, t.deps, t.misc);
    }
    insRev.run(sid, "import", status, report ? JSON.stringify(report) : null);
  });

  return { corpusId, ruleVersion: RULE_VERSION, total: sentences.length, invalid, projective, nonProjective, errors: allErrors };
}

export function getTokens(db: DatabaseSync, sentenceId: number, revision?: number): Token[] {
  const rev = revision ?? currentRevision(db, sentenceId);
  const rows = db.prepare(
    `SELECT id, form, lemma, upos, xpos, feats, head, deprel, deps, misc
     FROM tokens WHERE sentence_id = ? AND revision = ? ORDER BY id`
  ).all(sentenceId, rev) as unknown as Omit<Token, "raw">[];
  return rows.map((r) => ({ ...r, raw: "" }));
}

export function currentRevision(db: DatabaseSync, sentenceId: number): number {
  const row = db.prepare("SELECT current_revision AS r FROM sentences WHERE id = ?").get(sentenceId) as { r: number } | undefined;
  if (!row) throw Object.assign(new Error(`句子 ${sentenceId} 不存在`), { code: "NOT_FOUND" });
  return row.r;
}

export function getSentence(db: DatabaseSync, sentenceId: number) {
  const row = db.prepare("SELECT * FROM sentences WHERE id = ?").get(sentenceId) as
    | { id: number; corpus_id: number; sent_index: number; text: string; comments: string; status: SentenceStatus; report_json: string | null; current_revision: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    corpusId: row.corpus_id,
    sentIndex: row.sent_index,
    text: row.text,
    comments: JSON.parse(row.comments) as string[],
    status: row.status,
    report: row.report_json ? JSON.parse(row.report_json) : null,
    currentRevision: row.current_revision,
    tokens: getTokens(db, sentenceId),
  };
}

export function listSentences(db: DatabaseSync, corpusId: number, status?: SentenceStatus) {
  const sql = status
    ? "SELECT id, sent_index, status, current_revision FROM sentences WHERE corpus_id = ? AND status = ? ORDER BY sent_index"
    : "SELECT id, sent_index, status, current_revision FROM sentences WHERE corpus_id = ? ORDER BY sent_index";
  const rows = (status
    ? db.prepare(sql).all(corpusId, status)
    : db.prepare(sql).all(corpusId)) as unknown as { id: number; sent_index: number; status: string; current_revision: number }[];
  return rows.map((r) => ({ id: r.id, sentIndex: r.sent_index, status: r.status, currentRevision: r.current_revision }));
}

export function listCorpora(db: DatabaseSync) {
  const rows = db.prepare("SELECT * FROM corpora ORDER BY id").all() as unknown as
    { id: number; name: string; rule_version: string; created_at: string }[];
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    ruleVersion: c.rule_version,
    createdAt: c.created_at,
    stats: stats(db, c.id),
  }));
}

export function stats(db: DatabaseSync, corpusId: number) {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM sentences WHERE corpus_id = ? GROUP BY status")
    .all(corpusId) as unknown as { status: string; n: number }[];
  const out = { total: 0, invalid: 0, projective: 0, non_projective: 0 };
  for (const r of rows) {
    out.total += r.n;
    if (r.status === "invalid") out.invalid = r.n;
    if (r.status === "projective") out.projective = r.n;
    if (r.status === "non_projective") out.non_projective = r.n;
  }
  return out;
}

/** 重新运行投射性核验并保存到当前修订的报告。 */
export function runProjectivity(db: DatabaseSync, sentenceId: number) {
  const sent = getSentence(db, sentenceId);
  if (!sent) throw Object.assign(new Error(`句子 ${sentenceId} 不存在`), { code: "NOT_FOUND" });
  if (sent.status === "invalid") {
    throw Object.assign(new Error(`句子 ${sentenceId} 结构不合法，不能运行投射性核验`), { code: "VALIDATION_ERROR" });
  }
  const report = checkProjectivity(sent.tokens);
  db.prepare("UPDATE sentences SET report_json = ? WHERE id = ?").run(JSON.stringify(report), sentenceId);
  db.prepare("UPDATE revisions SET report_json = ? WHERE sentence_id = ? AND revision = ?")
    .run(JSON.stringify(report), sentenceId, sent.currentRevision);
  return report;
}

export function explain(db: DatabaseSync, sentenceId: number, tokenId: number) {
  const sent = getSentence(db, sentenceId);
  if (!sent) throw Object.assign(new Error(`句子 ${sentenceId} 不存在`), { code: "NOT_FOUND" });
  if (sent.status === "invalid") {
    throw Object.assign(new Error(`句子 ${sentenceId} 结构不合法，无法解释子树`), { code: "VALIDATION_ERROR" });
  }
  const result = explainSubtree(sent.tokens, tokenId);
  if (!result) throw Object.assign(new Error(`token ${tokenId} 不存在于句子 ${sentenceId}`), { code: "NOT_FOUND" });
  return result;
}

/** 修改 HEAD：生成新修订版本，旧修订与旧报告保持不变。 */
export function setHead(db: DatabaseSync, sentenceId: number, tokenId: number, newHead: number, newDeprel?: string) {
  const sent = getSentence(db, sentenceId);
  if (!sent) throw Object.assign(new Error(`句子 ${sentenceId} 不存在`), { code: "NOT_FOUND" });
  const tokens = sent.tokens.map((t) => ({ ...t }));
  const tok = tokens.find((t) => t.id === tokenId);
  if (!tok) throw Object.assign(new Error(`token ${tokenId} 不存在`), { code: "NOT_FOUND" });
  if (!Number.isInteger(newHead) || newHead < 0) {
    throw Object.assign(new Error(`HEAD 必须是非负整数，收到 ${newHead}`), { code: "VALIDATION_ERROR" });
  }
  tok.head = newHead;
  if (newDeprel !== undefined) tok.deprel = newDeprel;
  if (newHead === 0 && newDeprel === undefined) tok.deprel = "root";

  const structErrors = validateStructure(tokens);
  let status: SentenceStatus;
  let report: unknown;
  if (structErrors.length > 0) {
    status = "invalid";
    report = { structureErrors: structErrors };
  } else {
    const proj = checkProjectivity(tokens);
    status = proj.projective ? "projective" : "non_projective";
    report = proj;
  }

  const newRev = sent.currentRevision + 1;
  const insTok = db.prepare(
    `INSERT INTO tokens (sentence_id, revision, id, form, lemma, upos, xpos, feats, head, deprel, deps, misc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const t of tokens) {
    insTok.run(sentenceId, newRev, t.id, t.form, t.lemma, t.upos, t.xpos, t.feats, t.head, t.deprel, t.deps, t.misc);
  }
  db.prepare("INSERT INTO revisions (sentence_id, revision, note, status, report_json) VALUES (?, ?, ?, ?, ?)")
    .run(sentenceId, newRev, `set-head token=${tokenId} head=${newHead}`, status, JSON.stringify(report));
  db.prepare("UPDATE sentences SET current_revision = ?, status = ?, report_json = ? WHERE id = ?")
    .run(newRev, status, JSON.stringify(report), sentenceId);
  return { sentenceId, revision: newRev, status, report };
}

export function listRevisions(db: DatabaseSync, sentenceId: number) {
  return db.prepare(
    "SELECT revision, note, status, report_json, created_at FROM revisions WHERE sentence_id = ? ORDER BY revision"
  ).all(sentenceId) as unknown as { revision: number; note: string; status: string; report_json: string | null; created_at: string }[];
}

/** 导出语料为 CoNLL-U 文本（当前修订），无效句导出原文。 */
export function exportCorpus(db: DatabaseSync, corpusId: number): string {
  const sents = db.prepare("SELECT id, text FROM sentences WHERE corpus_id = ? ORDER BY sent_index")
    .all(corpusId) as unknown as { id: number; text: string }[];
  const parts: string[] = [];
  for (const s of sents) {
    const tokens = getTokens(db, s.id);
    if (tokens.length === 0) {
      parts.push(s.text);
      continue;
    }
    const sent = getSentence(db, s.id)!;
    const lines: string[] = [...sent.comments];
    for (const t of tokens) {
      lines.push([t.id, t.form, t.lemma, t.upos, t.xpos, t.feats, t.head, t.deprel, t.deps, t.misc].join("\t"));
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n") + "\n";
}
