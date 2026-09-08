# pi-herdr-fleet 改善レビュー

調査対象: `main` @ `bd64afc`（「実Herdr E2Eで検出したレース・ライフサイクル不具合を修正」済み）。
目的: 大きな書き換えではなく、次に手を付ける具体的な改善点。

## 現状の読み

拡張は Pi セッション内で Herdr pane をオーケストレーションする。中核は次の通り。

| 層 | 場所 | 役割 |
| --- | --- | --- |
| Extension | `src/index.ts` | `agent_*` ツール、`/fleet`、widget、session ライフサイクル |
| Orchestrator | `src/orchestrator.ts` | spawn / submit / 完了通知 / 同時実行予算 |
| Runtime | `src/runtime-herdr.ts` + `src/herdr.ts` | Herdr CLI |
| Events | `src/herdr-events.ts` | Unix socket 購読と再接続 |
| Registry | `src/registry.ts` | プロセス横断の追記型 JSONL |
| Roles | `src/agents.ts` + `agents/*.md` | フロントマターから role を発見 |

`bd64afc` で、ライブ E2E（Herdr 0.8.2 / Pi 0.85.0、高速完了 130 サイクル、並列 spawn）由来の問題はかなり潰されている。再実装しないこと:

- `agents/scout.md` の未引用 YAML で scout が黙って欠落
- 複数行 system prompt を argv ではなく一時ファイル経由で渡す
- pane split 直後の `agent start` リトライと start 失敗時の pane 回収
- socket ハンドラ例外で Pi が落ちる問題、閉じた pane 購読による再接続ストーム
- `spawnGate`、submit 後の `working` 真実化、幽霊 run の prune
- registry の `lastOutput` 上限と増分パース
- widget の例外防御と active 優先表示

残課題は「その修正の穴」と「修正を固定するテスト/DX」が中心。

## この PR で入れた小さな修正

**P0 相当のタイマー世代漏れ**だけ直した。`src/orchestrator.ts` の `settleChecks` が、後続の `agent_send` に古い 2.5s grace timer を引き継いでいた。`idle` は完了扱いなので、次ターンの TUI 更新前 idle を「settled」と誤認し、親を起こしてしまう。`dropPending` / `clearSettleCheck` と `pending.generation` ガードを追加。挙動の意図は変えていない。

---

## P0 — バグ / 信頼性

### 1. 後続ターンが古い settle timer で完了扱いになる

- **Where:** `src/orchestrator.ts`（`submit` の 2.5s `settleChecks`、`isCompleted` = `idle|done`）
- **Why:** `bd64afc` は「prompt 直後の pre-visual idle を working とみなし、イベントが来ない高速完了を 2.5s 後に照合する」ための timer を入れた。しかし timer は `pending.delete` 時に `clearTimeout` されず、callback も generation を見ていなかった。`agent_send` で 2.5s 以内に次ターンを投げると、古い timer が新しい `pending` に対して `runtime.get()` し、まだ pre-visual の `idle` を完了とみなす。
- **Direction:** この PR で `clearSettleCheck` + generation 照合を入れた。残りは Orchestrator のフェイク runtime テストで「submit → すぐ submit → 2.5s」を固定すること（項目 4）。

## P1 — 手を付ける価値がはっきりしている

### 2. `syncEvents` の in-flight coalesce が最新 pane 集合を落とす

- **Where:** `src/orchestrator.ts` `syncEvents()`（`if (this.syncInFlight) return this.syncInFlight`）
- **Why:** registry の `fs.watch`（`src/index.ts` `onRegistryChanged`）が書き込みのたびに同期する。進行中の sync に合流すると、その sync が既に `list()` した後に追加された pane は購読されない。同一プロセスの spawn は後段の `submit` → `ensurePanes` で回収できるが、子 agent（別プロセス）が registry に足した peer は、次の書き込みまで status イベントを取りこぼす。
- **Direction:** in-flight 中は dirty フラグを立て、完了後にもう一度 `prune + ensurePanes` する trailing-edge。合流した caller はその follow-up まで待つ。再接続ストームを戻さないこと（`ensurePanes` の `connecting` ガードは維持）。
- **Status:** この PR で `syncQueued` + while ループを入れた。`syncInFlight` は raw run promise を保持し、finally で identity 照合してクリアする（`.finally()` ラップへ `.then(() => syncEvents())` を繋ぐとマイクロタスク無限ループになるため）。orchestrator テストで mid-sync の pane 追加を固定。

