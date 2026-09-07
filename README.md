# vibeboard

バイブコーディング（AI 駆動開発）に最適化された、ローカル開発用のタスク・プラン管理画面。

`Claude Code` / `Cursor` などの AI エージェントと並走するワークフロー
（プランを書く → TODO に積む → 実装 → DONE に移動 → プランをアーカイブ）を
1 つの画面でこなせるようにする、プロジェクト直下で起動する小さな Express サーバ。

```
┌──────────────────────────────────────────────────────────────┐
│ <project>             Root  Plans  Specs  Files              │
├──────────────┬───────────────────────────────────────────────┤
│ 更新日 名前   + 新規 │ # TODO                                 │
│ docs/plans/  │                                               │
│  ├ foo.md    │ ## 機能開発                                    │
│  └ bar.md    │ - [ ] xxx                                     │
│ TODO.md      │ - [x] yyy → DONE                              │
│ DONE.md      │                                               │
└──────────────┴───────────────────────────────────────────────┘
```

## できること

- `docs/plans/` ・ `docs/specs/` 配下の Markdown / HTML をツリーで一覧・閲覧・編集
- ルート直下の `TODO.md` ・ `DONE.md` ・ `CLAUDE.md` ・ `README.md` をプレビュー表示しつつ編集
- **タスク（`- [ ]`）を含む Markdown は「ツリー」で表示**（`ツリー` / `プレビュー` / `編集` の 3 サブタブ）
  - 字下げを親子として描き、子を持つタスクは畳める。見出しと親には `完了 / 全体` の数
  - 状態は `[ ]` 未着手 / `[x]` 完了 / `[~]` 進行中 / `[-]` 中止。他の 1 文字は未着手扱いで記号を残す
  - タスクの下に字下げした `依存:` / `派生元:` / `関連:` の行を**関係**として読み、チップで両方向に辿れる
    （相手のタスクは `「文面」`、プラン / 仕様は Markdown リンク）。引けない相手は「見つかりません」と出すだけで本文は消えない
  - 本文の `[plan](docs/plans/x.md)` のような相対リンクは、Root タブからでも vibeboard の中で開く
  - `TODO.md` の書式は変えない（id を書かせない）。解釈はサーバの純関数 `src/todo.ts`（`GET /api/todo/<path>`）
- **Files タブでプロジェクト内のファイルをすべて編集**（テキストエディタと同じ扱い）
  - 拡張子もディレクトリも問わない。`src/` のコードも `package.json` も同じ画面で開ける
  - **dotfile も出す**（`.env` を含む）。除外は既定で `.git/` と `node_modules/` だけ
    （`files.exclude` で足せる）
  - バイナリ / サイズ上限（1MB）超え / シンボリックリンクは**開けるが読み取り専用**
  - **改行コードを変えない**。`textarea` は値を LF に潰すので、読み取り時に判定して
    書き戻しで CRLF へ復元する（変えると差分が全行になるため）
- 新規作成 / リネーム・移動 / 削除（サイドバーの `+ 新規`、ツールバーの `リネーム` `削除`）
  - 対象はファイル 1 個だけ。ディレクトリは作成時に親を掘るだけで、移動・削除はしない
  - 移動先が既にある場合は**上書きせず 409**。作成も同名があれば 409
- 編集はすべて mtime ベースの楽観ロック付き。外部で先に更新されていた場合は 409 を返し、
  リロード / 手元維持 / 強制上書き を選べる
  - 保存は tmp へ書いてから rename（アトミック書き込み）
  - `fs.watch` + 2 秒ポーリングで**今開いているファイル**の外部変更を検知し、SSE で即時反映
    （プレビュー自動更新／clean 編集は差し替え＋情報バー／dirty 編集は競合警告バー＋差分モーダル）
- `docs/plans/<file>` ・ `docs/plans/<dir>/` を `docs/plans/archive/` に移動
- ツールバーの `↻ 再取得` ボタン、または `R` キー単独で手動再取得
- 起動時、同じ `--root` の vibeboard が既にポートを使っていれば自動で停止して起動し直す
  （別プロジェクトの vibeboard や無関係なプロセスには触れない）

