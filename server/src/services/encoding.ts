import iconv from 'iconv-lite';
import jschardet from 'jschardet';

export type Eol = 'CRLF' | 'LF' | 'CR';

export interface DecodeResult {
  content: string;
  encoding: string;
  eol: Eol;
  bom: boolean;
}

/** jschardet の判定名を iconv-lite / UI 表示用の名前に正規化する */
function normalizeEncoding(name: string | null): string {
  if (!name) return 'UTF-8';
  const n = name.toUpperCase();
  if (n === 'ASCII' || n === 'UTF-8' || n === 'UTF8') return 'UTF-8';
  if (n === 'SHIFT_JIS' || n === 'SJIS' || n === 'WINDOWS-31J' || n === 'CP932') return 'Shift_JIS';
  if (n === 'EUC-JP') return 'EUC-JP';
  if (n === 'UTF-16LE') return 'UTF-16LE';
  if (n === 'UTF-16BE') return 'UTF-16BE';
  if (n === 'ISO-2022-JP') return 'ISO-2022-JP';
  // 誤判定しやすい欧文系は UTF-8 として扱う(日本語環境向けの安全側)
  if (n.startsWith('WINDOWS-125') || n.startsWith('ISO-8859')) return name;
  return name;
}

export function detectEol(text: string): Eol {
  if (/\r\n/.test(text)) return 'CRLF';
  if (/\r(?!\n)/.test(text)) return 'CR';
  return 'LF';
}

export function decodeBuffer(buf: Buffer, forcedEncoding?: string): DecodeResult {
  let encoding = forcedEncoding;
  let bom = false;

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true;
    if (!encoding) encoding = 'UTF-8';
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    bom = true;
    if (!encoding) encoding = 'UTF-16LE';
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    bom = true;
    if (!encoding) encoding = 'UTF-16BE';
  }

  if (!encoding) {
    const detected = jschardet.detect(buf);
    encoding = normalizeEncoding(detected?.encoding ?? null);
  }
  if (!iconv.encodingExists(encoding)) encoding = 'UTF-8';

  const content = iconv.decode(buf, encoding, { stripBOM: true });
  return { content, encoding, eol: detectEol(content), bom };
}

export function isProbablyBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function encodeContent(
  content: string,
  encoding: string,
  eol?: Eol,
  bom?: boolean,
): Buffer {
  let text = content;
  if (eol) {
    const nl = eol === 'CRLF' ? '\r\n' : eol === 'CR' ? '\r' : '\n';
    text = text.replace(/\r\n|\r|\n/g, nl);
  }
  const enc = iconv.encodingExists(encoding) ? encoding : 'UTF-8';
  return iconv.encode(text, enc, { addBOM: bom === true });
}
