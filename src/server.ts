import * as http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openDb, importCorpus, getCorpus, getSentenceRow, reviseCorpus } from "./db";
import { explainSubtree } from "./core/projectivity";
import { ConlluError, Token } from "./core/types";
import { RULE_VERSION } from "./core/conllu";

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, err: unknown) {
  if (err instanceof ConlluError) {
    const status =
      err.code === "NOT_FOUND" ? 404 : err.code.startsWith("TOO_") ? 413 : 400;
    sendJson(res, status, { error: { code: err.code, message: err.message, details: err.details } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function sentenceView(row: Record<string, unknown>) {
  return {
    idx: row.idx,
    status: row.status,
    raw: row.raw,
    comments: JSON.parse(row.comments as string),
    tokens: JSON.parse(row.tokens as string),
    diagnostics: JSON.parse(row.diagnostics as string),
    projectivity: row.projectivity ? JSON.parse(row.projectivity as string) : null,
  };
}

export function createServer(db: DatabaseSync = openDb()): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && parts.length === 0) {
        return sendJson(res, 200, { service: "conllu-verifier", ruleVersion: RULE_VERSION });
      }

      // POST /corpora  {name, text}
      if (method === "POST" && parts[0] === "corpora" && parts.length === 1) {
        const body = JSON.parse(await readBody(req));
        if (typeof body.name !== "string" || typeof body.text !== "string") {
          throw new ConlluError("BAD_REQUEST", "请求体需要 {name: string, text: string}");
        }
        const result = importCorpus(db, body.name, body.text);
        return sendJson(res, 201, result);
      }

      if (parts[0] === "corpora" && parts.length >= 2) {
        const corpusId = Number(parts[1]);
        if (!Number.isInteger(corpusId)) throw new ConlluError("BAD_REQUEST", "语料 ID 必须是整数");

        // GET /corpora
        if (method === "GET" && parts.length === 2 && parts[1] === undefined) {
          /* unreachable */
        }
        if (method === "GET" && parts.length === 2) {
          const corpus = getCorpus(db, corpusId);
          return sendJson(res, 200, corpus);
        }

        // POST /corpora/:id/versions {edits:[{sentence, heads:[...]}], name?}
        if (method === "POST" && parts[2] === "versions" && parts.length === 3) {
          const body = JSON.parse(await readBody(req));
          if (!Array.isArray(body.edits)) {
            throw new ConlluError("BAD_REQUEST", "请求体需要 {edits: [{sentence, heads}]}");
          }
          const result = reviseCorpus(db, corpusId, body.edits, body.name);
          return sendJson(res, 201, result);
        }

        // GET /corpora/:id/stats
        if (method === "GET" && parts[2] === "stats" && parts.length === 3) {
          getCorpus(db, corpusId);
          const rows = db
            .prepare("SELECT status, COUNT(*) AS n FROM sentences WHERE corpus_id = ? GROUP BY status")
            .all(corpusId) as unknown as { status: string; n: number }[];
          const stats: Record<string, number> = { invalid: 0, projective: 0, nonprojective: 0 };
          for (const r of rows) stats[r.status] = Number(r.n);
          return sendJson(res, 200, { corpusId, ruleVersion: RULE_VERSION, ...stats });
        }

        // GET /corpora/:id/export?format=conllu|json
        if (method === "GET" && parts[2] === "export" && parts.length === 3) {
          getCorpus(db, corpusId);
          const rows = db
            .prepare("SELECT * FROM sentences WHERE corpus_id = ? ORDER BY idx")
            .all(corpusId) as unknown as Record<string, unknown>[];
          const format = url.searchParams.get("format") ?? "conllu";
          if (format === "json") {
            return sendJson(res, 200, { corpusId, sentences: rows.map(sentenceView) });
          }
          const text = rows.map((r) => r.raw as string).join("\n\n") + "\n";
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          return res.end(text);
        }

        // GET /corpora/:id/sentences?status=...
        if (method === "GET" && parts[2] === "sentences" && parts.length === 3) {
          getCorpus(db, corpusId);
          const status = url.searchParams.get("status");
          const rows = (
            status
              ? db.prepare("SELECT idx, status FROM sentences WHERE corpus_id = ? AND status = ? ORDER BY idx").all(corpusId, status)
              : db.prepare("SELECT idx, status FROM sentences WHERE corpus_id = ? ORDER BY idx").all(corpusId)
          ) as unknown as { idx: number; status: string }[];
          return sendJson(res, 200, { corpusId, sentences: rows });
        }

        if (parts[2] === "sentences" && parts.length >= 4) {
          const idx = Number(parts[3]);
          if (!Number.isInteger(idx)) throw new ConlluError("BAD_REQUEST", "句子序号必须是整数");
          const row = getSentenceRow(db, corpusId, idx);
          const view = sentenceView(row);

          // GET /corpora/:id/sentences/:idx
          if (method === "GET" && parts.length === 4) {
            return sendJson(res, 200, view);
          }
          // GET .../diagnostics
          if (method === "GET" && parts[4] === "diagnostics") {
            return sendJson(res, 200, { corpusId, idx, status: view.status, diagnostics: view.diagnostics });
          }
          // GET .../projectivity
          if (method === "GET" && parts[4] === "projectivity") {
            if (!view.projectivity) {
              throw new ConlluError("INVALID_SENTENCE", `句子 ${idx} 结构不合法，无投射性报告`, {
                diagnostics: view.diagnostics,
              });
            }
            return sendJson(res, 200, { corpusId, idx, status: view.status, ...view.projectivity });
          }
          // GET .../subtree/:tokenId
          if (method === "GET" && parts[4] === "subtree" && parts.length === 6) {
            if (!view.projectivity) {
              throw new ConlluError("INVALID_SENTENCE", `句子 ${idx} 结构不合法，无法解释子树`);
            }
            const tokenId = Number(parts[5]);
            const info = explainSubtree(view.tokens as Token[], tokenId);
            if (!info) throw new ConlluError("NOT_FOUND", `token ${tokenId} 不存在`);
            return sendJson(res, 200, { corpusId, idx, ...info });
          }
        }
      }

      // GET /corpora （列表）
      if (method === "GET" && parts[0] === "corpora" && parts.length === 1) {
        const rows = db.prepare("SELECT * FROM corpora ORDER BY id").all();
        return sendJson(res, 200, { corpora: rows });
      }

      throw new ConlluError("NOT_FOUND", `未知路由: ${method} ${url.pathname}`);
    } catch (err) {
      sendError(res, err);
    }
  });
  return server;
}

export function startServer(port: number): Promise<{ server: http.Server; port: number }> {
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, port: actual });
    });
  });
}