> **注意**: Files タブは `--root` 配下のファイルを **`.env` まで含めて読み書きできる**。
> vibeboard が `127.0.0.1` バインド固定なのはこのためで、外から届く場所には置かないこと。

## 必要な前提構造

vibeboard は親プロジェクトに以下があることを前提に動く。

```
<project-root>/
├── run-vibeboard.sh           # 起動スクリプト (npm install が vibeboard/ から自動配置)
├── vibeboard/                 # degit で vendor した vibeboard 本体
├── TODO.md                    # 必須: 現在のタスク
├── DONE.md                    # 必須: 完了したタスク
├── CLAUDE.md                  # 任意: AI エージェント向け規約 (vibeboard init で生成・更新)
└── docs/
    ├── plans/                 # プランの置き場
    │   ├── archive/           # 完了したプランの退避先
    │   └── <task-name>.md
    └── specs/                 # 仕様書の置き場 (任意)
        └── ...
```

足りないファイル / ディレクトリは、必要になった時点で自動的に作成される
（例: アーカイブ操作時の `docs/plans/archive/`、新規作成時の親ディレクトリ）。
`docs/specs/` は無くても起動できる。

Files タブはこの構造に依存せず、`--root` 配下を（除外を除いて）そのまま並べる。

## Quick start

vibeboard は **degit でプロジェクト直下に vendor して使う**（npm レジストリには公開していない）。
**常にプロジェクト固有のカスタマイズを入れる前提**のツールなので、サブディレクトリとして
取り込んで自由に手を加えられる形にしている。npx 単発実行や Git submodule での運用はサポートしない。

```bash
# プロジェクト直下で実行
npx -y degit akiraak/vibeboard vibeboard   # 既存 vibeboard/ がある場合は事前に削除
cd vibeboard
npm install                                # prepare で dist/ を生成し、
                                           # postinstall で run-vibeboard.sh を親へ配置

# 起動 (プロジェクトルートから)
cd ..
./run-vibeboard.sh
# → http://localhost:3010 を開く
```

`npm install` の postinstall が `vibeboard/run-vibeboard.sh` を**プロジェクトルート直下へ
インストールする**ので、以降は日常的に使うルートから `./run-vibeboard.sh` で起動できる。
`vibeboard/` 内から `./run-vibeboard.sh` を叩いても同じように動く（どちらの配置でも
既定の管理対象は親プロジェクト）。

`run-vibeboard.sh` は初回起動時に `npm install` を実行し、`dist/cli.js` が無い場合や
TypeScript ソースが更新されている場合は自動的にビルドする。任意の CLI 引数もそのまま渡せる。

```bash
./run-vibeboard.sh --port 3011
```

`--root` 引数または `VIBEBOARD_ROOT` 環境変数を指定した場合は、そちらを優先する。

### 起動スクリプトの自動配置について

postinstall は以下の場合はスキップする（無関係なディレクトリを散らかさないため）。

- `VIBEBOARD_SKIP_LAUNCHER` が設定されている
- `vibeboard/.git` がある（vibeboard 本体の開発クローン。degit 経由なら `.git` は剥がれている）
- 親に `.git` / `package.json` / `CLAUDE.md` / `TODO.md` / `DONE.md` / `docs` のいずれも無い

既にルートへ配置済みで内容が同じなら何もしない。異なる場合は上書きするので、
ローカル改変していたなら親リポジトリの `git diff` で確認すること。

ガードを無視して手動で配置し直したいときは次を実行する。

```bash
cd vibeboard && npm run install-launcher
```

親プロジェクト側の `.gitignore` には `vibeboard/dist/` と `vibeboard/node_modules/` を追加し、
それ以外（`vibeboard/src/` など）は親リポジトリの git 管理対象に含める。
プロジェクト固有のカスタマイズ差分はそのまま親リポジトリにコミットする運用。

