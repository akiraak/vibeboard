# TODO

## 機能開発

- [ ] タグでメモを絞り込めるようにする [plan](docs/plans/feature-x.md)
  - [x] スキーマに `tags` 列を追加
  - [~] 一覧 API で複数タグ AND 検索
    依存: 「スキーマに `tags` 列を追加」
  - [ ] 本文中の `#tagname` を保存時に自動抽出
    依存: 「一覧 API で複数タグ AND 検索」
    関連: [spec](docs/specs/api.md)
- [ ] 古いメモを自動アーカイブする [plan](docs/plans/feature-y.md)
  派生元: 「タグでメモを絞り込めるようにする」
  アーカイブ済みのメモはタグの絞り込みから外す

## リファクタ

- [ ] エディタ周りのコンポーネント分割 [plan](docs/plans/refactor/step-1.md)
  - [ ] Step 1: 表示と編集の分離
  - [ ] Step 2: 状態管理を Hook に切り出し
    依存: Step 1

## バグ

- [ ] iOS Safari でフォーカスが外れることがある
  関連: 「エディタ周りのコンポーネント分割」
- [ ] 長文の保存時にカーソル位置が先頭に飛ぶ
