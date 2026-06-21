# sample-custom-tab

vibeboard の customTabs 拡張動作確認用の最小ダミー HTTP サーバ。

## 使い方

1. プラグインを起動:

   ```bash
   node vibeboard/sample-custom-tab/server.js --port 8181
   ```

2. vibeboard.config.json に customTabs を追加:

   ```json
   {
     "customTabs": [
       { "name": "sample", "label": "Sample", "baseUrl": "http://127.0.0.1:8181" }
     ]
   }
   ```

3. vibeboard を起動して topbar の `Sample` タブを開くと、サイドバーに 3 つの item が並び、
   選択すると iframe にダミー HTML が表示される。15 秒ごとに `item-changed` SSE が
   届くので、選択中の item に対応する iframe が自動 reload される。
