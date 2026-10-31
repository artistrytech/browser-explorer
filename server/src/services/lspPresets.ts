import { randomUUID } from 'node:crypto';

/**
 * コードマップ (参照元 / 参照先のマップ) に使う言語サーバ (LSP) の定義。
 * 設定 (lspServers) は設定画面で編集し、未設定のときはここのプリセットを使う。
 */

export interface LspServerDef {
  id: string;
  label: string;
  /** 対象の拡張子 (ドット無し・小文字) */
  extensions: string[];
  /** コマンド名 (PATH・プロジェクトの node_modules/.bin から探す) または絶対パス */
  command: string;
  /** 引数。${root} はプロジェクトのフォルダ、${dataDir} は言語サーバ用の作業フォルダに展開する */
  args: string[];
  /** プロジェクトのフォルダを決めるファイル (*.csproj のような拡張子の指定も可)。近い親から探す */
  rootMarkers: string[];
  enabled: boolean;
}

export interface LspPreset extends Omit<LspServerDef, 'enabled'> {
  /** インストール方法 (設定画面・見つからないときの案内に出す) */
  install: string;
}

export const LSP_PRESETS: LspPreset[] = [
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript (typescript-language-server)',
    extensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    install: 'npm install -g typescript-language-server typescript',
  },
  {
    id: 'python',
    label: 'Python (Pyright)',
    extensions: ['py', 'pyi'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    rootMarkers: ['pyrightconfig.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
    install: 'npm install -g pyright',
  },
  {
    id: 'java',
    label: 'Java (Eclipse JDT LS)',
    extensions: ['java'],
    command: 'jdtls',
    args: ['-data', '${dataDir}'],
    rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', '.project'],
    install: 'JDK 21 以降を入れ、Eclipse JDT LS を展開して bin/jdtls を PATH に通す (Mac は brew install jdtls)',
  },
  {
    id: 'csharp',
    label: 'C# (csharp-ls)',
    extensions: ['cs'],
    command: 'csharp-ls',
    args: [],
    rootMarkers: ['*.sln', '*.slnx', '*.csproj'],
    install: 'dotnet tool install --global csharp-ls',
  },
  {
    id: 'go',
    label: 'Go (gopls)',
    extensions: ['go'],
    command: 'gopls',
    args: [],
    rootMarkers: ['go.work', 'go.mod'],
    install: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'rust',
    label: 'Rust (rust-analyzer)',
    extensions: ['rs'],
    command: 'rust-analyzer',
    args: [],
    rootMarkers: ['Cargo.toml'],
    install: 'rustup component add rust-analyzer',
  },
  {
    id: 'clangd',
    label: 'C / C++ (clangd)',
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm'],
    command: 'clangd',
    args: [],
    rootMarkers: ['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt'],
    install: 'LLVM (clangd) を入れて PATH に通す。正確に解析するには compile_commands.json が必要',
  },
  {
    id: 'php',
    label: 'PHP (Intelephense)',
    extensions: ['php'],
    command: 'intelephense',
    args: ['--stdio'],
    rootMarkers: ['composer.json'],
    install: 'npm install -g intelephense',
  },
  {
    id: 'ruby',
    label: 'Ruby (Ruby LSP)',
    extensions: ['rb'],
    command: 'ruby-lsp',
    args: [],
    rootMarkers: ['Gemfile'],
    install: 'gem install ruby-lsp',
  },
  {
    id: 'kotlin',
    label: 'Kotlin (kotlin-language-server)',
    extensions: ['kt', 'kts'],
    command: 'kotlin-language-server',
    args: [],
    rootMarkers: ['settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle', 'pom.xml'],
    install: 'kotlin-language-server のリリースを展開して bin を PATH に通す (Mac は brew install kotlin-language-server)',
  },
  {
    id: 'swift',
    label: 'Swift (SourceKit-LSP)',
    extensions: ['swift'],
    command: 'sourcekit-lsp',
    args: [],
    rootMarkers: ['Package.swift'],
    install: 'Swift のツールチェーン (Xcode) に含まれる',
  },
  {
    id: 'dart',
    label: 'Dart / Flutter',
    extensions: ['dart'],
    command: 'dart',
    args: ['language-server'],
    rootMarkers: ['pubspec.yaml'],
    install: 'Dart SDK (Flutter SDK) を入れて PATH に通す',
  },
  {
    id: 'lua',
    label: 'Lua (lua-language-server)',
    extensions: ['lua'],
    command: 'lua-language-server',
    args: [],
    rootMarkers: ['.luarc.json', '.luarc.jsonc'],
    install: 'lua-language-server のリリースを展開して bin を PATH に通す',
  },
];

export function defaultLspServers(): LspServerDef[] {
  return LSP_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    extensions: [...p.extensions],
    command: p.command,
    args: [...p.args],
    rootMarkers: [...p.rootMarkers],
    enabled: true,
  }));
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : [];

/** 設定画面から受け取った定義を正規化する (コマンドの無いものは除く) */
export function sanitizeLspServer(raw: unknown): LspServerDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const command = typeof t.command === 'string' ? t.command.trim() : '';
  if (!command) return null;
  const label = typeof t.label === 'string' && t.label.trim() ? t.label.trim() : command;
  return {
    id: typeof t.id === 'string' && /^[\w.-]+$/.test(t.id) ? t.id : randomUUID(),
    label,
    extensions: [...new Set(strList(t.extensions).map((e) => e.replace(/^\.+/, '').toLowerCase()))],
    command,
    // 引数は空白を含んでもよい (1 要素 1 引数)。空文字だけは除く
    args: Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === 'string' && a.length > 0) : [],
    rootMarkers: strList(t.rootMarkers),
    enabled: t.enabled !== false,
  };
}
