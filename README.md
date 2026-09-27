# discord-oneclick

DiscordのWebブラウザ画面上から、元画像やメディア情報を一括抽出・管理するためのTampermonkey UserScriptです。

## 主な機能
* スレッドやチャンネル内のメディアURL（元画像等）の抽出・リスト化
* 抽出データのCSV / SQLite / JSON エクスポート機能
* 重複ファイルのトラッキングとモーダルダイアログによる詳細表示
* 画面上の画像コンポーネントに対する「保存（Save）」ボタンの直接インジェクト

## インストール
Tampermonkeyなどの拡張機能に `*.user.js` を追加して使用します。
