# pi-herdr-fleet

[Pi](https://github.com/earendil-works/pi) 向けの Herdr ベースのマルチエージェント拡張です。

[English](README.md)

`pi-herdr-fleet` は Pi agent を実際の [Herdr](https://herdr.dev/) pane で動かします。  
role ごとにモデルを分け、複数 agent を並列に動かし、agent 同士でメッセージを送り合えます。必要なときはそのまま pane に入って操作できます。

## インストール

[Herdr](https://herdr.dev/) と [Pi](https://github.com/earendil-works/pi) を導入した上で、Herdr の Pi integration を有効にします。

```bash
herdr integration install pi
```

GitHub から extension をインストールします。

```bash
pi install git:github.com/atriumnook/pi-herdr-fleet
```

インストール後に Pi を再起動してください。

公式 Herdr Agent Skill は不要です。Herdr の orchestration は extension 内で処理します。

## 使い方

Herdr 内で Pi を起動し、現在の fleet を確認します。

```text
/fleet
```

普段はそのまま Pi に依頼できます。

```text
scout で認証フローを調べて。
reviewer に現在の diff を独立してレビューさせて。
```

ツールを直接呼ぶこともできます。

```text
agent_spawn({ role: "scout", task: "認証フローを調査して" })
agent_send({ target: "reviewer", message: "src/auth/token.ts を確認してください" })
agent_focus({ target: "planner" })
```

## 設定

プロジェクト設定は `.pi/herdr-fleet.json`、ユーザー設定は `~/.pi/agent/herdr-fleet.json` に置きます。

```json
{
  "maxConcurrent": 6,
  "maxDepth": 2,
  "defaultWaitTimeoutMs": 120000,
  "roles": {
    "scout": {
      "model": "provider/fast-model",
      "thinking": "medium"
    },
    "worker": {
      "model": "provider/strong-model",
      "thinking": "high"
    }
  }
}
```

設定項目は [`config.example.json`](config.example.json) を参照してください。`defaultWaitTimeoutMs`（120000）は、モデルが `timeout_ms` を省略したときの `agent_wait` 上限です。

## ロール

| Role | 用途 |
| --- | --- |
| `scout` | 高速な read-only 調査 |
| `planner` | 設計・実装計画 |
| `worker` | 実装と検証 |
| `reviewer` | 独立したコードレビュー |

カスタム role は `.pi/agents/` または `~/.pi/agent/agents/` に追加できます。

worktree isolation は opt-in で、role または spawn ごとに有効化できます。

## ツール

| Tool | 用途 |
| --- | --- |
| `agent_spawn` | Pi agent を Herdr pane で起動 |
| `agent_send` | fleet member にメッセージを送信 |
| `agent_wait` | agent を明示的に待機 |
| `agent_read` | focus を変えず最近の出力を取得 |
| `agent_interrupt` | 現在の turn を interrupt |
| `agent_focus` | agent pane に focus して直接操作 |
| `agent_list` | fleet member を一覧表示 |

通常の完了は Herdr event で追跡します。`blocked` になった agent には自動回答せず、人間の入力を待ちます。

## 開発

```bash
git clone https://github.com/atriumnook/pi-herdr-fleet.git
cd pi-herdr-fleet
bun install
bun run check
```

ローカル checkout を Pi で使う場合:

```bash
pi install "$(pwd)"
```

## ステータス

Herdr 0.8.2 と Pi 0.85.0 でライブ E2E テスト済み。

カバー範囲:
spawn、ライフサイクル完了通知、モデルルーティング、ピアメッセージング、
エージェント制御、worktree 分離、同時実行制限とネスト。

blocked・startup-blocked のフローは、決定論的な E2E テストではまだカバーされていません。

## クレジット

[Pi](https://github.com/earendil-works/pi) と [Herdr](https://herdr.dev/) の上に構築しています。