バージョンを固定したい場合は `#<tag>` または `#<commit-sha>` を付ける。

```bash
npx -y degit akiraak/vibeboard#v0.1.0 vibeboard
npx -y degit akiraak/vibeboard#abc1234 vibeboard
```

### upstream の取り込み直し

vibeboard 本体に改善が入ったら、再 degit で上書き取り込みして、ローカルカスタマイズ差分を
手作業でマージし直す運用になる（degit には `.git` が無いので、カスタマイズ差分は
親リポジトリの git 履歴から拾う）。

```bash
rm -rf vibeboard
npx -y degit akiraak/vibeboard vibeboard
cd vibeboard && npm install   # ルートの run-vibeboard.sh も postinstall で更新される
# 親リポジトリの git diff で残っていたローカル改変を確認しつつ、必要分を再適用
```

## サンプルで試す

vendor 取り込み後、同梱の `sample/` ディレクトリに対して起動するとそのまま動かせる。

```bash
npx -y degit akiraak/vibeboard vibeboard-trial
cd vibeboard-trial
npm install
npm run sample
# → http://localhost:3010
```

`sample/` には以下が入っている。

- `TODO.md` / `DONE.md`（編集対象ファイルの見本）
- `docs/plans/`（`feature-x.md`、`feature-y.md`、サブディレクトリ `refactor/` の Step ファイル）
- `docs/specs/`（`api.md`、`mermaid` 入りの `ui-flow.md`）
- `vibeboard.config.json`（タブのラベルを日本語化したカスタム設定例）

`npm run sample:dev` だと ts-node で起動するのでビルド不要。
任意の別プロジェクトを開きたい場合は `node dist/cli.js --root /path/to/project` で `--root` を直接渡す。

## CLAUDE.md にスニペットを書く

`CLAUDE.md` に AI エージェント向けの規約を入れたいときは、初回だけ `init` を流す。
vendor 済みの `vibeboard/` から、親プロジェクトを `--root` に指定して実行する。

```bash
node vibeboard/dist/cli.js init --root .            # 親プロジェクトの CLAUDE.md にスニペットを追記
node vibeboard/dist/cli.js init --root . --dry-run  # 書き込まずに変更後の内容をプレビュー
```

`init` は `<!-- vibeboard:begin -->` ～ `<!-- vibeboard:end -->` のマーカーで囲って
書き込むので、何度流しても多重追記にはならない（マーカー内が最新スニペットに置換される）。

## CLI 引数

vendor 済みの `vibeboard/` 内で `node dist/cli.js ...` として呼び出す（あるいは
`npm start -- ...` でも可）。以降、コマンド表記は `vibeboard` と省略する。

```
vibeboard [options]              管理画面サーバを起動
vibeboard init [options]         親プロジェクトの CLAUDE.md にスニペットを追記
```

サーバ起動オプション:

| オプション         | 説明                                                                 | デフォルト                              |
| ------------------ | -------------------------------------------------------------------- | --------------------------------------- |
| `--root <path>`    | 対象プロジェクトのルート                                             | `process.cwd()`                         |
| `--port <n>`       | バインドするポート                                                   | `3010`                                  |
| `--title <s>`      | UI のブランド名                                                      | `<root>/package.json` の `name`、無ければディレクトリ名 |
| `--config <path>`  | 設定ファイル                                                         | `<root>/vibeboard.config.json` (あれば自動読込) |
| `--help`, `-h`     | ヘルプを表示                                                         |                                         |
| `--version`, `-v`  | バージョンを表示                                                     |                                         |

`init` オプション:

| オプション         | 説明                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `--root <path>`    | 親プロジェクトのルート (デフォルト: `cwd` / `VIBEBOARD_ROOT`)        |
| `--dry-run`        | 書き込まずに、書き込まれる内容をプレビュー表示                       |
| `--help`, `-h`     | `init` のヘルプを表示                                                |

## 環境変数

