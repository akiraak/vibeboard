# Step 2: 状態管理を Hook に切り出し

`<NoteEditor>` 内の `useState` / `useEffect` を `useNoteDraft` フックにまとめる。

## やること

- ドラフトの保存（debounced autosave）
- 競合検知（mtime 相当のリビジョン比較）
- ロールバック

## 影響範囲

- `hooks/useNoteDraft.ts` を新設
- `<NoteEditor>` がスリムになる
