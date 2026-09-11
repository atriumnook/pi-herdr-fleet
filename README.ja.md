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
/fleet close
```

`/fleet` は一覧です。`/fleet close`（または `/fleet close done`）は、Herdr がまだ `done` と報告している非 interactive pane を閉じます。interactive / blocked / idle / 進行中の pane は残します。

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

### モデルと thinking の指定

`thinking`（Pi の思考量。effort に相当）は `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` を受け付けます。指定は次の順に優先されます。

1. `agent_spawn` の引数（`model` / `thinking`）。自然言語で「worker を thinking low で立てて」と頼んでもこの経路になる。
2. 設定ファイルの `roles.<name>.thinking`（プロジェクト `.pi/herdr-fleet.json` がユーザー `~/.pi/agent/herdr-fleet.json` を上書き）。
3. role 定義（`agents/*.md` の frontmatter `thinking:`）。
4. 設定ファイルの `defaultThinking`。省略時は今の Pi セッションの値。

`model` に `provider/model:low` のように suffix を付けた場合はその値が使われ、上記の `thinking` では上書きされません。

```text
agent_spawn({ role: "worker", model: "openai-codex/gpt-6-astra", thinking: "low", task: "..." })
```

## 設定

[`config.example.json`](config.example.json) を `.pi/herdr-fleet.json`（プロジェクト）および／または `~/.pi/agent/herdr-fleet.json`（ユーザー）にコピーします。プロジェクトがユーザーを上書きし、どちらも組み込みデフォルトの上に載ります。`defaultModel` / `defaultThinking` を省略すると、今の Pi セッションの値が使われます。

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

| キー | デフォルト | 意味 |
| --- | --- | --- |
| `runtime` | `"herdr"` | Herdr のみ対応。 |
| `defaultModel` | 未設定（Pi セッション） | role に `model` が無いときのフォールバック。 |
| `defaultThinking` | 未設定（Pi セッション） | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`。設定と agent frontmatter は不明な値を無視し、`agent_spawn` は拒否する。 |
| `maxConcurrent` | `6` | `starting` または `working` の上限。idle / done / blocked は数えない。 |
| `maxDepth` | `2` | ネスト上限。下記参照。 |
| `notifyOnComplete` | `true` | 非 interactive のターン完了時に呼び出し元を起こす。 |
| `recentReadLines` | `160` | `agent_read` と完了通知が読む行数（下限 20）。 |
| `defaultWaitTimeoutMs` | `120000` | モデルが `timeout_ms` を省略したときの `agent_wait` 上限。 |
| `closeOnSettle` | `true` | 非 interactive の `idle`/`done` をターン完了後に閉じる（sync 時も同じ年齢・再確認ゲート）。`false` なら `/fleet close` まで pane を残す。 |
| `roles.<name>` | `{}` | role ごとの `model` / `thinking` / `worktree` / `interactive` / `spawning`。 |

### ネスト（`spawning` × `maxDepth`）

- この拡張を読み込んだ Pi セッションが depth `0`。spawn するたびに `parentDepth + 1`。
- 今のセッションの depth が `>= maxDepth` なら spawn は拒否される。デフォルト `2` では root → child → grandchild までで、grandchild は spawn できない。
- 子 agent が `agent_spawn` を持てるのは、その role が `spawning: true`（設定または agent markdown）**かつ** `parentDepth + 1 < maxDepth` のときだけ。
- bundled の `scout` / `planner` / `worker` / `reviewer` は `spawning: false` なので、role を上書きしない限り spawn できるのは root セッションだけ。
- `interactive: true`（bundled の `planner`）は人間操作用に pane を残す。完了しても呼び出し元を自動では起こさず、pane も自動 close しない。

## ロール

| Role | 用途 |
| --- | --- |
| `scout` | 高速な read-only 調査 |
| `planner` | 設計・実装計画 |
| `worker` | 実装と検証 |
| `reviewer` | 独立したコードレビュー |

カスタム role は `.pi/agents/` または `~/.pi/agent/agents/` に追加できます（プロジェクト優先）。frontmatter は `roles.<name>` と同じキー（`model` / `thinking` / `worktree` / `interactive` / `spawning`）を受け付けます。

worktree isolation は opt-in で、role または spawn ごとに有効化できます。

## ツール

| Tool | 用途 |
| --- | --- |
| `agent_spawn` | Pi agent を Herdr pane で起動。ツールキャンセル（`AbortSignal`）に応じ、中断時は新規 pane を閉じる。 |
| `agent_send` | fleet member にメッセージを送信。`AbortSignal` に応じるが既存 pane は閉じない。 |
| `agent_wait` | agent を明示的に待機。`AbortSignal` とデフォルト timeout に応じる。 |
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

blocked / startup-blocked は orchestrator の単体テスト（`agent_blocked` / `agent_not_ready`）でカバーしています。Herdr の approval UI を使うライブ E2E はまだ決定論スイートに入っていません。

## クレジット

[Pi](https://github.com/earendil-works/pi) と [Herdr](https://herdr.dev/) の上に構築しています。
