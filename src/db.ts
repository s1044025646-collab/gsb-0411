import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseCorpus, validateSentence, RULE_VERSION } from "./core/conllu";
import { checkProjectivity } from "./core/projectivity";
import { ConlluError, SentenceStatus } from "./core/types";

export const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
export const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "conllu.db");

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS corpora (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      parent_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sentences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      corpus_id INTEGER NOT NULL REFERENCES corpora(id),
      idx INTEGER NOT NULL,
      raw TEXT NOT NULL,
      comments TEXT NOT NULL,
      tokens TEXT NOT NULL,
      status TEXT NOT NULL,
      diagnostics TEXT NOT NULL,
      projectivity TEXT,
      UNIQUE(corpus_id, idx)
    );
  `);
  return db;
}

export interface ImportResult {
  corpusId: number;
  total: number;
  invalid: number;
  projective: number;
  nonprojective: number;
}

export function importCorpus(
  db: DatabaseSync,
  name: string,
  text: string,
  parentId: number | null = null
): ImportResult {
  const sentences = parseCorpus(text);
  const info = db
    .prepare("INSERT INTO corpora (name, rule_version, parent_id) VALUES (?, ?, ?)")
    .run(name, RULE_VERSION, parentId);
  const corpusId = Number(info.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO sentences (corpus_id, idx, raw, comments, tokens, status, diagnostics, projectivity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let invalid = 0, projective = 0, nonprojective = 0;
  for (const s of sentences) {
    const diags = validateSentence(s);
    let status: SentenceStatus;
    let proj: string | null = null;
    if (diags.length > 0) {
      status = "invalid";
      invalid++;
    } else {
      const report = checkProjectivity(s.tokens);
      proj = JSON.stringify(report);
      if (report.projective) {
        status = "projective";
        projective++;
      } else {
        status = "nonprojective";
        nonprojective++;
      }
    }
    insert.run(
      corpusId,
      s.index,
      s.raw,
      JSON.stringify(s.comments),
      JSON.stringify(s.tokens),
      status,
      JSON.stringify(diags),
      proj
    );
  }
  return { corpusId, total: sentences.length, invalid, projective, nonprojective };
}

export function getCorpus(db: DatabaseSync, id: number) {
  const row = db.prepare("SELECT * FROM corpora WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new ConlluError("NOT_FOUND", `语料版本 ${id} 不存在`, { corpusId: id });
  return row;
}

export function getSentenceRow(db: DatabaseSync, corpusId: number, idx: number) {
  const row = db
    .prepare("SELECT * FROM sentences WHERE corpus_id = ? AND idx = ?")
    .get(corpusId, idx) as Record<string, unknown> | undefined;
  if (!row)
    throw new ConlluError("NOT_FOUND", `语料 ${corpusId} 中句子 ${idx} 不存在`, {
      corpusId,
      idx,
    });
  return row;
}

/** 修改 HEAD 创建新版本；旧版本与旧报告保持不变。 */
export function reviseCorpus(
  db: DatabaseSync,
  corpusId: number,
  edits: { sentence: number; heads: number[] }[],
  name?: string
): ImportResult {
  const parent = getCorpus(db, corpusId);
  const rows = db
    .prepare("SELECT * FROM sentences WHERE corpus_id = ? ORDER BY idx")
    .all(corpusId) as unknown as { idx: number; raw: string }[];
  const editMap = new Map(edits.map((e) => [e.sentence, e.heads]));
  const blocks: string[] = [];
  for (const row of rows) {
    const heads = editMap.get(row.idx);
    if (!heads) {
      blocks.push(row.raw);
      continue;
    }
    const lines = row.raw.split("\n");
    const tokenLines = lines.filter((l) => !l.startsWith("#"));
    if (heads.length !== tokenLines.length) {
      throw new ConlluError(
        "BAD_REQUEST",
        `句子 ${row.idx}: 提供 ${heads.length} 个 HEAD，但句子有 ${tokenLines.length} 个 token`,
        { sentence: row.idx }
      );
    }
    let ti = 0;
    const newLines = lines.map((l) => {
      if (l.startsWith("#")) return l;
      const fields = l.split("\t");
      fields[6] = String(heads[ti++]);
      return fields.join("\t");
    });
    blocks.push(newLines.join("\n"));
  }
  const newName = name ?? `${parent.name as string} (rev of v${corpusId})`;
  return importCorpus(db, newName, blocks.join("\n\n"), corpusId);
}
