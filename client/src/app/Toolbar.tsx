import { useEffect, useRef, useState } from 'react';
import { useExplorer } from '../stores/explorer';
import { useUi } from '../stores/ui';
import { breadcrumbs, parentPath, isRootPath } from '../lib/paths';

export function Toolbar() {
  const { path, navigate, runSearch, searchQuery, clearSearch } = useExplorer();
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const [editing, setEditing] = useState(false);
  const [addressValue, setAddressValue] = useState(path);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAddressValue(path);
    if (!searchQuery) setSearch('');
  }, [path, searchQuery]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const submitAddress = () => {
    setEditing(false);
    const v = addressValue.trim().replace(/\\/g, '/');
    if (v && v !== path) void navigate(v);
  };

  return (
    <div className="toolbar">
      <button className="tool-btn" title="戻る (Alt+←)" onClick={() => history.back()}>
        ←
      </button>
      <button className="tool-btn" title="進む (Alt+→)" onClick={() => history.forward()}>
        →
      </button>
      <button
        className="tool-btn"
        title="上の階層へ (Alt+↑)"
        disabled={isRootPath(path)}
        onClick={() => void navigate(parentPath(path))}
      >
        ↑
      </button>

      <div className="address-bar" onClick={() => !editing && setEditing(true)}>
        {editing ? (
          <input
            ref={inputRef}
            className="address-input"
            value={addressValue}
            onChange={(e) => setAddressValue(e.target.value)}
            onBlur={submitAddress}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAddress();
              if (e.key === 'Escape') {
                setAddressValue(path);
                setEditing(false);
              }
            }}
          />
        ) : (
          <div className="breadcrumbs">
            {breadcrumbs(path).map((c, i, arr) => (
              <span key={c.path} className="crumb-wrap">
                <button
                  className="crumb"
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigate(c.path);
                  }}
                >
                  {c.name}
                </button>
                {i < arr.length - 1 && <span className="crumb-sep">›</span>}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="search-box">
        <input
          className="search-input"
          placeholder="🔍 名前で検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch(search.trim());
            if (e.key === 'Escape') {
              setSearch('');
              clearSearch();
            }
          }}
        />
        {searchQuery && (
          <button
            className="tool-btn"
            title="検索をクリア"
            onClick={() => {
              setSearch('');
              clearSearch();
            }}
          >
            ✕
          </button>
        )}
      </div>

      <button className="tool-btn" title="設定" onClick={() => setSettingsOpen(true)}>
        ⚙
      </button>
    </div>
  );
}