### 3. イベント購読の `connecting` ガードが `start()` / `close` 再接続をカバーしていない

- **Where:** `src/herdr-events.ts`
  - `ensurePanes`: `connecting` 中は pane 集合が変わっても reconnect しない（`this.panes` だけ更新）
  - `start()`: `connecting = true` を立てずに `reconnect()` を積む
  - socket `close`: `reconfigure` チェーンを bypass して `void this.reconnect()` する
- **Why:** `bd64afc` が直した「handshake 中に socket を壊して `connected=false` のまま嵐になる」の亜種。`session_start` の `startEvents()` と最初の spawn が重なると、購読 pane 集合が古いまま、または二重 reconnect になる。
- **Direction:**
  1. `start()` も `ensurePanes` と同じ `connecting` / `reconfigure` ゲートを通す
  2. handshake 完了後、購読した集合と `this.panes` が違えば follow-up reconnect
  3. `close` の自動 reconnect も `reconfigure` チェーンに乗せる（generation チェックは残す）
  ソケットをモックした単体テストが一番安い。
- **Status:** この PR で `enqueueReconnect` / `panesDirty` / handshake dirty ループを入れ、`start()` と socket `close` も同じゲートに乗せた。`test/herdr-events-subscriber.test.ts` で Unix socket モック。

### 4. ライフサイクル修正に回帰テストがほぼ無い

- **Where:** `test/herdr-events.test.ts`（名前正規化のみ）、`test/registry.test.ts`（resolve / 共有ファイルの基本）、`src/orchestrator.ts` は未テスト。CI も無い（`.github/` なし）
- **Why:** `bd64afc` の価値はレース修正そのものなのに、再発を止められない。特に `agents/scout.md` の YAML 欠落は `src/agents.ts` `loadDir` が parse 失敗を握りつぶすため、テストが無いとまた黙って消える。
- **Direction:** 大きな E2E ハーネスは後回しでよい。先に:
  1. bundled agents を `discoverAgents` して `scout/planner/worker/reviewer` が揃うこと（未引用 YAML の再発防止）
  2. registry: `lastOutput` 切り詰め、増分パース、壊れた 1 行を飛ばすこと
  3. `AgentRuntime` をフェイクして spawn gate / settle timer / prune の数本
  4. `bun run check` を GitHub Actions で main/PR に乗せる
- **Status:** この PR で 1–4 を追加した（`test/agents.test.ts`、`test/registry.test.ts`、`test/orchestrator.test.ts`、`.github/workflows/ci.yml`）。subscriber のソケットモックは `test/herdr-events-subscriber.test.ts` で追加。

### 5. 失敗が沈黙する

- **Where:**
  - `src/index.ts` `if (!isHerdrAvailable()) return;` — Herdr 外ではツールも `/fleet` も登録されない
  - `src/config.ts` `readJson` — 壊れた `.pi/herdr-fleet.json` は `{}` 扱い
  - `src/agents.ts` `loadDir` の空 `catch` — 壊れた `*.md` は role ごと消える
- **Why:** インストールしたのに `/fleet` が無い、設定したのに効かない、scout がいない、がすべて「何も起きない」。`bd64afc` の scout 欠落と同じクラス。
- **Direction:** 挙動は変えない。`session_start` か `/fleet` で警告を出す。Herdr 外なら「Pi を Herdr 内で起動すること」を一度 notify。壊れた JSON/Markdown はファイル名を warning に含める。parse 失敗を握りつぶすのは残してよい（1 ファイルで拡張全体を殺さないため）。
- **Status:** この PR で追加。Herdr 外は `session_start` で一度 + `/fleet` で再通知。壊れた `herdr-fleet.json` / agent `*.md` はファイル名付き warning。parse 失敗の握りつぶしは維持。`test/config.test.ts`、`test/extension.test.ts`、agents の skip 警告。

### 6. `agent_wait` が無制限にブロックし、全ツールが AbortSignal を無視する

