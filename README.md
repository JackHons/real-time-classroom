# LAN 課堂互動平台

Windows 10/11 私有區域網路課堂互動平台。它包含教師／學生操作、題目、名單、檔案收件及 Socket.IO 即時通知。

## 安全與部署範圍

本產品僅可在教師確認的受信任 Windows **Private** LAN 使用。它使用 HTTP，不提供傳輸機密性、抵抗同網段竊聽／竄改，亦不保證 session token 不被竊取。請勿暴露至 Internet、公網、反向代理或 Public firewall profile。

預設 runtime data 位於 `%LOCALAPPDATA%\LanClassroomPlatform`，不會置於 web root 或此 repository。CSV／ZIP 僅是匯出，不是備份或還原方案。詳見 [runtime-data.md](docs/operations/runtime-data.md)。

## 發佈與部署

維護者在已安裝 pnpm 的建置機器執行：

```powershell
pnpm release:assemble
pnpm release:verify
```

前者會產生 `release\LAN Classroom 0.1.0\`（版本號依 package metadata），包含已建置的 server、web UI、migrations hash manifest、Windows 啟動器、文件、授權資料及所有 production dependencies。它不含本專案的 application source。後者會把包移到原始碼外、名稱含空格及中文的暫存位置，確認不依賴原始碼或根目錄的 `node_modules`，並從該包啟動首次設定 UI（HTTP 200）。

在教師電腦只需安裝 Windows x64 Node.js 22 或 24 LTS；不需 pnpm、原始碼或 Visual Studio。解壓發佈包後，可直接雙擊根目錄的 `Start Classroom.cmd`，它會在背景啟動本機 Web GUI 並開啟 `http://127.0.0.1:50165/`（首次使用會開啟 `/setup`）；雙擊 `Stop Classroom.cmd` 可安全停止同一個實例。包內有 `RELEASE-PREREQUISITES.md`；啟動器會先測試 SQLite/WAL，若原生檔不相容會安全停止。

在原始專案根目錄雙擊同名的 `Start Classroom.cmd` 也可以一鍵使用目前程式：它會先執行目前 checkout 的建置，然後以相同的本機模式啟動；此開發／測試模式需要已安裝 pnpm 11+。重複雙擊只會開啟已運行的同一個服務，不會建立第二個實例。雙擊 `Stop Classroom.cmd` 會安全停止服務並保留教師密碼、SQLite 資料與上傳檔案。

## 開發環境

- Windows 10 或 Windows 11
- Node.js 22 或 24 LTS（支援範圍：`^22.0.0 || ^24.0.0`）
- pnpm 11+

安裝依賴後可使用：

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm check
pnpm test:unit
```

首次建立 lockfile 時，維護者可使用 `pnpm install`，並在提交前檢查 lockfile。開發 bootstrap host 可用 `pnpm dev` 啟動；它會先建置最小 SvelteKit UI，預設綁定 `127.0.0.1:4173`，並提供 `GET /health`。它不會自行開放 LAN。

本次 bootstrap 的本機驗證環境是 Node.js 26.4.0；它不是本專案宣告支援的 LTS 版本。因此這些結果只證明骨架可在該環境執行，**不構成 Node 22/24 LTS 支援驗收**。發布／CI 必須在 Node 24 LTS（並在需要時另測 Node 22 LTS）重新跑所有 required gates。

## Entry point and packaging contract

`apps/server/src/main.ts` 是唯一可執行的 Node entry point。它載入 `apps/web/build/handler.js`，再呼叫 `startServer()`；`apps/server/src/server.ts` 是可測試的 host module，唯一公開啟動契約為 `Promise<RunningServer>`，其 `close()` 用於測試與受控關機。

`pnpm build` 先產生 `apps/web/build/`，再產生 `apps/server/dist/`。production package 必須同時保留兩者及 production dependencies，並只能以 `node apps/server/dist/main.js` 啟動；不得另行啟動 SvelteKit adapter 的預設 server。詳見 [bootstrap contract](docs/operations/bootstrap-contract.md)。

## Windows 私有 LAN 啟動

教師在 **Private** 網路上從發佈包根目錄執行：

```powershell
.\scripts\windows\Start-LanClassroom.ps1
```

啟動器會列出可用的私有 IPv4 網卡，並要求教師明確選擇；虛擬網卡會標示出來，Public／Domain、loopback、APIPA 和非 RFC1918 位址不會列入。它會在開始前檢查端口、建置產物和 migrations、runtime data 的私有 ACL／可寫入及 fsync、SQLite 依賴，以及 5.2 GB 上傳預留空間。資料一律位於 `%LOCALAPPDATA%\LanClassroomPlatform`，不在 repository 內；升級不會清除它。

若要建立防火牆規則，管理員可明確要求：

```powershell
.\scripts\windows\Start-LanClassroom.ps1 -ConfigureFirewall
```

規則只允許指定 Node 程式和 TCP port，限 **Private** profile 及 `LocalSubnet`；它不會開放 Public 或 Domain profile，也不會自行提權。沒有管理權限時，啟動器會顯示可交給管理員執行的精確指令。預設不變更防火牆。學生使用啟動器顯示的 URL；這是 HTTP，僅限教師確認的受信任 Private LAN，不能防止同網段攔截、竄改或 session token 竊取。

關機時執行：

```powershell
.\scripts\windows\Stop-LanClassroom.ps1
```

它只停止記錄的程序並移除由本次啟動器建立的防火牆規則，**不刪除** SQLite、uploads 或其他 runtime data。用 `pnpm test:windows-launcher` 可驗證網卡篩選和選擇邏輯。

## Quality-gate status

`pnpm lint` 會執行 TypeScript ESLint 及 `svelte-check`；後者是目前明確的 Svelte template/typing quality gate，並非宣稱已具備完整 Svelte style-rule coverage。將來若需要 style lint，必須新增 Svelte ESLint plugin 與規則，而不是靜默略過 `.svelte`。

目前只有 `test:unit` 有真實 bootstrap case。`test:integration`、`test:e2e`、`test:a11y` 在缺少 matching suite 時會以非零結束，表示**未驗證**；`test:load` 也會以非零結束，直至 Task 10 提供真實 k6 suite。Playwright 的未來必測矩陣是 Chrome、Microsoft Edge、Firefox，不能以 WebKit 代替 Edge。

## Repository layout

- `apps/server/`：唯一 Node HTTP host 的起點；目前附加建置後的 SvelteKit handler，之後會附加 REST 與 Socket.IO。
- `apps/web/`：SvelteKit UI skeleton。
- `tests/unit/`：bootstrap unit smoke test。
- `docs/adr/`：實作前已定案的資料與安全語意。
- `docs/operations/`：runtime data 與 LAN 操作邊界。
