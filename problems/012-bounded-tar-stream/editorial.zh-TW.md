# 解題說明

## 直覺解

依 size 配置 payload、padding 與整個 archive，再從 byte offset 模擬。若 archive 長度為 `A`，時間與空間都是 `O(A)`；本題 `A` 可達 `9*10^18`，無法執行。

## 最佳解

只維護 `expectedOffset`、待使用 metadata 路徑、檔案數與解壓 bytes。每筆依題目列出的錯誤優先序檢查。layout 不需要內容；使用

`blocks = (size + 511) // 512`

便可把 expected offset 增加 `512 + 512*blocks`。`G/P` 僅保存一條至多 200 bytes 的路徑；下一筆 `F/D` 使用後立刻清空。

路徑以 `/` 分割，逐 segment 檢查允許字元並拒絕空字串、`.`、`..`。

## 正確性證明

以已處理事件數歸納。初始 expected offset 為 0、狀態與統計皆空，符合空 archive。假設前 `i-1` 筆後狀態正確：第 `i` 筆依規格相同順序檢查所有可能錯誤，因此若拒絕，回報的正是最早事件與該事件最高優先錯誤；若通過，公式精確略過 header、payload 與 padding，metadata 狀態亦依種類唯一更新，只有 `F` 依規格更新兩項 quota。故第 `i` 筆後 invariant 仍成立。歸納可知全部通過時三個統計與 endOffset 正確；最後的 pending 檢查也正好捕捉未被消耗的 metadata。

## 複雜度

令所有 name 長度總和為 `S`、完整輸入文字 bytes 為 `T`，時間 `O(N+S)`。C、C++、Rust、Go、Python 逐行讀取，solver 額外空間為 `O(S_max)`，此處 `S_max <= 200`。Forge 的 JavaScript／TypeScript 輸入 API 只提供 immutable 完整字串 `readAsString()`，因此這兩語言必須保留 `O(T)` 的 host-provided input string；實作以 cursor 掃描而不建立全量 token array，額外狀態仍為 `O(S_max)`。256 MiB memory limit 包含這項 runtime/input contract 成本。

## 常見錯誤

- 把 `ceil(size/512)` 寫成 floor。
- metadata 自己被算成一般檔案，或沒有在下一筆 `F/D` 後清除。
- 先檢查種類才檢查 offset/checksum，造成錯誤碼不符。
- 使用 32-bit 整數，或在 JS/TS 使用 `number`。
