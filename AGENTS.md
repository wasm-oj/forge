# Project priorities

- Move fast: prefer the simplest deployable solution and short feedback loops.
- Reproducibility, audit depth, and operations hardening are not project goals by default.
- Timebox reviews and infrastructure work. Only block shipping for a concrete security, data-loss, or functional failure.
- Prefer small-team, best-effort, manual operations over elaborate release, backup, SLO, or approval machinery.
- Ship the minimal working path first; record optional hardening separately and do not implement it without an explicit request.
- 題庫／Organizer 的邊界只驗 schema、路徑、大小、digest 與可部署的 judge 格式；不編譯、執行或評價 reference solution 的正確性、效能或分數。
- OJ 的邊界是在使用者 Official Submit 時，依已發布的 immutable judge data 編譯、執行與計分使用者程式。
