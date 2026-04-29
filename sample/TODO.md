# TODO

## 機能開発

- [ ] タグでメモを絞り込めるようにする [plan](docs/plans/feature-x.md)
  - [ ] スキーマに `tags` 列を追加
  - [ ] 一覧 API で複数タグ AND 検索
  - [ ] 本文中の `#tagname` を保存時に自動抽出
- [ ] 古いメモを自動アーカイブする [plan](docs/plans/feature-y.md)

## リファクタ

- [ ] エディタ周りのコンポーネント分割 [plan](docs/plans/refactor/step-1.md)
  - [ ] Step 1: 表示と編集の分離
  - [ ] Step 2: 状態管理を Hook に切り出し

## バグ

- [ ] iOS Safari でフォーカスが外れることがある
- [ ] 長文の保存時にカーソル位置が先頭に飛ぶ
