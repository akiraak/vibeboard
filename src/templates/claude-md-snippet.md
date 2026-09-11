## 開発管理画面 (vibeboard)

ローカル開発時のタスク・プラン管理は [vibeboard](https://github.com/akiraak/vibeboard) で行う。
プロジェクト直下に degit で vendor してある（`./vibeboard/`）。

```bash
# 親プロジェクト直下から
node vibeboard/dist/cli.js --root .
```

`http://localhost:3010` でプロジェクト直下の `docs/plans/`・`docs/specs/`・`TODO.md`・`DONE.md`・`CLAUDE.md`・`README.md` を閲覧・編集できる。

- `Files` タブでプロジェクト内のファイル（`TODO.md` / `DONE.md` / `CLAUDE.md` / `README.md` を含む）をプレビュー表示・編集できる。`TODO.md` はツリー表示つき
  - 編集は楽観ロック（mtime チェック）付き。外部で先に更新されていた場合は保存時に 409 を返し、リロード / 手元維持 / 強制上書き を選べる
  - `fs.watch` + 2 秒ポーリングで外部変更を検知し、SSE でクライアントへ即時反映する
- `Tasks` タブで `TODO.md` のタスクを、このプロジェクトで動いている Claude Code のセッションへ渡して実行できる（実行 / プラン作成 / 説明 / 削除）。
  プラン作成は `docs/plans/` のプランファイルと `TODO.md` へのリンク・子タスクだけを作らせる（実装はしない）。
  ボタンの上の **「追加の指示（任意）」** に書いた文面は、実行 / プラン作成 / 説明の文面の末尾に足して送る（空欄なら今までどおり。Ctrl+Enter で実行）。
  左ペインの上の「プロジェクト全体」に **commit & push** があり、タスクとは無関係に作業ツリーの変更をまとめてコミットして push させる（メッセージと `TODO.md` / `DONE.md` の整理はセッションが行う）。
  **タスク追加**（「プロジェクト全体」）と**子タスク追加**（タスク詳細）は投函せず、vibeboard がバックグラウンドの
  Claude Code（`claude -p`。許すツールは `TODO.md` の Edit だけ）を起こして `TODO.md` に足させる。1 行目が
  タスクの文面（そのまま入る）、2 行目以降はメモ。成功判定は「`TODO.md` に文面が増えたか」の事後検査で、
  モデル・制限時間は `vibeboard.config.json` の `taskAdd`（`model` / `timeoutSec`。既定は CLI の既定モデル・120 秒）。
  送り先は `claude agents` の一覧から選ぶ。セッションは起動時の hook（`vibeboard init` が `.claude/settings.json` に書く）で
  自分の受信口を vibeboard に登録し、vibeboard がそこへ文面を投函する。登録が無くても Linux なら `claude agents` の pid から
  受信口（`$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`）を引いて投函する。hook が使えない環境では
  `node vibeboard/dist/cli.js listen --name <画面の名前>` を回す
- ローカル開発専用（本番管理画面とは独立）
- ポート変更は `--port` または `VIBEBOARD_PORT` 環境変数で指定可能
- 本体の更新は `node vibeboard/dist/cli.js update --restart`（再 degit → `npm install` → `init` → 同じ root の vibeboard の起動し直し、を 1 コマンドで）

## タスク管理ルール

- タスクは `TODO.md` で管理する
- **タスクの行は、親項目も含めて必ず `- [ ] 文面` の形で書く。** vibeboard はチェックボックス
  （`[ ]` 未着手 / `[x]` 完了 / `[~]` 進行中 / `[-]` 中止）のある行だけをタスクとして拾う。
  `- 文面` のようにチェックボックスの無い行はタスクではなく直前のタスクのメモ扱いになり、ツリーにも
  Tasks タブにも出ない（親に付け忘れると、子タスクだけが親を失って並ぶ）
- **`TODO.md` に書くのはタスクだけ。** メモや決定事項を残すときは、関係するタスクの
  下に字下げして付ける（タスクに関連付ける）。タスクに属さないメモの節（「決まったこと」「備考」など）は
  作らない。プロジェクトとしての決定は `CLAUDE.md` へ、済んだ経緯は `DONE.md` へ書く
- 字下げが親子。vibeboard はこれをツリーとして表示する

  ```markdown
  - [ ] 親タスク [plan](docs/plans/foo.md)
    - [x] Step 1: 済んだ子タスク
    - [~] Step 2: 進行中の子タスク
      - 決定: この子タスクに付くメモ（チェックボックスなし）
  ```
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
