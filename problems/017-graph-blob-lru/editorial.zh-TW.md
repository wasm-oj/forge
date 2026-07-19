# 解題說明

## 直覺解

用陣列保存 LRU，每次 touch 線性尋找/搬移；淘汰時再掃描全部 `N` 節點找引用者。最壞 `O(Q(N+D))`。

## 最佳解

digest ID 稠密，可用陣列保存 cached、LRU prev/next，以 head=LRU、tail=MRU 的雙向串列做到 `touch/insert/remove` 常數時間。

每個 node 只引用一個 digest；再為每個 digest 維護引用 node 的雙向串列。node 的 `refPrev/refNext` 足以在 reassign 時 `O(1)` detach。淘汰 digest 時沿它的引用串列逐一清空 node mapping。

雖然一次淘汰可能走很多 node，但每個被走訪的引用必由更早的一次 `P` attach 建立，且失效後不會再被走訪，除非另一次 `P` 重新建立。故所有淘汰走訪總數不超過 `Q`。

## 正確性證明

維護 invariant：（一）cached digest 恰各出現一次於 LRU，順序為最近成功 `P/HIT G` 的時間；（二）node mapping 與 digest 反向串列互相一致；（三）occupancy 是 cached digest size 的不重複總和。各個 detach/attach/touch helper 顯然保持對應 invariant。新 blob 加入後從 head 淘汰，故每次選到規格要求的 LRU；清空整條引用串列使且只使該 digest 的引用失效，減去一次 size 保持 occupancy。迴圈停止時 occupancy<=C。oversize 分支只做規定的 detach。歸納所有操作後 invariant 成立，因此每個 `G` 的 hit/miss、digest 與更新順序都正確。

## 複雜度

除淘汰引用外每操作 `O(1)`；每個引用在 attach 後至多被淘汰一次，總時間 `O(Q)` amortized，空間 `O(N+D)`。

## 常見錯誤

- 以 node 而非 blob 為 LRU 單位，破壞 digest 去重。
- reassign 時沒從舊 digest 的反向串列 detach。
- 無引用 blob 立刻刪除；規格要求它留在 cache。
- oversize `P` 忘記先清除舊引用。