| 変数名             | 説明                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `VIBEBOARD_ROOT`   | `--root` と同等                                                      |
| `VIBEBOARD_PORT`   | `--port` と同等（後方互換で `DEV_ADMIN_PORT` も読む）                |
| `VIBEBOARD_TITLE`  | `--title` と同等                                                     |
| `VIBEBOARD_SKIP_LAUNCHER` | 設定すると `npm install` 時に `run-vibeboard.sh` をプロジェクトルートへ配置しない |

優先順位は `CLI 引数 > 環境変数 > デフォルト`。

## 設定ファイル

`<root>/vibeboard.config.json` を置くと、UI のタブ・カテゴリ・編集対象ファイルを
プロジェクトごとにカスタマイズできる。`--config <path>` で別パスを指定することも可能。
ファイルが無ければデフォルト（`plans` / `specs` / `TODO.md` / `DONE.md` / `CLAUDE.md` / `README.md`）で起動する。

### スキーマ

```jsonc
{
  // UI のブランド名 (--title / VIBEBOARD_TITLE と同等。CLI/環境変数の方が優先される)
  "title": "my-project",

  // バインドするポート (--port / VIBEBOARD_PORT と同等)
  "port": 3010,

  // ドキュメントカテゴリ。配列順がタブ表示順になる。
  // 省略時は [plans (archive: true), specs (archive: false)]
  "categories": [
    {
      "name": "plans",       // 必須。URL/ハッシュに使うスラッグ。'todo' は予約語、ユニーク
      "label": "Plans",      // タブの表示名。省略時は name
      "path": "docs/plans",  // root からの相対パス（または絶対パス）。省略時は `docs/<name>`
      "archive": true        // true で archive ボタンと /archive エンドポイントが有効化される
    },
    { "name": "specs", "label": "Specs", "path": "docs/specs" }
  ],

  // 編集対象（Root）タブ。タブのスラッグは固定で 'todo'
  // 省略時は { label: 'Root', files: [TODO.md, DONE.md, CLAUDE.md, README.md] }
  "editable": {
    "label": "Root",
    "files": [
      // 文字列だけならファイル名そのまま。オブジェクトで label / path をカスタムできる
      "TODO.md",
      { "name": "DONE.md", "label": "DONE", "path": "DONE.md" },
      "CLAUDE.md",
      "README.md"
    ]
  },

  // Files タブ（プロジェクト内の全ファイル）。省略時は { label: 'Files', exclude: ['.git', 'node_modules'] }
  "files": {
    "label": "Files",                      // タブの表示名
    // ツリーから外す**ディレクトリ / ファイル名**。パス区切りやグロブは受けない
    // （パスのどこかのセグメントが一致したら除外）。指定すると既定を置き換える
    "exclude": [".git", "node_modules", "dist"]
  },

  // 外部 HTTP プラグインを iframe タブとして差し込む（省略時は無し）。
  // 各エントリは別プロセスのプラグインを指し、vibeboard は中身をプロキシせず
  // baseUrl をクライアントへ渡してブラウザが直接 fetch する（loopback / CORS 前提）。
  // 契約は後述の「customTabs（プラグインタブ）」を参照。topbar では他タブの左側に並ぶ。
  "customTabs": [
    {
      "name": "sample",                   // 必須。URL/ハッシュのスラッグ。英数と '-'。他タブと衝突不可
      "label": "Sample",                  // タブ表示名。省略時は name
      "baseUrl": "http://127.0.0.1:8181", // 必須。プラグインの http/https ベース URL（末尾 / は正規化で除去）
      // 任意。タブの中身を出すプロセスの起動コマンド。vibeboard が一緒に起こして一緒に止める。
      // **配列でだけ受ける**（shell を通さない）。cwd は --root。
      // 既に baseUrl が応えるなら起動しない
      "command": ["node", "tools/sample/server.js"]
    }
  ]
}
```

### カスタム例

