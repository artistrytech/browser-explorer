import type { ChildProcess } from 'node:child_process';

/**
 * 言語サーバとの JSON-RPC 2.0 の接続 (標準入出力。各メッセージは Content-Length のヘッダ付き)。
 * こちらからの request / notify と、言語サーバからの request (workspace/configuration 等) への応答を扱う。
 */

export class LspError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

/** 言語サーバ側の都合で取り消された (解析中に状態が変わった等)。少し待てば成功することが多い */
export const LSP_CONTENT_MODIFIED = -32801;
export const LSP_REQUEST_CANCELLED = -32800;
const METHOD_NOT_FOUND = -32601;

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspConnection {
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  /** 標準エラー出力の末尾 (起動に失敗したときの説明に使う) */
  stderr = '';

  constructor(
    private child: ChildProcess,
    private handlers: {
      onRequest: (method: string, params: unknown) => unknown;
      onNotification: (method: string, params: unknown) => void;
      onClose: (code: number | null) => void;
    },
  ) {
    child.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => {
      this.stderr = (this.stderr + c).slice(-8000);
    });
    child.stdin!.on('error', () => {});
    child.on('error', (e) => this.close(null, e.message));
    child.on('close', (code) => this.close(code));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('言語サーバは終了しています'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify('$/cancelRequest', { id });
        reject(new Error(`言語サーバの応答がありません (${method}, ${Math.round(timeoutMs / 1000)} 秒)`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // ヘッダが壊れている: そこまでを捨てて続ける
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString('utf8');
      this.buf = this.buf.subarray(start + len);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.method === 'string') {
      // 言語サーバからの request
      const id = msg.id;
      Promise.resolve()
        .then(() => this.handlers.onRequest(msg.method as string, msg.params))
        .then(
          (result) => this.send({ jsonrpc: '2.0', id, result: result ?? null }),
          (e: unknown) =>
            this.send({
              jsonrpc: '2.0',
              id,
              error: {
                code: e instanceof LspError ? e.code : METHOD_NOT_FOUND,
                message: e instanceof Error ? e.message : String(e),
              },
            }),
        );
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      const err = msg.error as { code?: number; message?: string } | undefined;
      if (err) p.reject(new LspError(err.code ?? 0, err.message || `${p.method} が失敗しました`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') this.handlers.onNotification(msg.method, msg.params);
  }

  private close(code: number | null, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason ? `言語サーバを起動できません: ${reason}` : '言語サーバが終了しました'));
    }
    this.pending.clear();
    this.handlers.onClose(code);
  }
}
