/**
 * セッション ID: ブラウザのタブ単位の識別子。
 * 全 API リクエスト (x-session-id) と WS 接続 (?session=) に付けてサーバ側ログと紐づける。
 *
 * sessionStorage はタブごとに独立し、リロードしても残るので「タブ = セッション」になる
 * (タブの複製ではコピーされるため、複製元と同じ ID になる点は許容する)。
 * sessionStorage が使えない環境 (無効化等) ではメモリ上の ID にフォールバックする。
 */
const KEY = 'appSessionId';

function generate(): string {
  // 日時 (36 進) + 乱数。目視で区別しやすいよう短めにする
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${rand}`;
}

let cached: string | null = null;

export function getSessionId(): string {
  if (cached) return cached;
  try {
    const saved = sessionStorage.getItem(KEY);
    if (saved) {
      cached = saved;
      return saved;
    }
    const id = generate();
    sessionStorage.setItem(KEY, id);
    cached = id;
    return id;
  } catch {
    cached = generate();
    return cached;
  }
}
