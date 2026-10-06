/** HTTP API（node:http，无外部依赖）。默认端口 0 = 自动选择空闲端口。 */
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_LIMITS,
  Limits,
  SentenceStatus,
  explain,
  exportCorpus,
  getSentence,
  importCorpus,
  listCorpora,
  listRevisions,
  listSentences,
  runProjectivity,
  setHead,
  stats,
} from "./db";

interface ApiError extends Error {
  code?: string;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendErr(res: http.ServerResponse, status: number, code: string, message: string) {
  send(res, status, { error: { code, message } });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function createServer(db: DatabaseSync, limits: Limits = DEFAULT_LIMITS) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const m = (re: RegExp) => path.match(re);

      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && path === "/corpora") {
        const body = JSON.parse(await readBody(req) || "{}");
        if (typeof body.name !== "string" || typeof body.text !== "string") {
          return sendErr(res, 400, "VALIDATION_ERROR", "请求体需包含 name 与 text 字符串字段");
        }
        const result = importCorpus(db, body.name, body.text, limits);
        return send(res, 201, result);
      }

      if (req.method === "GET" && path === "/corpora") {
        return send(res, 200, listCorpora(db));
      }

      let match: RegExpMatchArray | null;

      if (req.method === "GET" && (match = m(/^\/corpora\/(\d+)$/))) {
        const id = Number(match[1]);
        const list = listCorpora(db).find((c) => c.id === id);
        if (!list) return sendErr(res, 404, "NOT_FOUND", `语料 ${id} 不存在`);
        return send(res, 200, list);
      }

      if (req.method === "GET" && (match = m(/^\/corpora\/(\d+)\/sentences$/))) {
        const status = url.searchParams.get("status") as SentenceStatus | null;
        if (status && !["invalid", "projective", "non_projective"].includes(status)) {
          return sendErr(res, 400, "VALIDATION_ERROR", `非法 status 过滤值 "${status}"`);
        }
        return send(res, 200, listSentences(db, Number(match[1]), status ?? undefined));
      }

      if (req.method === "GET" && (match = m(/^\/corpora\/(\d+)\/stats$/))) {
        return send(res, 200, stats(db, Number(match[1])));
      }

      if (req.method === "GET" && (match = m(/^\/corpora\/(\d+)\/export$/))) {
        const text = exportCorpus(db, Number(match[1]));
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end(text);
      }

      if (req.method === "GET" && (match = m(/^\/sentences\/(\d+)$/))) {
        const sent = getSentence(db, Number(match[1]));
        if (!sent) return sendErr(res, 404, "NOT_FOUND", `句子 ${match[1]} 不存在`);
        return send(res, 200, sent);
      }

      if (req.method === "GET" && (match = m(/^\/sentences\/(\d+)\/diagnostics$/))) {
        const sent = getSentence(db, Number(match[1]));
        if (!sent) return sendErr(res, 404, "NOT_FOUND", `句子 ${match[1]} 不存在`);
        return send(res, 200, { id: sent.id, status: sent.status, report: sent.report });
      }

      if (req.method === "GET" && (match = m(/^\/sentences\/(\d+)\/revisions$/))) {
        return send(res, 200, listRevisions(db, Number(match[1])));
      }

      if (req.method === "POST" && (match = m(/^\/sentences\/(\d+)\/projectivity$/))) {
        return send(res, 200, runProjectivity(db, Number(match[1])));
      }

      if (req.method === "GET" && (match = m(/^\/sentences\/(\d+)\/projectivity$/))) {
        const sent = getSentence(db, Number(match[1]));
        if (!sent) return sendErr(res, 404, "NOT_FOUND", `句子 ${match[1]} 不存在`);
        if (sent.status === "invalid") {
          return sendErr(res, 422, "VALIDATION_ERROR", "句子结构不合法，无投射性报告");
        }
        return send(res, 200, sent.report);
      }

      if (req.method === "GET" && (match = m(/^\/sentences\/(\d+)\/subtree\/(\d+)$/))) {
        return send(res, 200, explain(db, Number(match[1]), Number(match[2])));
      }

      if (req.method === "POST" && (match = m(/^\/sentences\/(\d+)\/head$/))) {
        const body = JSON.parse(await readBody(req) || "{}");
        if (!Number.isInteger(body.tokenId) || !Number.isInteger(body.head)) {
          return sendErr(res, 400, "VALIDATION_ERROR", "请求体需包含整数 tokenId 与 head");
        }
        return send(res, 200, setHead(db, Number(match[1]), body.tokenId, body.head, body.deprel));
      }

      return sendErr(res, 404, "NOT_FOUND", `未知路由 ${req.method} ${path}`);
    } catch (e) {
      const err = e as ApiError;
      const code = err.code ?? "INTERNAL";
      const status =
        code === "NOT_FOUND" ? 404 :
        code === "LIMIT_EXCEEDED" ? 413 :
        code === "VALIDATION_ERROR" ? 422 :
        err instanceof SyntaxError ? 400 : 500;
      return sendErr(res, status, code, err.message);
    }
  });
  return server;
}

export function startServer(db: DatabaseSync, port: number, limits: Limits = DEFAULT_LIMITS): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = createServer(db, limits);
    server.listen(port, () => {
      resolve(server);
    });
  });
}

export function serverPort(server: http.Server): number {
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}