```json
{
  "title": "my-research",
  "categories": [
    { "name": "notes",   "label": "Notes",   "path": "notes",          "archive": true },
    { "name": "papers",  "label": "Papers",  "path": "references"      },
    { "name": "designs", "label": "Designs", "path": "docs/designs"    }
  ],
  "editable": {
    "label": "Inbox",
    "files": [
      { "name": "INBOX.md",   "label": "Inbox" },
      { "name": "ARCHIVE.md", "label": "Archive" }
    ]
  }
}
```

### バリデーション

設定ファイル読み込み時に以下を弾く（起動失敗）。

- `categories[].name` が空 / 重複 / `todo`・`files`（予約語） / パス区切り文字を含む
- `categories[].path` が root の外を指している
- `editable.files[].name` が `.md` で終わらない / 重複 / パス区切り文字を含む
- `editable.files[].path` が root の外を指している
- `categories` または `editable.files` を空配列にしている（省略してデフォルトに戻す）
- `files.exclude` が配列でない / 要素が空文字 / パス区切り文字（`/` `\\`）や `.` `..` を含む
- `customTabs[].name` が空 / 英数と `-` 以外を含む / 他タブ（`todo`・`files`・categories）と衝突 / 重複
- `customTabs[].baseUrl` が空 / URL として不正 / `http`・`https` 以外 / `?` や `#` を含む
- `customTabs[].command` が文字列 / 配列でない / 空配列 / 要素が空文字

優先順位は `CLI 引数 > 環境変数 > vibeboard.config.json > デフォルト`。

## customTabs（プラグインタブ）

`customTabs` を設定すると、外部の HTTP プラグインを vibeboard の iframe タブとして差し込める。
vibeboard はプラグインの中身をプロキシせず、`baseUrl` をクライアントへ渡してブラウザが直接
fetch / SSE する（loopback + CORS 前提）。サンプル実装は [`sample-custom-tab/`](sample-custom-tab/) を参照。

### プラグインが実装する 3 エンドポイント

| エンドポイント | 役割 |
|---|---|
| `GET /api/sidebar` | `{ "items": [...] }` を返す。左サイドバーの項目一覧 |
| `GET /view?item=<id>` | item に対応する HTML を返す。右ペインの iframe に表示される |
| `GET /api/watch` | SSE。`item-changed` / `sidebar` イベントで iframe・サイドバーを自動更新 |

プラグインのプロセスは `customTabs[].command` を書いておけば vibeboard が一緒に起こす
（下記「プラグインを一緒に起動する」）。

すべて CORS を許可すること（`Access-Control-Allow-Origin`）。`/view` の HTML は iframe 埋め込みのため
`Content-Security-Policy: frame-ancestors http://127.0.0.1:*`（または vibeboard のオリジン）を返す。

### サイドバー項目スキーマ（`/api/sidebar` の `items[]`）

```jsonc
{
  "id":    "overview",      // 必須。/view?item= とハッシュ #<tab>/<id> に使う
  "label": "Overview",      // 必須。表示名
  "sub":   "サブ情報",       // 任意。ラベル下の小さな補助テキスト
  "group": "dashboard",     // 任意。連続する同 group は見出しでまとめられる
  "badge": "●"              // 任意。右端のバッジ
}
```

### SSE イベント（`/api/watch`）

- `event: item-changed` / `data: { "id": "<itemId>", "reload": true }`
  表示中 item がこの id なら iframe を再ロードする。`"reload": false` を付けると親は iframe に触れず、
  プラグインが iframe 内の inline script で自前更新する想定（ちらつき・スクロール位置リセットを避けたい場合）。
  `reload` 省略時は `true` 扱い。
- `event: sidebar` — サイドバーを再フェッチして描き直す。

### プラグインを一緒に起動する（`command`）

customTab の中身はブラウザが `baseUrl` へ直接つなぐ別プロセスなので、それが起動して
いないとタブは「接続できません: Failed to fetch」で終わる。起動を人の手に任せると
**本体は動いているのにタブだけ死んでいる**が普通に起きるので、タブの宣言と同じ場所に
起動コマンドを書ける。