- **Where:** `src/index.ts` の各 `execute(..., _signal, ...)`、`src/orchestrator.ts` `wait()`、`src/runtime-herdr.ts` `wait()`（timeout 省略可）
- **Why:** Herdr の `agent wait` はデフォルト timeout なし。モデルが `timeout_ms` を付け忘れるとターンが固まる。Pi がツールをキャンセルしても `_signal` 未使用なので CLI は生き残る。
- **Direction:** `agent_wait` に設定可能なデフォルト（例: 120s）を足す。`signal` で `herdr` 子プロセスを kill するか、少なくとも wait を abort。`spawn`/`prompt` は最初は wait だけでよい。
- **Status:** この PR で追加。`defaultWaitTimeoutMs` デフォルト 120000。`timeout_ms` 省略時はこれを Herdr `--timeout` に渡す。AbortSignal は `agent_wait` → `herdr` CLI（`execFile` の `signal` で子プロセスを kill）。timeout は `AgentWaitTimeoutError` として現在状態を返す。spawn/prompt は未対応。

## P2 — あるとよい

### 7. 共有 JSONL の原子性と無限成長

- **Where:** `src/registry.ts`（`appendFileSync`、`MAX_STORED_OUTPUT = 4000`）
- **Why:** POSIX の O_APPEND 原子性はだいたい `PIPE_BUF`（4KiB）。`lastOutput` 4000 文字にメタデータを足すと 1 レコードがそれを超える。ネスト spawn（別プロセス）が同時 upsert すると行が壊れ、増分パーサはその行を永久に飛ばす。ファイル自体も compaction 無し。
- **Direction:** `lastOutput` を registry に書かない（finalize は同プロセスのメモリで足りる）、またはレコードを 4KiB 未満に保つ。長セッション用に「最新状態だけ」への周期 rewind は任意。クロスプロセスの同時実行予算は、デフォルト role が `spawning: false` なので急がない。

### 8. 完了 pane が残り、blocked フローはまだ E2E されていない

- **Where:** `src/orchestrator.ts`（`done`/`idle` でも pane を閉じない）、README Status 節
- **Why:** `maxConcurrent` は `starting|working` だけを数える。終わった agent と `blocked` は予算外のまま pane を占有する。README が言う通り blocked / startup-blocked は決定論的 E2E 対象外。
- **Direction:** 自動 close は製品判断（interactive pane を残す設計）。opt-in の `closeOnSettle` か、`/fleet` に「done を close」を足す程度が安全。blocked はフィクスチャ（approval UI）が要るので、まず runtime フェイクで `agent_blocked` / `agent_not_ready` の分岐を単体テストする。

### 9. 設定面の DX

- **Where:** `config.example.json`、`src/index.ts` `thinking` のキャスト、`src/orchestrator.ts` の `spawning` × `maxDepth`
- **Why:** example に `spawning` / `interactive` / `defaultModel` が無い。`thinking` は `as ThinkingLevel` で通る。`maxDepth` は「この Orchestrator の depth が max 以上なら spawn 不可」で、bundled role は `spawning: false` のため実効的には root だけが spawn する。README からは読み取りにくい。
- **Direction:** example と README に `spawning` / `maxDepth` の実効ルールを 5 行で書く。`thinking` は spawn 時に不正値を弾く。コードの分岐は触らない。

## やらなくてよいこと

- Runtime 抽象の再設計や Herdr 以外のバックエンド。`FleetConfig.runtime` は常に `"herdr"`。
- Registry を SQLite / JSON 1 ファイルに置き換える。追記型はクロスプロセス共有のための意図的な選択。
- 公式 Herdr Agent Skill との統合。README の通り、orchestration は拡張側が持つ。
- widget / ツール API の見た目の作り直し。

## 推奨する次の一手（短い順）

1. ~~項目 4 の bundled-agent / registry 回帰テストと `bun run check` の CI~~ **済み**（この PR）
2. ~~項目 2 の trailing sync と項目 3 の subscriber ゲート~~ **済み**（この PR）
3. ~~項目 5 の警告~~ **済み**（この PR）
4. ~~項目 6 の wait timeout / abort~~ **済み**（この PR）

P1 はここまで。次は P2（JSONL 原子性、完了 pane、設定 DX）。
