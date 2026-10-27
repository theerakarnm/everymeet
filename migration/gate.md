# Migration gate

Decision: GO: user decision, no measurable target.
Date: 2026-10-27.
User statement: "I just want to change to Rust."

Risks recorded at decision time:
- TypeScript on Node has no memory-unsafe code, so memory safety is not a gain.
- Opus decode costs 0.19% of one core per speaker (30,000 packets in 1,166 ms).
- The Rust port links libopus (C) and davey in-process.
- songbird issue 310 (DAVE receive stall) is open; Task 1 tests it.