```jsonc
{ "name": "tasks", "baseUrl": "http://127.0.0.1:3012",
  "command": ["node", "tools/vibeboard-tasks/server.js", "--root", "."] }
```

```
$ ./run-vibeboard.sh
[vibeboard] running at http://127.0.0.1:3010
[vibeboard] customTab tasks: node tools/vibeboard-tasks/server.js --root . (pid: 12345)
[tasks] listening on http://127.0.0.1:3012
```

- **shell を通さない**。文字列 1 本ではなく配列で書く（設定ファイルがそのままシェルの文になるのを避ける）
- cwd は `--root`。標準出力は `[<name>] ` を付けて本体のログに混ぜる
- 起動前に `baseUrl` を叩き、**応えるものが居れば起動しない**（自分で立ち上げてある場合や、
  前回の残りを二重に起こさないため）。この判定のぶん、起動が最大 1 秒ほど遅くなることがある
- vibeboard を止めると一緒に止まる。**自分で起こしていないプロセスは道連れにしない**
- コマンドが落ちても本体は動き続ける（ログに終了コードを出す）

### 挙動

- **並び順**: customTabs は topbar で他タブ（Root / categories）の**左側**に、配列順で並ぶ。
- **自動選択**: item を指定せずタブを開くと、サイドバー先頭の項目へ自動遷移する（空ペインを避ける）。
- **iframe からの遷移**: iframe 内から親の別 item へ移りたいときは
  `parent.postMessage({ type: 'vb-nav', hash: '<tab>/<id>' }, '*')` を送ると vibeboard がハッシュを書き換える。

## 親プロジェクトの `CLAUDE.md` に追記すべきスニペット

`node vibeboard/dist/cli.js init --root .` が下記をマーカー付きで `CLAUDE.md` に書き込む。手で貼り付けるなら
このまま末尾にコピーすれば良い（マーカーごと貼ること。`init` で再上書きできなくなる）。

````markdown
<!-- vibeboard:begin -->
## 開発管理画面 (vibeboard)

