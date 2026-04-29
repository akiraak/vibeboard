# vibeboard

バイブコーディング（AI 駆動開発）に最適化された、ローカル開発用のタスク・プラン管理画面。

`Claude Code` / `Cursor` などの AI エージェントと並走するワークフロー
（プランを書く → TODO に積む → 実装 → DONE に移動 → プランをアーカイブ）を
1 つの画面でこなせるようにする、プロジェクト直下で起動する小さな Express サーバ。

```
┌──────────────────────────────────────────────────────────────┐
│ <project>             TODO  Plans  Specs                     │
├──────────────┬───────────────────────────────────────────────┤
│ docs/plans/  │ # TODO                                        │
│  ├ foo.md    │                                               │
│  └ bar.md    │ ## 機能開発                                    │
│ TODO.md      │ - [ ] xxx                                     │
│ DONE.md      │ - [x] yyy → DONE                              │
└──────────────┴───────────────────────────────────────────────┘
```

## できること

- `docs/plans/` ・ `docs/specs/` 配下の Markdown / HTML をツリーで一覧・閲覧
- ルート直下の `TODO.md` ・ `DONE.md` をプレビュー表示しつつ編集
  - mtime ベースの楽観ロック付き。外部で先に更新されていた場合は 409 を返し、
    リロード / 手元維持 / 強制上書き を選べる
  - `fs.watch` + 2 秒ポーリングで外部変更を検知し、SSE でクライアントへ即時反映
    （プレビュー自動更新／clean 編集は差し替え＋情報バー／dirty 編集は競合警告バー＋差分モーダル）
- `docs/plans/<file>` ・ `docs/plans/<dir>/` を `docs/plans/archive/` に移動
- ツールバーの `↻ 再取得` ボタン、または `R` キー単独で手動再取得

## 必要な前提構造

vibeboard は親プロジェクトに以下があることを前提に動く。

```
<project-root>/
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
（例: アーカイブ操作時の `docs/plans/archive/`）。`docs/specs/` は無くても起動できる。

## Quick start

vibeboard は **degit でプロジェクト直下に vendor して使う**（npm レジストリには公開していない）。
**常にプロジェクト固有のカスタマイズを入れる前提**のツールなので、サブディレクトリとして
取り込んで自由に手を加えられる形にしている。npx 単発実行や Git submodule での運用はサポートしない。

```bash
# プロジェクト直下で実行
npx -y degit akiraak/vibeboard vibeboard   # 既存 vibeboard/ がある場合は事前に削除
cd vibeboard
npm install                                # prepare で dist/ も生成される

# 起動 (例: 親プロジェクト直下を root にして見る)
node dist/cli.js --root ..
# → http://localhost:3010 を開く
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
cd vibeboard && npm install
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

優先順位は `CLI 引数 > 環境変数 > デフォルト`。

## 設定ファイル

`<root>/vibeboard.config.json` を置くと、UI のタブ・カテゴリ・編集対象ファイルを
プロジェクトごとにカスタマイズできる。`--config <path>` で別パスを指定することも可能。
ファイルが無ければデフォルト（`plans` / `specs` / `TODO.md` / `DONE.md`）で起動する。

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

  // 編集対象（TODO 系）タブ。タブのスラッグは固定で 'todo'
  // 省略時は { label: 'TODO', files: [TODO.md, DONE.md] }
  "editable": {
    "label": "TODO",
    "files": [
      // 文字列だけならファイル名そのまま。オブジェクトで label / path をカスタムできる
      "TODO.md",
      { "name": "DONE.md", "label": "DONE", "path": "DONE.md" }
    ]
  }
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

- `categories[].name` が空 / 重複 / `todo`（予約語） / パス区切り文字を含む
- `categories[].path` が root の外を指している
- `editable.files[].name` が `.md` で終わらない / 重複 / パス区切り文字を含む
- `editable.files[].path` が root の外を指している
- `categories` または `editable.files` を空配列にしている（省略してデフォルトに戻す）

優先順位は `CLI 引数 > 環境変数 > vibeboard.config.json > デフォルト`。

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

`http://localhost:3010` でプロジェクト直下の `docs/plans/`・`docs/specs/`・`TODO.md`・`DONE.md` を閲覧・編集できる。

- `TODO` タブで `TODO.md` / `DONE.md` をプレビュー表示・編集できる
  - 編集は楽観ロック（mtime チェック）付き。外部で先に更新されていた場合は保存時に 409 を返し、リロード / 手元維持 / 強制上書き を選べる
  - `fs.watch` + 2 秒ポーリングで外部変更を検知し、SSE でクライアントへ即時反映する
- ローカル開発専用（本番管理画面とは独立）
- ポート変更は `--port` または `VIBEBOARD_PORT` 環境変数で指定可能

## タスク管理ルール

- タスクは `TODO.md` で管理する
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

別のプロセスが `3010` を使っている。`--port` か `VIBEBOARD_PORT` で別ポートを指定する。

```bash
node vibeboard/dist/cli.js --port 3020
```

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
