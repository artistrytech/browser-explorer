/** '/' 区切りパスのユーティリティ (Windows は C:/... 形式) */

export function parentPath(p: string): string {
  if (p === '/' || /^[A-Za-z]:\/$/.test(p)) return p;
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return trimmed;
  const parent = trimmed.slice(0, idx);
  if (parent === '') return '/';
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}/`;
  return parent;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx < 0 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

export function isRootPath(p: string): boolean {
  return p === '/' || /^[A-Za-z]:\/$/.test(p);
}

/** パンくず用: パスを祖先パスの配列に分解する */
export function breadcrumbs(p: string): { name: string; path: string }[] {
  const parts: { name: string; path: string }[] = [];
  let current = p.replace(/\/+$/, '') || '/';
  while (true) {
    parts.unshift({ name: baseName(current) || current, path: isRootPath(current) || current.match(/^[A-Za-z]:$/) ? (current.endsWith('/') ? current : `${current}/`) : current });
    if (isRootPath(current) || !current.includes('/')) break;
    const parent = parentPath(current);
    if (parent === current) break;
    current = parent;
  }
  return parts;
}

export function formatSize(size: number, isDir: boolean): string {
  if (isDir) return '--';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const KIND_LABELS: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', json: 'JSON',
  md: 'Markdown', html: 'HTML', css: 'CSS', scss: 'SCSS', py: 'Python',
  rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', c: 'C', cpp: 'C++', h: 'Header',
  sh: 'Shell', yml: 'YAML', yaml: 'YAML', xml: 'XML', txt: 'テキスト',
  png: 'PNG 画像', jpg: 'JPEG 画像', jpeg: 'JPEG 画像', gif: 'GIF 画像', svg: 'SVG',
  pdf: 'PDF', zip: 'ZIP', csv: 'CSV', sql: 'SQL',
};

export function kindLabel(e: { type: string; ext: string }): string {
  if (e.type === 'dir') return 'フォルダ';
  if (e.type === 'symlink') return 'リンク';
  return KIND_LABELS[e.ext] ?? (e.ext ? `${e.ext.toUpperCase()} ファイル` : 'ファイル');
}

export function fileIcon(e: { type: string; ext: string }): string {
  if (e.type === 'dir') return '📁';
  if (e.type === 'symlink') return '🔗';
  const map: Record<string, string> = {
    ts: '🟦', tsx: '🟦', js: '🟨', jsx: '🟨', json: '🗂️', md: '📝',
    html: '🌐', css: '🎨', scss: '🎨', py: '🐍', png: '🖼️', jpg: '🖼️',
    jpeg: '🖼️', gif: '🖼️', svg: '🖼️', pdf: '📕', zip: '🗜️', csv: '📊',
    txt: '📄', sh: '⚙️', yml: '⚙️', yaml: '⚙️', sql: '🗄️',
  };
  return map[e.ext] ?? '📄';
}
