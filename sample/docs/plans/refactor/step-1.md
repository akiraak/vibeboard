# Step 1: 表示と編集の分離

エディタコンポーネントが肥大化しているので、
`<NoteView>`（表示専用）と `<NoteEditor>`（編集専用）に分割する。

## やること

- 既存の `<Note>` を `<NoteView>` にリネーム
- 編集モード時のみ `<NoteEditor>` を mount
- 共通の型は `types/note.ts` に切り出し

## 影響範囲

- `components/Note*` のみ
- API・スキーマ変更なし