ローカル開発時のタスク・プラン管理は [vibeboard](https://github.com/akiraak/vibeboard) で行う。
プロジェクト直下に degit で vendor してある（`./vibeboard/`）。

```bash
# 親プロジェクト直下から
node vibeboard/dist/cli.js --root .
```

`http://localhost:3010` でプロジェクト直下の `docs/plans/`・`docs/specs/`・`TODO.md`・`DONE.md`・`CLAUDE.md`・`README.md` を閲覧・編集できる。

- `Root` タブで `TODO.md` / `DONE.md` / `CLAUDE.md` / `README.md` をプレビュー表示・編集できる
  - 編集は楽観ロック（mtime チェック）付き。外部で先に更新されていた場合は保存時に 409 を返し、リロード / 手元維持 / 強制上書き を選べる
  - `fs.watch` + 2 秒ポーリングで外部変更を検知し、SSE でクライアントへ即時反映する
- ローカル開発専用（本番管理画面とは独立）
- ポート変更は `--port` または `VIBEBOARD_PORT` 環境変数で指定可能

## タスク管理ルール

- タスクは `TODO.md` で管理する
- **`TODO.md` に書くのはタスク（`- [ ]`）だけ。** メモや決定事項を残すときは、関係するタスクの
  下に字下げして付ける（タスクに関連付ける）。タスクに属さないメモの節（「決まったこと」「備考」など）は
  作らない。プロジェクトとしての決定は `CLAUDE.md` へ、済んだ経緯は `DONE.md` へ書く
- 字下げが親子。vibeboard はこれをツリーとして表示する。進行中は `[~]`、中止は `[-]` で表せる
- タスク同士の関係は、そのタスクの下に字下げした **`依存:` / `派生元:` / `関連:`** の行で書く。
  相手のタスクは `「文面」` で（例: `依存: 「スキーマに tags 列を追加」`）、プランや仕様は
  Markdown リンクで（例: `関連: [spec](docs/specs/api.md)`）示す。vibeboard のツリーで両方向に辿れる
- タスクが完了したら `TODO.md` から該当項目を削除し、`DONE.md` に移動する
- `DONE.md` には完了日を `YYYY-MM-DD` 形式で付けて記録する
- 新しいタスクが発生したら `TODO.md` の適切なセクションに追加する
- タスクの実施前に `TODO.md` を確認し、優先度の高いものから着手する
- コミット時に `TODO.md` を確認し、実装した機能に対応するタスクがあれば `DONE.md` に移動する

## 作業着手ルール

作業（実装・調査いずれも）を始めるときは、コードに手を入れる前に以下を行う。

1. **プランファイルを作成する**: `docs/plans/<task-name>.md` に実装プラン or 調査プランを作成する
   - 目的・背景、対応方針、影響範囲、テスト方針を最低限記載する
   - 複数 Phase / Step に分かれる場合はファイル内でも Phase / Step を明示する
2. **`TODO.md` に該当項目があるか確認する**
   - 無ければ適切なセクションに追加する
   - 既存項目があれば、その項目に作成したプランファイルへのリンクを追記する（例: `[plan](docs/plans/<task-name>.md)`）
3. **複数 Phase / Step がある場合は `TODO.md` に子タスクとして追加する**
   - 親項目の下にインデントしたチェックボックスで Phase / Step を列挙する
   - Phase / Step が完了するごとにチェックを入れ、全完了で親項目を `DONE.md` に移す
4. **作業完了時の後片付け**
   - 親タスクを `DONE.md` に移動する
   - 対応するプランファイルは `docs/plans/archive/` に移動する
<!-- vibeboard:end -->
````

## 非ゴール

将来も対応しないと決めているもの。

- **i18n / 英語 UI**: UI 文言は日本語固定
- **GitHub Issues / Linear / Jira 連携**: ローカルの Markdown ファイルだけを扱う
- **prompt / 会話履歴ビューア**: AI エージェント側のログは vibeboard の責務外
- **マルチユーザー / 認証**: 個人ローカル用ツールに徹する（`127.0.0.1` バインド固定）
- **本番デプロイ**: 配布形態は degit による vendor のみ（npm 公開・`npx` 単発実行・Git submodule は想定しない）

## トラブルシュート

### `EADDRINUSE: address already in use 127.0.0.1:3010`

ポートが埋まっていた場合、**同じ `--root` を管理している vibeboard** であれば自動的に停止して
起動し直すので、前回の起動が残っていただけならこのエラーにはならない。

それ以外（別プロジェクトの vibeboard、vibeboard 以外のプロセス）は**停止せずに終了する**。
複数プロジェクトで vibeboard を並走させる運用を壊さないための仕様。`--port` か
`VIBEBOARD_PORT` で別ポートを指定する。

```bash
node vibeboard/dist/cli.js --port 3020
```

判定は `$TMPDIR/vibeboard-<port>.json` に記録した pid と root で行う。pid ファイルが
無い / 古い場合や、記録された pid のプロセス実体が vibeboard でない場合は停止しない。

### WSL2 で外部から TODO.md を編集しても画面が更新されない

WSL2 では `fs.watch` がホスト側のファイル変更を拾わないことがある。vibeboard は
2 秒ポーリングで保険をかけているので、最大 2 秒待てば SSE 経由で反映される。
それでも反映されない場合はツールバーの `↻ 再取得` か `R` キーで手動更新する。

### `--root` で指定したパスがディレクトリとして存在しません

絶対パスで指定するか、目的のプロジェクトに `cd` してから引数なしで起動する。
シンボリックリンクは `fs.realpath` で解決した実体が `--root` 配下に収まるかを
チェックしているので、ルート外を指すリンクはたどれない（仕様）。

### `init` を流したくない / `CLAUDE.md` に手を入れたくない

`init` は任意。スニペットを上のセクションから手動でコピペしても良いし、貼らなくても
vibeboard サーバ自体は動く（規約に従うのは AI エージェント側なので、規約を共有する
必要が無いなら不要）。

## ライセンス

[Unlicense](./LICENSE)
