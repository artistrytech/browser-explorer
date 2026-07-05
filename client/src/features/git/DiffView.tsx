/** unified diff テキストを行単位で色付け表示する */
export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <div className="empty-hint">差分はありません</div>;
  const lines = diff.split('\n');
  return (
    <pre className="diff-view">
      {lines.map((line, i) => {
        let cls = '';
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
          cls = 'diff-meta';
        } else if (line.startsWith('@@')) {
          cls = 'diff-hunk';
        } else if (line.startsWith('+')) {
          cls = 'diff-add';
        } else if (line.startsWith('-')) {
          cls = 'diff-del';
        }
        return (
          <div key={i} className={`diff-line ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
